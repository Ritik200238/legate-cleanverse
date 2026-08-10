// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ComplianceGate} from "./ComplianceGate.sol";

/// @title LegateEscrow
/// @notice The payment lifecycle. Registered as a compliance pool against Cleanverse's real
///         IAPassComplianceValidator (via the REST /validator/register flow — see PRD.md
///         §5.1; this contract does not construct RuleV2 structs itself).
///         Accepts ONLY the A-Token (CVA) — no other asset. See PRD.md §5.1, §6 (Scenes 1-3).
/// @dev Inherits Ownable IN ADDITION TO AccessControl, discovered as a real, non-optional
///      requirement by an actual live attempt (not the docs' prose, which doesn't state this
///      explicitly): Cleanverse's POST /validator/grant and POST /validator/register both
///      verify the submitted owner_signature against the target/pool address's on-chain
///      Ownable.owner() — a contract using only AccessControl has no owner() function and
///      the call fails with "Invalid contract owner signature" (verified live 2026-08-08,
///      see DECISIONS.md). AccessControl is kept for the granular internal roles
///      (MONITOR_ROLE, CALLER_ROLE) that Ownable alone can't express.
contract LegateEscrow is AccessControl, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MONITOR_ROLE = keccak256("MONITOR_ROLE"); // granted to CVIRegistryMirror
    bytes32 public constant CALLER_ROLE = keccak256("CALLER_ROLE"); // granted to AgentMandate

    enum PaymentState {
        None,
        Escrowed,
        Settled,
        Frozen,
        Refunded
    }

    struct Payment {
        address sender;
        address recipient;
        uint256 amount;
        PaymentState state;
        uint64 createdAt;
        uint64 settledAt;
        /// @dev Once block.timestamp passes this, the SENDER (not just ADMIN_ROLE) may
        ///      reclaim an still-Escrowed payment themselves — see reclaimExpired(). Real
        ///      pilot-readiness gap this closes: before this field existed, a payment to a
        ///      recipient who simply never called settle() sat in escrow indefinitely with
        ///      no recourse except an admin manually freezing then refunding it.
        uint64 claimDeadline;
    }

    IERC20 public immutable aToken;
    ComplianceGate public complianceGate;
    address public feeAddress;
    /// @notice Fee in basis points (1 bps = 0.01%). Default 50 bps = 0.5%.
    uint256 public feeBps = 50;
    uint256 public constant MAX_FEE_BPS = 500; // hard cap: fee can never exceed 5%
    /// @notice How long a recipient has to settle() before the sender can reclaim unilaterally.
    uint64 public constant CLAIM_WINDOW = 30 days;

    mapping(bytes32 => Payment) public payments;
    /// @dev Monotonic nonce per sender, used to derive unique paymentIds.
    mapping(address => uint256) public nonces;
    /// @dev Sum of amounts held for Escrowed or Frozen payments — i.e. funds this contract
    ///      actually owes to someone. Tracked explicitly (the `payments` mapping isn't
    ///      enumerable on-chain) so sweepSurplus() can prove, not just claim, that it never
    ///      touches money owed to an open payment.
    uint256 public totalEscrowed;

    event PaymentEscrowed(bytes32 indexed paymentId, address indexed sender, address indexed recipient, uint256 amount);
    event PaymentSettled(bytes32 indexed paymentId, uint256 amountToRecipient, uint256 fee);
    event PaymentFrozen(bytes32 indexed paymentId, string reason);
    event PaymentRefunded(bytes32 indexed paymentId);
    event ComplianceGateUpdated(address indexed complianceGate);
    event FeeConfigUpdated(address indexed feeAddress, uint256 feeBps);

    error NotCompliantAtSettlement();
    error InvalidState(PaymentState expected, PaymentState actual);
    error ZeroAmount();
    error FeeTooHigh();
    error ZeroAddress();
    error NotPaymentSender();
    error ClaimWindowNotExpired(uint64 deadline);

    constructor(address aToken_, address admin_) Ownable(admin_) {
        if (aToken_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        aToken = IERC20(aToken_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    /// @notice Sender escrows `amount` of A-Token for `recipient`. Requires the sender to
    ///         have approved this contract for at least `amount` beforehand (standard
    ///         ERC-20 approve/transferFrom — not built here since approval is a wallet-side
    ///         action, not a Legate contract responsibility).
    function initiate(address recipient, uint256 amount) external nonReentrant returns (bytes32 paymentId) {
        if (amount == 0) revert ZeroAmount();

        // Compliance + corridor-limit check BEFORE any token movement. This call reverts
        // with a specific typed error (SenderNotCompliant / RecipientNotCompliant /
        // PerTxCapExceeded / DailyCorridorCapExceeded) if anything fails — nothing is
        // escrowed on a failed check. This is Demo Scene 2's "blocked before it exists."
        complianceGate.checkAndRecord(msg.sender, recipient, amount);

        paymentId = keccak256(abi.encodePacked(msg.sender, recipient, nonces[msg.sender]++, block.timestamp));

        payments[paymentId] = Payment({
            sender: msg.sender,
            recipient: recipient,
            amount: amount,
            state: PaymentState.Escrowed,
            createdAt: uint64(block.timestamp),
            settledAt: 0,
            claimDeadline: uint64(block.timestamp) + CLAIM_WINDOW
        });
        totalEscrowed += amount;

        // Effects (state written above) before interaction (external token pull) —
        // standard checks-effects-interactions.
        aToken.safeTransferFrom(msg.sender, address(this), amount);

        emit PaymentEscrowed(paymentId, msg.sender, recipient, amount);
    }

    /// @notice Releases escrowed funds to the recipient, minus the settlement fee. Re-checks
    ///         compliance immediately before releasing — this is the second, independent
    ///         enforcement point (the A-Token's own transfer hook is the first, since aToken
    ///         is Cleanverse's real compliance-gated token). If either party was revoked
    ///         between initiate() and settle(), this reverts here even if CVIRegistryMirror's
    ///         off-chain poller hasn't caught up yet — the on-chain check is the real safety
    ///         net, the poller is the demo's proactive-freeze timing device (see Scene 3).
    function settle(bytes32 paymentId) external nonReentrant {
        Payment storage p = payments[paymentId];
        if (p.state != PaymentState.Escrowed) revert InvalidState(PaymentState.Escrowed, p.state);
        if (!complianceGate.isCompliant(p.sender, p.recipient)) revert NotCompliantAtSettlement();

        uint256 amount = p.amount;
        // Fee is zero whenever no fee address is configured — not just "not forwarded": if
        // this were computed unconditionally as (amount * feeBps) / 10_000 and only the
        // *transfer* were skipped for a zero feeAddress, the fee portion would still be
        // deducted from toRecipient and left stranded in this contract's own balance
        // forever (no sweep path exists, or should exist, for a paying user's funds). The
        // recipient always receives 100% until a real fee address is actually set.
        uint256 fee = feeAddress != address(0) ? (amount * feeBps) / 10_000 : 0;
        uint256 toRecipient = amount - fee;

        // Effects before interactions.
        p.state = PaymentState.Settled;
        p.settledAt = uint64(block.timestamp);
        totalEscrowed -= amount;

        aToken.safeTransfer(p.recipient, toRecipient);
        if (fee > 0) {
            aToken.safeTransfer(feeAddress, fee);
        }

        emit PaymentSettled(paymentId, toRecipient, fee);
    }

    /// @notice Called only by CVIRegistryMirror (which holds MONITOR_ROLE) when its poller
    ///         detects a revocation affecting this payment's sender or recipient. Returns
    ///         false (does not revert) if the payment isn't in a freezable state, so a batch
    ///         call across multiple payments in CVIRegistryMirror.reportRevocation() doesn't
    ///         abort on one already-settled payment.
    function freezeByMirror(bytes32 paymentId) external onlyRole(MONITOR_ROLE) returns (bool) {
        Payment storage p = payments[paymentId];
        if (p.state != PaymentState.Escrowed) return false;
        p.state = PaymentState.Frozen;
        emit PaymentFrozen(paymentId, "revocation");
        return true;
    }

    /// @notice Also allows a direct admin freeze (compliance review flow, not tied to a
    ///         mirror-reported revocation — e.g. a manual sanctions hit or dispute).
    function freeze(bytes32 paymentId, string calldata reason) external onlyRole(ADMIN_ROLE) {
        Payment storage p = payments[paymentId];
        if (p.state != PaymentState.Escrowed) revert InvalidState(PaymentState.Escrowed, p.state);
        p.state = PaymentState.Frozen;
        emit PaymentFrozen(paymentId, reason);
    }

    /// @notice Refunds a frozen payment back to its original sender — clean-money return,
    ///         full provenance intact, no fee taken on a refund.
    function refundFrozen(bytes32 paymentId) external onlyRole(ADMIN_ROLE) nonReentrant {
        Payment storage p = payments[paymentId];
        if (p.state != PaymentState.Frozen) revert InvalidState(PaymentState.Frozen, p.state);

        p.state = PaymentState.Refunded;
        totalEscrowed -= p.amount;
        aToken.safeTransfer(p.sender, p.amount);

        emit PaymentRefunded(paymentId);
    }

    /// @notice Self-service recovery: if a recipient never calls settle() within
    ///         CLAIM_WINDOW of initiate(), the ORIGINAL SENDER (not just ADMIN_ROLE) can
    ///         reclaim their own escrowed funds unilaterally — no admin intervention needed.
    ///         Real pilot-readiness gap this closes, not present in earlier drafts: a stuck
    ///         payment used to have no recourse except an admin manually freezing then
    ///         refunding it. Deliberately sender-only (not recipient, not "anyone") — the
    ///         sender is the party whose funds are actually at stake here.
    /// @dev    The deadline is a FLOOR on the sender's right, not an expiry of the
    ///         recipient's: settle() deliberately has no deadline check, so a late recipient
    ///         can still claim right up until the sender actually reclaims. Making the window
    ///         cut both ways would strand funds permanently whenever neither party acts.
    ///         Past the deadline the two calls race, which is benign — the money reaches one
    ///         of the two legitimate parties either way, and the loser gets a clear
    ///         InvalidState revert rather than a silent failure.
    function reclaimExpired(bytes32 paymentId) external nonReentrant {
        Payment storage p = payments[paymentId];
        if (p.state != PaymentState.Escrowed) revert InvalidState(PaymentState.Escrowed, p.state);
        if (msg.sender != p.sender) revert NotPaymentSender();
        if (block.timestamp < p.claimDeadline) revert ClaimWindowNotExpired(p.claimDeadline);

        p.state = PaymentState.Refunded;
        totalEscrowed -= p.amount;
        aToken.safeTransfer(p.sender, p.amount);

        emit PaymentRefunded(paymentId);
    }

    /// @notice Entry point used by AgentMandate.execute() after its own cap/compliance
    ///         checks pass — mirrors initiate()+settle() as one atomic call for the
    ///         agent-payment path (Scene 4), since agent payments don't sit in escrow
    ///         awaiting a separate claim step the way human remittances do.
    /// @dev    `sender` looks arbitrary to static analysis (a static-analysis pass will flag
    ///         `safeTransferFrom` here as arbitrary-send-erc20) but is not, in practice:
    ///         CALLER_ROLE is granted exclusively to whatever address setMandate() (admin-only)
    ///         names, i.e. AgentMandate, and that contract's own execute() only ever passes
    ///         `mandates[msg.sender].principal` — the specific principal that specific calling
    ///         agent already holds a validly-created mandate for, itself gated on that
    ///         principal's A-Pass and their own approve() to this contract. Not arbitrary; the
    ///         trust boundary is cross-contract and the tool can't see it, so it's recorded
    ///         here instead of silently suppressed.
    function settleFromMandate(address sender, address recipient, uint256 amount)
        external
        onlyRole(CALLER_ROLE)
        nonReentrant
        returns (bytes32 paymentId)
    {
        if (amount == 0) revert ZeroAmount();
        complianceGate.checkAndRecord(sender, recipient, amount);

        paymentId = keccak256(abi.encodePacked(sender, recipient, nonces[sender]++, block.timestamp));
        // Same rule as settle(): fee is zero whenever no fee address is configured — here it
        // was already correctly skipped as a *transfer*, but toRecipient must be computed
        // consistently too, or the sender is charged a fee that's simply never collected.
        uint256 fee = feeAddress != address(0) ? (amount * feeBps) / 10_000 : 0;
        uint256 toRecipient = amount - fee;

        payments[paymentId] = Payment({
            sender: sender,
            recipient: recipient,
            amount: amount,
            state: PaymentState.Settled,
            createdAt: uint64(block.timestamp),
            settledAt: uint64(block.timestamp),
            claimDeadline: 0 // irrelevant — this payment is already Settled, never Escrowed
        });

        aToken.safeTransferFrom(sender, recipient, toRecipient);
        if (fee > 0) {
            aToken.safeTransferFrom(sender, feeAddress, fee);
        }

        emit PaymentEscrowed(paymentId, sender, recipient, amount);
        emit PaymentSettled(paymentId, toRecipient, fee);
    }

    // --- Admin configuration ---

    /// @notice Points this escrow at the ComplianceGate that gates every initiate/settle call.
    function setComplianceGate(address gate) external onlyRole(ADMIN_ROLE) {
        if (gate == address(0)) revert ZeroAddress();
        complianceGate = ComplianceGate(gate);
        emit ComplianceGateUpdated(gate);
    }

    /// @notice Grants MONITOR_ROLE to the CVIRegistryMirror instance, letting it call
    ///         `freezeByMirror` when a party's A-Pass is reported revoked.
    function setMirror(address mirror) external onlyRole(ADMIN_ROLE) {
        if (mirror == address(0)) revert ZeroAddress();
        _grantRole(MONITOR_ROLE, mirror);
    }

    /// @notice Grants CALLER_ROLE to the AgentMandate instance, letting it call
    ///         `settleFromMandate` on behalf of an agent's spend.
    function setMandate(address mandate) external onlyRole(ADMIN_ROLE) {
        if (mandate == address(0)) revert ZeroAddress();
        _grantRole(CALLER_ROLE, mandate);
    }

    error InsufficientSurplus(uint256 requested, uint256 available);

    /// @notice Sweeps A-Token balance not owed to any open Escrowed/Frozen payment — e.g. a
    ///         stray direct transfer to this contract (operator error). Provably safe, not
    ///         just claimed safe: `totalEscrowed` is real accounting maintained by every
    ///         function that escrows or releases funds, and this reverts rather than letting
    ///         `amount` dip into it. Callable only by ADMIN_ROLE.
    function sweepSurplus(address to, uint256 amount) external onlyRole(ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        uint256 surplus = aToken.balanceOf(address(this)) - totalEscrowed;
        if (amount > surplus) revert InsufficientSurplus(amount, surplus);
        aToken.safeTransfer(to, amount);
    }

    /// @dev No zero-address guard on `feeAddress_`, unlike every other admin setter in this
    ///      contract — deliberately. `address(0)` is the sentinel this contract already treats
    ///      as "fees disabled" everywhere a fee is computed (see settle()/settleFromMandate()'s
    ///      `feeAddress != address(0) ? ... : 0`), matching the pre-configuration default state.
    ///      Rejecting it here would remove the admin's only way to turn fee collection back off
    ///      after having turned it on. A static-analysis pass will flag this as
    ///      missing-zero-check; it is a false positive for this specific field, recorded here
    ///      rather than silently suppressed so the next reader isn't left wondering either.
    function setFeeConfig(address feeAddress_, uint256 feeBps_) external onlyRole(ADMIN_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeAddress = feeAddress_;
        feeBps = feeBps_;
        emit FeeConfigUpdated(feeAddress_, feeBps_);
    }

    /// @notice Full payment record — used by the backend/frontend (Auditor, receipt permalink)
    ///         to render state without needing per-field getters.
    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return payments[paymentId];
    }
}
