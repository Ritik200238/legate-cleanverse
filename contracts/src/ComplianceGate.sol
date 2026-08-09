// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAPassComplianceValidator} from "./interfaces/IAPassComplianceValidator.sol";
import {IComplianceRule} from "./interfaces/IComplianceRule.sol";

/// @title ComplianceGate
/// @notice The guard every payment passes through. Three layers, each owned by whoever is
///         actually accountable for it:
///
///           1. Cleanverse's validator  — WHO is this? (identity, tier, sanctions)
///           2. This contract           — HOW MUCH, HOW OFTEN? (per-tx and corridor caps)
///           3. Registered rule modules — WHATEVER THE OPERATOR'S LICENCE DEMANDS
///
///         Layer 3 is the part Legate deliberately does not own. A licensed remittance
///         operator has obligations no protocol author can enumerate in advance, so rather
///         than guess at them (and be wrong) or hardcode one jurisdiction's rules (and be
///         useless everywhere else), the gate exposes `IComplianceRule` and lets the operator
///         register their own. No fork of the escrow, no upgrade here, no re-audit of layers
///         1 and 2.
///
///         Structurally this is Safe's guard: it cannot initiate anything, only refuse.
///         `AgentMandate` is the matching module — it initiates, holding no keys of its own.
///         See PRD.md §5.1.
contract ComplianceGate is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant CALLER_ROLE = keccak256("CALLER_ROLE"); // granted to LegateEscrow, AgentMandate

    /// @notice Hard ceiling on registered rules. Every payment iterates this list, so an
    ///         unbounded array is a gas-exhaustion denial-of-service on the whole corridor —
    ///         an admin (or a compromised admin key) could append rules until `initiate`
    ///         no longer fits in a block. Eight is well past any plausible real policy stack.
    uint256 public constant MAX_RULES = 8;

    IAPassComplianceValidator public immutable validator;
    address public immutable pool;

    /// @notice Operator-supplied policy modules, consulted on every payment. Order is not
    ///         significant — a veto from any one of them blocks, so this is a conjunction.
    IComplianceRule[] private _rules;

    /// @notice Per-transaction cap, in A-Token base units.
    uint256 public perTxCap;
    /// @notice Daily corridor-wide velocity cap, in A-Token base units.
    uint256 public dailyCorridorCap;
    /// @notice Volume moved through the corridor in the current UTC day window.
    uint256 public spentToday;
    /// @notice Unix timestamp (start of day, UTC) the current spentToday window began.
    uint64 public dayWindowStart;

    error PerTxCapExceeded(uint256 amount, uint256 cap);
    error DailyCorridorCapExceeded(uint256 amount, uint256 remaining);
    error RecipientNotCompliant(address recipient);
    error SenderNotCompliant(address sender);
    error ZeroAddress();
    /// @notice A registered operator rule vetoed this payment. Carries both the rule's address
    ///         and its own reason code so a refusal is traceable to the exact policy that
    ///         produced it — "declined" with no attribution is useless to a compliance officer.
    error RuleRejected(address rule, bytes32 reason);
    error TooManyRules(uint256 max);
    error RuleAlreadyRegistered(address rule);
    error RuleNotRegistered(address rule);

    event LimitsUpdated(uint256 perTxCap, uint256 dailyCorridorCap);
    event CorridorVolumeReset(uint64 newWindowStart);
    event RuleRegistered(address indexed rule, string name);
    event RuleUnregistered(address indexed rule);

    constructor(address validator_, address pool_, address admin_, uint256 perTxCap_, uint256 dailyCorridorCap_) {
        if (validator_ == address(0) || pool_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        validator = IAPassComplianceValidator(validator_);
        pool = pool_;
        perTxCap = perTxCap_;
        dailyCorridorCap = dailyCorridorCap_;
        dayWindowStart = _dayStart(uint64(block.timestamp));
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    /// @notice Checks a payment against both Cleanverse's real validator AND Legate's own
    ///         dynamic corridor rules, then records the volume if allowed. Reverts on any
    ///         failure with a specific typed error so callers (and x402, §5.3) can surface
    ///         a machine-readable reason.
    function checkAndRecord(address sender, address recipient, uint256 amount) external onlyRole(CALLER_ROLE) {
        if (!validator.complianceVerify(pool, sender)) revert SenderNotCompliant(sender);
        if (!validator.complianceVerify(pool, recipient)) revert RecipientNotCompliant(recipient);
        if (amount > perTxCap) revert PerTxCapExceeded(amount, perTxCap);

        _rollWindowIfNeeded();
        if (spentToday + amount > dailyCorridorCap) {
            // Clamp rather than subtract directly: an admin can lower dailyCorridorCap below
            // spentToday via setLimits() (no floor validation there, deliberately — a
            // corridor-wide emergency cap cut shouldn't be blocked by today's already-spent
            // volume), and dailyCorridorCap - spentToday would then underflow into a raw
            // Panic(0x11) instead of this typed error, breaking the guarantee that every
            // refusal is machine-decodable (see chain/contracts.ts's refusal-reason mapping).
            uint256 remaining = dailyCorridorCap > spentToday ? dailyCorridorCap - spentToday : 0;
            revert DailyCorridorCapExceeded(amount, remaining);
        }

        // Layer 3 last, and in two passes on purpose. Every rule must approve before any rule
        // is told the payment happened — otherwise a rule that rejects would still have had
        // its `record` called by an earlier iteration, and a blocked payment would silently
        // consume a legitimate one's velocity budget.
        uint256 count = _rules.length;
        for (uint256 i = 0; i < count; ++i) {
            (bool allowed, bytes32 reason) = _rules[i].check(sender, recipient, amount);
            if (!allowed) revert RuleRejected(address(_rules[i]), reason);
        }

        spentToday += amount;

        for (uint256 i = 0; i < count; ++i) {
            _rules[i].record(sender, recipient, amount);
        }
    }

    /// @notice Register an operator policy module. Admin-only: this is the one call that can
    ///         change what the corridor refuses, so it carries the same authority as changing
    ///         the caps themselves.
    /// @dev    Deliberately does NOT validate the rule's behaviour. A rule that always reverts
    ///         halts the corridor — that is a real risk, and it is the operator's risk to
    ///         manage, exactly as a Safe owner adding a malicious guard bricks their own Safe.
    ///         `unregisterRule` is the escape hatch and is why registration is reversible.
    function registerRule(IComplianceRule rule) external onlyRole(ADMIN_ROLE) {
        if (address(rule) == address(0)) revert ZeroAddress();
        if (_rules.length >= MAX_RULES) revert TooManyRules(MAX_RULES);
        for (uint256 i = 0; i < _rules.length; ++i) {
            if (address(_rules[i]) == address(rule)) revert RuleAlreadyRegistered(address(rule));
        }
        _rules.push(rule);
        emit RuleRegistered(address(rule), rule.name());
    }

    /// @notice Remove a policy module. Swap-and-pop: rule order carries no meaning (the check
    ///         is a conjunction), so preserving it would cost gas for nothing.
    function unregisterRule(IComplianceRule rule) external onlyRole(ADMIN_ROLE) {
        uint256 count = _rules.length;
        for (uint256 i = 0; i < count; ++i) {
            if (address(_rules[i]) == address(rule)) {
                _rules[i] = _rules[count - 1];
                _rules.pop();
                emit RuleUnregistered(address(rule));
                return;
            }
        }
        revert RuleNotRegistered(address(rule));
    }

    /// @notice Every registered rule, for the Auditor view and for anyone verifying what this
    ///         corridor actually enforces without trusting a README to be current.
    function rules() external view returns (IComplianceRule[] memory) {
        return _rules;
    }

    function ruleCount() external view returns (uint256) {
        return _rules.length;
    }

    /// @notice Gas-free preview of the full three-layer decision, including operator rules.
    ///         The backend's policy engine and the web app's compliance preview use this so a
    ///         user learns about a rule veto before paying gas, not after.
    /// @dev    Returns rather than reverts — a preview that reverts cannot report *which*
    ///         layer refused, and the whole point of a preview is to say why.
    function previewCheck(address sender, address recipient, uint256 amount)
        external
        view
        returns (bool allowed, address rejectingRule, bytes32 reason)
    {
        if (!validator.complianceVerify(pool, sender)) return (false, address(0), "SENDER_NOT_COMPLIANT");
        if (!validator.complianceVerify(pool, recipient)) return (false, address(0), "RECIPIENT_NOT_COMPLIANT");
        if (amount > perTxCap) return (false, address(0), "PER_TX_CAP_EXCEEDED");

        uint256 effectiveSpent = _dayStart(uint64(block.timestamp)) != dayWindowStart ? 0 : spentToday;
        if (effectiveSpent + amount > dailyCorridorCap) return (false, address(0), "DAILY_CAP_EXCEEDED");

        uint256 count = _rules.length;
        for (uint256 i = 0; i < count; ++i) {
            (bool ok, bytes32 ruleReason) = _rules[i].check(sender, recipient, amount);
            if (!ok) return (false, address(_rules[i]), ruleReason);
        }
        return (true, address(0), bytes32(0));
    }

    /// @notice Read-only preview of checkAndRecord's identity/tier checks — used by
    ///         LegateEscrow.settle() to re-verify compliance right before releasing funds,
    ///         without double-counting corridor volume (already recorded at initiate time).
    function isCompliant(address sender, address recipient) external view returns (bool) {
        return validator.complianceVerify(pool, sender) && validator.complianceVerify(pool, recipient);
    }

    function setLimits(uint256 perTxCap_, uint256 dailyCorridorCap_) external onlyRole(ADMIN_ROLE) {
        perTxCap = perTxCap_;
        dailyCorridorCap = dailyCorridorCap_;
        emit LimitsUpdated(perTxCap_, dailyCorridorCap_);
    }

    function grantCaller(address caller) external onlyRole(ADMIN_ROLE) {
        _grantRole(CALLER_ROLE, caller);
    }

    function _rollWindowIfNeeded() internal {
        uint64 currentDayStart = _dayStart(uint64(block.timestamp));
        if (currentDayStart != dayWindowStart) {
            dayWindowStart = currentDayStart;
            spentToday = 0;
            emit CorridorVolumeReset(currentDayStart);
        }
    }

    function _dayStart(uint64 timestamp) internal pure returns (uint64) {
        return (timestamp / 1 days) * 1 days;
    }
}
