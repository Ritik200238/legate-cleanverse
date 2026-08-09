// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {LegateEscrow} from "./LegateEscrow.sol";
import {AgentMandate} from "./AgentMandate.sol";

/// @title CVIRegistryMirror
/// @notice Active revocation monitor — defense-in-depth, not the only line of defense.
///         Because IAPassComplianceValidator.complianceVerify() is re-checked on-chain at
///         both escrow and settlement time (see LegateEscrow, ComplianceGate), a revoked
///         party is blocked automatically even with zero off-chain infrastructure — a
///         settlement attempt after revocation simply reverts. This contract exists so
///         revocation reaches funds ALREADY sitting in escrow proactively, the moment an
///         off-chain poller (there is no revocation webhook — confirmed absent from the
///         Cleanverse API docs, see DECISIONS.md) detects an A-Pass freeze, rather than
///         waiting for someone to attempt a doomed settlement. See PRD.md §5.1, Demo Scene 3.
contract CVIRegistryMirror is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice Granted to the off-chain poller service's on-chain identity (an EOA or a
    ///         relayer address the backend controls). NOT granted to end users.
    bytes32 public constant POLLER_ROLE = keccak256("POLLER_ROLE");

    LegateEscrow public immutable escrow;
    AgentMandate public immutable mandate;

    mapping(address => bool) public revoked;

    event RevocationReported(address indexed wallet, uint256 paymentsFrozen, uint256 mandatesSuspended);
    event ReactivationReported(address indexed wallet);

    error ZeroAddress();

    constructor(address escrow_, address mandate_, address admin_) {
        if (escrow_ == address(0) || mandate_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        escrow = LegateEscrow(escrow_);
        mandate = AgentMandate(mandate_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    /// @notice Called by the off-chain poller when it observes an A-Pass freeze
    ///         (POST /update_status, status=2) for `wallet`. The poller already knows,
    ///         from its own indexed payment/mandate records, which specific open payments
    ///         and mandates involve this wallet — passing them explicitly avoids expensive
    ///         on-chain enumeration.
    function reportRevocation(address wallet, bytes32[] calldata openPaymentIds, address[] calldata mandateAgents)
        external
        onlyRole(POLLER_ROLE)
    {
        revoked[wallet] = true;

        uint256 frozen;
        for (uint256 i = 0; i < openPaymentIds.length; i++) {
            if (escrow.freezeByMirror(openPaymentIds[i])) frozen++;
        }

        uint256 suspended;
        for (uint256 i = 0; i < mandateAgents.length; i++) {
            if (mandate.suspendByMirror(mandateAgents[i])) suspended++;
        }

        emit RevocationReported(wallet, frozen, suspended);
    }

    /// @notice Called when the poller observes the wallet's A-Pass reactivated. Does NOT
    ///         auto-unfreeze payments/mandates — those go through the compliance review
    ///         flow (ADMIN_ROLE-gated) per PRD.md's "refund-to-origin, clean-money return"
    ///         design, not an automatic reversal.
    function reportReactivation(address wallet) external onlyRole(POLLER_ROLE) {
        revoked[wallet] = false;
        emit ReactivationReported(wallet);
    }

    /// @notice The mirror's own local view of a wallet's revocation status. Reflects the last
    ///         `reportRevocation`/`reportReactivation` call, not a live read of Cleanverse's
    ///         validator — see the contract-level comment for why this is deliberately
    ///         defense-in-depth rather than the source of truth.
    function isRevoked(address wallet) external view returns (bool) {
        return revoked[wallet];
    }

    /// @notice Grants POLLER_ROLE to the off-chain revocation-poller service's signing key.
    function grantPoller(address poller) external onlyRole(ADMIN_ROLE) {
        _grantRole(POLLER_ROLE, poller);
    }
}
