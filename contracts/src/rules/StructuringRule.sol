// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IComplianceRule} from "../interfaces/IComplianceRule.sol";

/// @title StructuringRule
/// @notice Detects structuring — the practice of splitting one large transfer into many
///         smaller ones to stay under a reporting threshold. Known in the trade as smurfing,
///         and the single most common way a remittance corridor gets used for laundering.
///
///         This rule exists to demonstrate something specific: it is a policy that **neither**
///         of the other two compliance layers can express, which is the entire argument for
///         `IComplianceRule` existing at all.
///
///         - Cleanverse's `RuleV2` is static. It answers "is this counterparty permitted",
///           which is a property of the parties, not of a *pattern across time*.
///         - `ComplianceGate`'s own caps are corridor-wide aggregates. A pair of wallets
///           moving 20 × 500 aUSDC never trips a 10,000 per-transaction cap and barely
///           registers against a 1,000,000 daily corridor cap — that is exactly why
///           structuring works against threshold-based controls.
///
///         Catching it requires per-counterparty-pair state over a rolling window, which is
///         to say: it requires somewhere to put operator-specific logic. That place is here.
///
/// @dev    Thresholds are immutable and set at deployment. An operator whose obligations
///         change deploys a new rule and swaps it in via
///         `ComplianceGate.unregisterRule` / `registerRule` — a mutable-threshold rule would
///         mean the corridor's actual policy could change without any on-chain trace of the
///         swap, which defeats the audit trail this whole system exists to produce.
contract StructuringRule is IComplianceRule {
    /// @notice The gate permitted to call `record`. Immutable and single: an unrestricted
    ///         `record` would let anyone inflate a pair's counters and deny service to a
    ///         legitimate sender, which turns a compliance control into an attack surface.
    address public immutable gate;

    /// @notice Rolling window over which transfers between a pair are correlated.
    uint64 public immutable windowSeconds;
    /// @notice Number of transfers within the window that makes a pattern worth flagging.
    uint256 public immutable maxTransfersPerWindow;
    /// @notice Cumulative value within the window that makes the pattern material.
    uint256 public immutable aggregateThreshold;

    struct PairActivity {
        uint64 windowStart;
        uint256 transfers;
        uint256 volume;
    }

    /// @dev Keyed by hash(sender, recipient) — directional on purpose. A pays B twenty times
    ///      is a structuring pattern; A and B paying each other back and forth is ordinary
    ///      two-way settlement, and collapsing the two would generate false positives on
    ///      exactly the merchant flows this corridor is meant to serve.
    mapping(bytes32 => PairActivity) private _activity;

    error NotGate();
    error ZeroAddress();
    error InvalidThreshold();

    constructor(
        address gate_,
        uint64 windowSeconds_,
        uint256 maxTransfersPerWindow_,
        uint256 aggregateThreshold_
    ) {
        if (gate_ == address(0)) revert ZeroAddress();
        // A zero window or zero transfer allowance would reject every payment unconditionally,
        // bricking the corridor the moment this rule is registered. Fail at deploy, loudly,
        // rather than at the first real payment.
        if (windowSeconds_ == 0 || maxTransfersPerWindow_ == 0 || aggregateThreshold_ == 0) {
            revert InvalidThreshold();
        }
        gate = gate_;
        windowSeconds = windowSeconds_;
        maxTransfersPerWindow = maxTransfersPerWindow_;
        aggregateThreshold = aggregateThreshold_;
    }

    /// @inheritdoc IComplianceRule
    /// @dev The conjunction is what makes this a structuring detector rather than a blunt rate
    ///      limiter. Many small payments are normal (payroll, subscriptions). A large total is
    ///      normal (one big remittance). Many small payments that *sum* to a large total,
    ///      between the same two parties, inside one window — that is the pattern with no
    ///      innocent explanation, and requiring both conditions is what keeps a family sending
    ///      weekly grocery money from being flagged.
    function check(address sender, address recipient, uint256 amount)
        external
        view
        returns (bool allowed, bytes32 reason)
    {
        PairActivity memory a = _activity[_key(sender, recipient)];

        // An elapsed window is already-forgotten history; evaluate as if fresh.
        if (block.timestamp >= a.windowStart + windowSeconds) {
            return (true, bytes32(0));
        }

        uint256 projectedTransfers = a.transfers + 1;
        uint256 projectedVolume = a.volume + amount;

        if (projectedTransfers > maxTransfersPerWindow && projectedVolume >= aggregateThreshold) {
            return (false, "STRUCTURING_SUSPECTED");
        }
        return (true, bytes32(0));
    }

    /// @inheritdoc IComplianceRule
    function record(address sender, address recipient, uint256 amount) external {
        if (msg.sender != gate) revert NotGate();

        bytes32 key = _key(sender, recipient);
        PairActivity storage a = _activity[key];

        if (block.timestamp >= a.windowStart + windowSeconds) {
            a.windowStart = uint64(block.timestamp);
            a.transfers = 1;
            a.volume = amount;
        } else {
            a.transfers += 1;
            a.volume += amount;
        }
    }

    /// @inheritdoc IComplianceRule
    function name() external pure returns (string memory) {
        return "Structuring / smurfing detection (per counterparty pair)";
    }

    /// @notice Current window state for a pair — for the Auditor view, and so an operator can
    ///         explain a refusal to the customer who triggered it.
    function activityFor(address sender, address recipient)
        external
        view
        returns (uint64 windowStart, uint256 transfers, uint256 volume)
    {
        PairActivity memory a = _activity[_key(sender, recipient)];
        if (block.timestamp >= a.windowStart + windowSeconds) return (0, 0, 0);
        return (a.windowStart, a.transfers, a.volume);
    }

    function _key(address sender, address recipient) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(sender, recipient));
    }
}
