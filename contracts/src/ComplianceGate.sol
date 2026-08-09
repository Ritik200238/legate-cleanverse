// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAPassComplianceValidator} from "./interfaces/IAPassComplianceValidator.sol";

/// @title ComplianceGate
/// @notice Thin wrapper around Cleanverse's real on-chain compliance validator, plus the
///         dynamic checks (per-tx cap, daily corridor velocity cap) that a static RuleV2
///         cannot express. Division of labor: Cleanverse verifies WHO (identity/tier/group),
///         Legate governs HOW MUCH and WHEN. See PRD.md §5.1.
contract ComplianceGate is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant CALLER_ROLE = keccak256("CALLER_ROLE"); // granted to LegateEscrow, AgentMandate

    IAPassComplianceValidator public immutable validator;
    address public immutable pool;

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

    event LimitsUpdated(uint256 perTxCap, uint256 dailyCorridorCap);
    event CorridorVolumeReset(uint64 newWindowStart);

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
        spentToday += amount;
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
