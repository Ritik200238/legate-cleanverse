// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {LegateEscrow} from "./LegateEscrow.sol";

/// @title TravelRuleAnchor
/// @notice Privacy-safe compliance proof. Anchors a hash of Cleanverse's real
///         `download_travel_rule` report (downloadUrl + fileName), never the report or any
///         identity data itself. On-chain: proof a real compliance report was generated and
///         retrieved for this payment. Off-chain: the report itself, fetched from Cleanverse
///         by authorized parties. See PRD.md §3's privacy-design note.
/// @dev The single canonical anchor point for a payment's travel-rule proof — LegateEscrow
///      does not keep its own separate copy (an earlier version did; removed because two
///      disconnected, unverifiable stores of the same fact is a real data-integrity gap, not
///      just duplication: nothing checked that the two agreed, or that a stored hash even
///      corresponded to a real, settled payment). This contract now holds a reference to the
///      real LegateEscrow deployment specifically so anchor() can check that itself, instead
///      of trusting the caller to have gotten the paymentId/state right.
contract TravelRuleAnchor is AccessControl {
    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");

    LegateEscrow public immutable escrow;

    struct Anchor {
        bytes32 reportHash;
        bytes32 settlementTxHash;
        uint64 anchoredAt;
    }

    mapping(bytes32 => Anchor) public anchors; // keyed by paymentId

    event ReportAnchored(bytes32 indexed paymentId, bytes32 reportHash, bytes32 settlementTxHash);

    error AlreadyAnchored(bytes32 paymentId);
    error PaymentNotSettled(bytes32 paymentId);
    error ZeroAddress();

    constructor(address escrow_, address admin_) {
        if (escrow_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        escrow = LegateEscrow(escrow_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ANCHOR_ROLE, admin_);
    }

    /// @param reportHash keccak256 of the real download_travel_rule response
    ///        (downloadUrl + fileName), computed off-chain by the backend after retrieving
    ///        the actual PDF link from Cleanverse. Never the report contents or any
    ///        underlying identity data.
    function anchor(bytes32 paymentId, bytes32 reportHash, bytes32 settlementTxHash) external onlyRole(ANCHOR_ROLE) {
        if (anchors[paymentId].anchoredAt != 0) revert AlreadyAnchored(paymentId);
        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        if (p.state != LegateEscrow.PaymentState.Settled) revert PaymentNotSettled(paymentId);
        anchors[paymentId] = Anchor({reportHash: reportHash, settlementTxHash: settlementTxHash, anchoredAt: uint64(block.timestamp)});
        emit ReportAnchored(paymentId, reportHash, settlementTxHash);
    }

    /// @notice The anchored Travel Rule proof for a payment, if any — zero `anchoredAt` means
    ///         not yet anchored. Used by the Auditor view and the receipt permalink.
    function getAnchor(bytes32 paymentId) external view returns (Anchor memory) {
        return anchors[paymentId];
    }

    /// @notice Grants ANCHOR_ROLE — the backend's dedicated signer holds this, no user ever
    ///         does. See `anchor()`'s own doc for why this stays server-only by design.
    function grantAnchor(address who) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(ANCHOR_ROLE, who);
    }
}
