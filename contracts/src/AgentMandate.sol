// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAPassComplianceValidator} from "./interfaces/IAPassComplianceValidator.sol";
import {LegateEscrow} from "./LegateEscrow.sol";

/// @title AgentMandate
/// @notice Programmable spend mandates for AI agents acting on behalf of a verified
///         principal. Confirmed absent from Cleanverse's API entirely (zero mentions of
///         "agent," "mandate," or "spend control" anywhere in the 3577-line API reference,
///         see DECISIONS.md) — this is not a fallback, it IS the plan: the reference
///         implementation of a capability Cleanverse doesn't provide. See PRD.md §5.1, §6
///         (Scene 4), REQ.md capability #8.
///
/// @dev    Structurally this is Safe's **module**, and `ComplianceGate` is the matching
///         **guard**. The distinction is the whole architecture and it is worth naming
///         explicitly, because it is the pattern that has already been proven at scale — Safe
///         secured ~$27B across ~130M transactions in Q2 2026 on exactly this split:
///
///           module (this contract) — CAN INITIATE a payment without holding the principal's
///                                    key, bounded by caps that live in storage here
///           guard  (ComplianceGate) — CANNOT initiate anything, only refuse
///
///         An agent needs both halves and neither alone is sufficient. A module without a
///         guard is an unbounded bot; a guard without a module means the human still has to
///         sign every payment, which defeats the point of an agent. The reason this beats a
///         prompt-level spending limit is not that the code is better — it is that the agent
///         never holds the key and cannot reach the ledger except through a contract that
///         counts.
contract AgentMandate is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MONITOR_ROLE = keccak256("MONITOR_ROLE"); // granted to CVIRegistryMirror

    struct Mandate {
        address principal;
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 totalCap;
        uint256 spentToday;
        uint256 spentTotal;
        uint64 dayWindowStart;
        uint64 expiry;
        bool active;
    }

    IAPassComplianceValidator public immutable validator;
    address public immutable pool;
    LegateEscrow public immutable escrow;

    /// @dev keyed by agent wallet address — one active mandate per agent.
    mapping(address => Mandate) public mandates;

    event MandateCreated(address indexed agent, address indexed principal, uint256 perTxCap, uint256 dailyCap, uint256 totalCap, uint64 expiry);
    event MandateRevokedEvt(address indexed agent, address indexed principal);
    event MandateSuspended(address indexed agent);
    event MandateExecuted(address indexed agent, address indexed recipient, uint256 amount, bytes32 paymentId);

    error PrincipalNotCompliant(address principal);
    error MandateNotActive();
    error MandateHasExpired();
    error PerTxCapExceeded(uint256 amount, uint256 cap);
    error DailyCapExceeded(uint256 amount, uint256 remaining);
    error TotalCapExceeded(uint256 amount, uint256 remaining);
    error RecipientNotCompliant(address recipient);
    error NotMandatePrincipal();
    error ZeroAddress();
    error ExpiryInPast();
    /// @dev Thrown when someone tries to overwrite another principal's still-live mandate
    ///      for `agent` — see the mandate-hijacking fix below. `mandates` is keyed only by
    ///      agent address; without this check, any compliant caller could silently reassign
    ///      another principal's mandate slot to themselves, both stealing the agent's spend
    ///      authority going forward and breaking the original principal's `revokeMandate()`
    ///      (its `principal != msg.sender` check would now fail for the true owner).
    error AgentAlreadyMandated(address agent, address currentPrincipal);

    constructor(address validator_, address pool_, address escrow_, address admin_) {
        if (validator_ == address(0) || pool_ == address(0) || escrow_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        validator = IAPassComplianceValidator(validator_);
        pool = pool_;
        escrow = LegateEscrow(escrow_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    /// @notice Principal (msg.sender) creates a mandate authorizing `agent` to spend on
    ///         their behalf, within the given caps. Principal must be A-Pass-verified.
    ///         Reverts if `agent` already has a live mandate (active and unexpired) owned by
    ///         a different principal — a principal may freely re-create/update their own
    ///         mandate for an agent, and any principal may claim an agent slot whose prior
    ///         mandate has been revoked or has expired, but no one may hijack a live one.
    function createMandate(address agent, uint256 perTxCap, uint256 dailyCap, uint256 totalCap, uint64 expiry)
        external
    {
        if (!validator.complianceVerify(pool, msg.sender)) revert PrincipalNotCompliant(msg.sender);
        if (agent == address(0)) revert ZeroAddress();
        if (expiry <= block.timestamp) revert ExpiryInPast();

        Mandate storage existing = mandates[agent];
        bool slotIsLive = existing.active && block.timestamp < existing.expiry;
        if (slotIsLive && existing.principal != msg.sender) {
            revert AgentAlreadyMandated(agent, existing.principal);
        }

        mandates[agent] = Mandate({
            principal: msg.sender,
            perTxCap: perTxCap,
            dailyCap: dailyCap,
            totalCap: totalCap,
            spentToday: 0,
            spentTotal: 0,
            dayWindowStart: _dayStart(uint64(block.timestamp)),
            expiry: expiry,
            active: true
        });

        emit MandateCreated(agent, msg.sender, perTxCap, dailyCap, totalCap, expiry);
    }

    /// @notice Executes an agent-initiated payment against the caller's own mandate.
    ///         msg.sender is the agent wallet. Checks (in order): mandate active, not
    ///         expired, per-tx/daily/lifetime caps, principal still compliant (re-checked —
    ///         a mandate doesn't survive the principal's A-Pass being revoked), recipient
    ///         compliant. Any failure reverts with a specific typed error, surfaced by the
    ///         x402 middleware (§5.3) as a structured 403 refusal. This is Demo Scene 4's
    ///         blocked transactions (#6 cap-exceeded, #7 recipient-not-compliant).
    function execute(address recipient, uint256 amount) external returns (bytes32 paymentId) {
        Mandate storage m = mandates[msg.sender];
        if (!m.active) revert MandateNotActive();
        if (block.timestamp >= m.expiry) revert MandateHasExpired();
        if (!validator.complianceVerify(pool, m.principal)) revert PrincipalNotCompliant(m.principal);
        if (!validator.complianceVerify(pool, recipient)) revert RecipientNotCompliant(recipient);

        if (amount > m.perTxCap) revert PerTxCapExceeded(amount, m.perTxCap);

        uint64 currentDayStart = _dayStart(uint64(block.timestamp));
        if (currentDayStart != m.dayWindowStart) {
            m.dayWindowStart = currentDayStart;
            m.spentToday = 0;
        }
        if (m.spentToday + amount > m.dailyCap) {
            revert DailyCapExceeded(amount, m.dailyCap > m.spentToday ? m.dailyCap - m.spentToday : 0);
        }
        if (m.spentTotal + amount > m.totalCap) {
            revert TotalCapExceeded(amount, m.totalCap > m.spentTotal ? m.totalCap - m.spentTotal : 0);
        }

        // Effects before the external call into Escrow.
        m.spentToday += amount;
        m.spentTotal += amount;

        paymentId = escrow.settleFromMandate(m.principal, recipient, amount);
        emit MandateExecuted(msg.sender, recipient, amount, paymentId);
    }

    /// @notice Principal revokes their own agent's mandate instantly.
    function revokeMandate(address agent) external {
        Mandate storage m = mandates[agent];
        if (m.principal != msg.sender) revert NotMandatePrincipal();
        m.active = false;
        emit MandateRevokedEvt(agent, msg.sender);
    }

    /// @notice Called only by CVIRegistryMirror when the principal's A-Pass is revoked —
    ///         auto-suspends the mandate without waiting for the principal to act. Returns
    ///         false instead of reverting if the mandate is already inactive, so a batch
    ///         call across multiple agents doesn't abort on one already-suspended mandate.
    function suspendByMirror(address agent) external onlyRole(MONITOR_ROLE) returns (bool) {
        Mandate storage m = mandates[agent];
        if (!m.active) return false;
        m.active = false;
        emit MandateSuspended(agent);
        return true;
    }

    function setMirror(address mirror) external onlyRole(ADMIN_ROLE) {
        if (mirror == address(0)) revert ZeroAddress();
        _grantRole(MONITOR_ROLE, mirror);
    }

    function getMandate(address agent) external view returns (Mandate memory) {
        return mandates[agent];
    }

    function _dayStart(uint64 timestamp) internal pure returns (uint64) {
        return (timestamp / 1 days) * 1 days;
    }
}
