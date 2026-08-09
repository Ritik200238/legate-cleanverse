// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockAToken} from "./mocks/MockAToken.sol";

/// Every input guard and state guard on the contract that holds the money.
///
/// These exist because line coverage was 98% while *branch* coverage on LegateEscrow was 42% —
/// the happy side of every guard was exercised and the refusing side mostly was not. A guard
/// that has never been observed refusing is a guard nobody has tested; it is an assumption
/// with an `if` in front of it. "73 tests passing" does not survive `forge coverage`, and it
/// shouldn't.
contract LegateEscrowGuardsTest is Test {
    LegateEscrow escrow;
    ComplianceGate gate;
    MockValidator validator;
    MockAToken aToken;

    address admin = makeAddr("admin");
    address feeAddr = makeAddr("fee");
    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");
    address outsider = makeAddr("outsider");

    uint256 constant PER_TX_CAP = 10_000e18;
    uint256 constant DAILY_CAP = 1_000_000e18;

    function setUp() public {
        aToken = new MockAToken();
        validator = new MockValidator();
        escrow = new LegateEscrow(address(aToken), admin);

        vm.prank(admin);
        gate = new ComplianceGate(address(validator), address(escrow), admin, PER_TX_CAP, DAILY_CAP);

        vm.startPrank(admin);
        escrow.setComplianceGate(address(gate));
        escrow.setFeeConfig(feeAddr, 50);
        vm.stopPrank();
        vm.prank(admin);
        gate.grantCaller(address(escrow));

        validator.setCompliant(address(escrow), sender, true);
        validator.setCompliant(address(escrow), recipient, true);
        aToken.mint(sender, 1_000_000e18);
        vm.prank(sender);
        aToken.approve(address(escrow), type(uint256).max);
    }

    // --- Constructor ---

    function test_RevertWhen_ConstructedWithZeroAToken() public {
        vm.expectRevert(LegateEscrow.ZeroAddress.selector);
        new LegateEscrow(address(0), admin);
    }

    /// Ownable(admin_) rejects a zero owner before our own check runs, so this asserts *a*
    /// revert rather than a specific selector — pinning OpenZeppelin's error here would make
    /// the test brittle against a dependency bump for no gain.
    function test_RevertWhen_ConstructedWithZeroAdmin() public {
        vm.expectRevert();
        new LegateEscrow(address(aToken), address(0));
    }

    // --- Amount guards ---

    /// A zero-amount payment would mint a paymentId, emit an event and occupy a storage slot
    /// while moving nothing — an auditable record of a thing that did not happen.
    function test_RevertWhen_InitiatingZeroAmount() public {
        vm.prank(sender);
        vm.expectRevert(LegateEscrow.ZeroAmount.selector);
        escrow.initiate(recipient, 0);
    }

    function test_RevertWhen_MandateSettlesZeroAmount() public {
        address mandate = makeAddr("mandate");
        vm.prank(admin);
        escrow.setMandate(mandate);
        vm.prank(mandate);
        vm.expectRevert(LegateEscrow.ZeroAmount.selector);
        escrow.settleFromMandate(sender, recipient, 0);
    }

    // --- State-machine guards ---

    function test_RevertWhen_FreezingAPaymentThatIsNotEscrowed() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 100e18);
        escrow.settle(paymentId);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegateEscrow.InvalidState.selector, LegateEscrow.PaymentState.Escrowed, LegateEscrow.PaymentState.Settled
            )
        );
        escrow.freeze(paymentId, "too late");
    }

    /// Refunding straight from Escrowed would let an admin pull back a payment the recipient
    /// is entitled to, without the freeze that creates the audit record of why.
    function test_RevertWhen_RefundingAPaymentThatIsNotFrozen() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 100e18);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegateEscrow.InvalidState.selector, LegateEscrow.PaymentState.Frozen, LegateEscrow.PaymentState.Escrowed
            )
        );
        escrow.refundFrozen(paymentId);
    }

    function test_RevertWhen_FreezingAnUnknownPayment() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegateEscrow.InvalidState.selector, LegateEscrow.PaymentState.Escrowed, LegateEscrow.PaymentState.None
            )
        );
        escrow.freeze(keccak256("never existed"), "nothing here");
    }

    // --- Configuration guards ---
    //
    // Each of these would silently disable an enforcement point rather than fail loudly.
    // Zeroing the gate is the worst: the escrow would keep accepting payments and stop
    // checking anyone, which is the exact failure this whole product exists to prevent.

    function test_RevertWhen_SettingZeroComplianceGate() public {
        vm.prank(admin);
        vm.expectRevert(LegateEscrow.ZeroAddress.selector);
        escrow.setComplianceGate(address(0));
    }

    function test_RevertWhen_SettingZeroMirror() public {
        vm.prank(admin);
        vm.expectRevert(LegateEscrow.ZeroAddress.selector);
        escrow.setMirror(address(0));
    }

    function test_RevertWhen_SettingZeroMandate() public {
        vm.prank(admin);
        vm.expectRevert(LegateEscrow.ZeroAddress.selector);
        escrow.setMandate(address(0));
    }

    function test_RevertWhen_SweepingToZeroAddress() public {
        aToken.mint(address(escrow), 10e18);
        vm.prank(admin);
        vm.expectRevert(LegateEscrow.ZeroAddress.selector);
        escrow.sweepSurplus(address(0), 10e18);
    }

    /// MAX_FEE_BPS is the promise that a user's funds cannot be quietly confiscated by a fee
    /// change. Prove the ceiling actually binds, at the boundary and one past it.
    function test_RevertWhen_FeeExceedsHardCap() public {
        uint256 max = escrow.MAX_FEE_BPS();
        vm.prank(admin);
        vm.expectRevert(LegateEscrow.FeeTooHigh.selector);
        escrow.setFeeConfig(feeAddr, max + 1);

        vm.prank(admin);
        escrow.setFeeConfig(feeAddr, max); // exactly at the cap must still be allowed
        assertEq(escrow.feeBps(), max);
    }

    // --- Access control on every admin entry point ---

    function test_RevertWhen_NonAdminChangesConfiguration() public {
        vm.startPrank(outsider);
        vm.expectRevert();
        escrow.setComplianceGate(address(gate));
        vm.expectRevert();
        escrow.setMirror(makeAddr("m"));
        vm.expectRevert();
        escrow.setMandate(makeAddr("mm"));
        vm.expectRevert();
        escrow.setFeeConfig(outsider, 10);
        vm.expectRevert();
        escrow.sweepSurplus(outsider, 1);
        vm.stopPrank();
    }

    /// settleFromMandate is the one path that moves funds without the sender signing, so the
    /// caller check is the only thing standing between it and anyone draining the escrow.
    function test_RevertWhen_NonMandateCallsSettleFromMandate() public {
        vm.prank(outsider);
        vm.expectRevert();
        escrow.settleFromMandate(sender, recipient, 100e18);
    }

    // --- Fee arithmetic at both ends of the branch ---

    function test_FeeIsTakenWhenConfigured_AndSkippedWhenZeroBps() public {
        vm.prank(sender);
        bytes32 withFee = escrow.initiate(recipient, 1_000e18);
        escrow.settle(withFee);
        assertEq(aToken.balanceOf(feeAddr), (1_000e18 * 50) / 10_000, "fee branch must be taken");

        // feeBps 0 with a fee address still set — the `fee > 0` guard, not the address guard.
        vm.prank(admin);
        escrow.setFeeConfig(feeAddr, 0);
        uint256 feeBalanceBefore = aToken.balanceOf(feeAddr);
        uint256 recipientBefore = aToken.balanceOf(recipient);

        vm.prank(sender);
        bytes32 noFee = escrow.initiate(recipient, 1_000e18);
        escrow.settle(noFee);

        assertEq(aToken.balanceOf(feeAddr), feeBalanceBefore, "no transfer should occur for a zero fee");
        assertEq(aToken.balanceOf(recipient) - recipientBefore, 1_000e18, "recipient gets the whole amount");
    }
}
