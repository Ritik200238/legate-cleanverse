// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockAToken} from "./mocks/MockAToken.sol";

/// @notice Bounded random caller for the invariant campaign below. Every action here mirrors
///         a real user flow (initiate then settle) and keeps its own "ghost" bookkeeping so
///         the invariant test can check LegateEscrow's own totalEscrowed accounting against an
///         independent count, not just against itself.
contract LegateEscrowHandler is Test {
    LegateEscrow public escrow;
    MockAToken public aToken;
    address public sender;
    address public recipient;

    uint256 public ghostEscrowed;
    bytes32[] internal openPayments;

    uint256 constant PER_TX_CAP = 10_000e18;

    constructor(LegateEscrow escrow_, MockAToken aToken_, address sender_, address recipient_) {
        escrow = escrow_;
        aToken = aToken_;
        sender = sender_;
        recipient = recipient_;
    }

    function initiate(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, PER_TX_CAP);
        aToken.mint(sender, amount);
        vm.prank(sender);
        aToken.approve(address(escrow), amount);
        vm.prank(sender);
        try escrow.initiate(recipient, amount) returns (bytes32 paymentId) {
            openPayments.push(paymentId);
            ghostEscrowed += amount;
        } catch {
            // A daily-cap or per-tx-cap revert mid-campaign is expected and fine to skip —
            // the invariant under test is accounting correctness, not cap enforcement (that's
            // ComplianceGate.t.sol's job, already covered).
        }
    }

    function settle(uint256 indexSeed) external {
        if (openPayments.length == 0) return;
        uint256 i = indexSeed % openPayments.length;
        bytes32 paymentId = openPayments[i];

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        if (p.state != LegateEscrow.PaymentState.Escrowed) {
            _removeOpenPayment(i);
            return;
        }

        try escrow.settle(paymentId) {
            ghostEscrowed -= p.amount;
        } catch {
            // Compliance could have been revoked mid-campaign in a richer handler; this one
            // never does that, so a revert here would itself be a real bug worth seeing.
        }
        _removeOpenPayment(i);
    }

    function _removeOpenPayment(uint256 i) internal {
        openPayments[i] = openPayments[openPayments.length - 1];
        openPayments.pop();
    }

    function openPaymentCount() external view returns (uint256) {
        return openPayments.length;
    }
}

/// @notice `[invariant]` has been configured in foundry.toml since this project's first
///         commit but never actually used — every other test here is a unit or fuzz test
///         against a single call, not a stateful campaign across many calls. This is the real
///         gap that leaves open: does `totalEscrowed` — the accounting `sweepSurplus()`'s own
///         safety proof depends on (see LegateEscrow.sol's comment on that function) — stay
///         correct across an arbitrary, long sequence of real initiate/settle calls, not just
///         the handful of hand-picked sequences the unit tests happen to construct?
contract LegateEscrowInvariantTest is StdInvariant, Test {
    LegateEscrow escrow;
    ComplianceGate gate;
    MockValidator validator;
    MockAToken aToken;
    LegateEscrowHandler handler;

    address admin = makeAddr("admin");
    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");

    function setUp() public {
        aToken = new MockAToken();
        validator = new MockValidator();
        escrow = new LegateEscrow(address(aToken), admin);

        vm.prank(admin);
        // Daily cap set generous relative to the handler's own per-tx bound and Foundry's
        // default invariant depth (foundry.toml: runs=128, depth=64) so the corridor's own
        // volume cap is never the thing skipping most calls — this campaign is testing
        // totalEscrowed's accounting, not cap enforcement.
        gate = new ComplianceGate(address(validator), address(escrow), admin, 10_000e18, 100_000_000e18);

        vm.prank(admin);
        escrow.setComplianceGate(address(gate));
        vm.prank(admin);
        gate.grantCaller(address(escrow));

        validator.setCompliant(address(escrow), sender, true);
        validator.setCompliant(address(escrow), recipient, true);

        handler = new LegateEscrowHandler(escrow, aToken, sender, recipient);
        targetContract(address(handler));
    }

    /// @notice The core accounting invariant: LegateEscrow's own totalEscrowed must always
    ///         match an independent count of what's actually still owed, across any sequence
    ///         of real initiate/settle calls the fuzzer chooses to run.
    function invariant_TotalEscrowedMatchesIndependentCount() public view {
        assertEq(escrow.totalEscrowed(), handler.ghostEscrowed());
    }

    /// @notice sweepSurplus()'s entire safety argument rests on this never being false — the
    ///         contract must always hold at least as much A-Token as it owes to open payments.
    function invariant_BalanceNeverDipsBelowTotalEscrowed() public view {
        assertGe(aToken.balanceOf(address(escrow)), escrow.totalEscrowed());
    }
}
