// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockAToken} from "./mocks/MockAToken.sol";
import {MaliciousReentrantToken} from "./mocks/MaliciousReentrantToken.sol";

contract LegateEscrowTest is Test {
    LegateEscrow escrow;
    ComplianceGate gate;
    MockValidator validator;
    MockAToken aToken;

    address admin = makeAddr("admin");
    address feeAddr = makeAddr("fee");
    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");
    address unverified = makeAddr("unverified");

    uint256 constant PER_TX_CAP = 10_000e18;
    uint256 constant DAILY_CAP = 100_000e18;

    function setUp() public {
        aToken = new MockAToken();
        validator = new MockValidator();
        escrow = new LegateEscrow(address(aToken), admin);

        vm.prank(admin);
        gate = new ComplianceGate(address(validator), address(escrow), admin, PER_TX_CAP, DAILY_CAP);

        vm.startPrank(admin);
        escrow.setComplianceGate(address(gate));
        escrow.setFeeConfig(feeAddr, 50); // 0.5%
        vm.stopPrank();

        vm.prank(admin);
        gate.grantCaller(address(escrow));

        // sender + recipient are compliant by default in these tests; `unverified` is not.
        validator.setCompliant(address(escrow), sender, true);
        validator.setCompliant(address(escrow), recipient, true);

        aToken.mint(sender, 1_000_000e18);
        vm.prank(sender);
        aToken.approve(address(escrow), type(uint256).max);
    }

    // --- Happy path ---

    function test_HappyPath_InitiateThenSettle() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Escrowed));
        assertEq(aToken.balanceOf(address(escrow)), 1_000e18);

        escrow.settle(paymentId);

        p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Settled));

        uint256 expectedFee = (1_000e18 * 50) / 10_000;
        assertEq(aToken.balanceOf(recipient), 1_000e18 - expectedFee);
        assertEq(aToken.balanceOf(feeAddr), expectedFee);
        assertEq(aToken.balanceOf(address(escrow)), 0);
    }

    // --- Negative paths: every revert condition, not just the happy path ---

    function test_RevertWhen_SenderNotCompliant() public {
        vm.prank(unverified);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGate.SenderNotCompliant.selector, unverified));
        escrow.initiate(recipient, 1_000e18);
    }

    function test_RevertWhen_RecipientNotCompliant() public {
        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGate.RecipientNotCompliant.selector, unverified));
        escrow.initiate(unverified, 1_000e18);
    }

    function test_RevertWhen_PerTxCapExceeded() public {
        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(ComplianceGate.PerTxCapExceeded.selector, PER_TX_CAP + 1, PER_TX_CAP)
        );
        escrow.initiate(recipient, PER_TX_CAP + 1);
    }

    function test_RevertWhen_DailyCorridorCapExceeded() public {
        // Spend right up to the daily cap across multiple payments, then one more should fail.
        vm.startPrank(sender);
        uint256 spent = 0;
        while (spent + PER_TX_CAP <= DAILY_CAP) {
            escrow.initiate(recipient, PER_TX_CAP);
            spent += PER_TX_CAP;
        }
        uint256 remaining = DAILY_CAP - spent;
        vm.expectRevert(
            abi.encodeWithSelector(ComplianceGate.DailyCorridorCapExceeded.selector, remaining + 1, remaining)
        );
        escrow.initiate(recipient, remaining + 1);
        vm.stopPrank();
    }

    function test_DailyCap_ResetsNextDay() public {
        vm.startPrank(sender);
        uint256 spent = 0;
        while (spent + PER_TX_CAP <= DAILY_CAP) {
            escrow.initiate(recipient, PER_TX_CAP);
            spent += PER_TX_CAP;
        }
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, PER_TX_CAP);
        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Escrowed));
    }

    // --- Revocation reaching funds already in escrow (this is Demo Scene 3) ---

    function test_SettleRevertsIfRecipientRevokedAfterInitiate() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        // Recipient's A-Pass gets revoked while the payment sits in escrow.
        validator.setCompliant(address(escrow), recipient, false);

        vm.expectRevert(LegateEscrow.NotCompliantAtSettlement.selector);
        escrow.settle(paymentId);

        // Funds are still safely in escrow, not lost, not incorrectly released.
        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Escrowed));
        assertEq(aToken.balanceOf(address(escrow)), 1_000e18);
    }

    function test_FreezeAndRefund_RevocationPath() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        vm.prank(admin);
        escrow.freeze(paymentId, "sanctions hit");

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Frozen));

        vm.prank(admin);
        escrow.refundFrozen(paymentId);

        p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Refunded));
        // Full amount returned, no fee taken on a refund (clean-money return).
        assertEq(aToken.balanceOf(sender), 1_000_000e18);
    }

    function test_RevertWhen_SettlingAlreadySettledPayment() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);
        escrow.settle(paymentId);

        vm.expectRevert(
            abi.encodeWithSelector(
                LegateEscrow.InvalidState.selector, LegateEscrow.PaymentState.Escrowed, LegateEscrow.PaymentState.Settled
            )
        );
        escrow.settle(paymentId);
    }

    function test_RevertWhen_NonAdminCallsFreeze() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        vm.prank(unverified);
        vm.expectRevert(); // AccessControl unauthorized
        escrow.freeze(paymentId, "not allowed");
    }

    // --- Reentrancy: prove it, don't just assert a modifier exists ---

    function test_ReentrancyAttack_FailsSafely() public {
        MaliciousReentrantToken evilToken = new MaliciousReentrantToken();
        LegateEscrow evilEscrow = new LegateEscrow(address(evilToken), admin);

        vm.prank(admin);
        ComplianceGate evilGate = new ComplianceGate(address(validator), address(evilEscrow), admin, PER_TX_CAP, DAILY_CAP);
        vm.startPrank(admin);
        evilEscrow.setComplianceGate(address(evilGate));
        vm.stopPrank();
        vm.prank(admin);
        evilGate.grantCaller(address(evilEscrow));

        validator.setCompliant(address(evilEscrow), sender, true);
        validator.setCompliant(address(evilEscrow), recipient, true);

        evilToken.mint(sender, 10_000e18);
        vm.prank(sender);
        evilToken.approve(address(evilEscrow), type(uint256).max);

        vm.prank(sender);
        bytes32 paymentId = evilEscrow.initiate(recipient, 1_000e18);

        evilToken.setAttack(evilEscrow, paymentId);

        // The malicious token attempts to re-enter settle() on the same paymentId mid-transfer.
        // Expected: the whole transaction reverts (the nested call hits either the
        // ReentrancyGuard or the checks-effects-interactions InvalidState check — either is
        // sufficient, and this test proves at least one actually fires).
        vm.expectRevert();
        evilEscrow.settle(paymentId);

        // Critically: verify no partial state corruption or fund leakage occurred. The
        // payment must still be exactly Escrowed with the full original balance intact —
        // proving the attack didn't extract any value even partially.
        LegateEscrow.Payment memory p = evilEscrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Escrowed));
        assertEq(evilToken.balanceOf(address(evilEscrow)), 1_000e18);
        assertEq(evilToken.balanceOf(recipient), 0);
    }

    // --- Fee-stranding fix (real, proven bug found during a security review, see DECISIONS.md):
    //     settle()/settleFromMandate() must not deduct a fee from the recipient when no
    //     feeAddress is configured — otherwise the deducted amount is permanently stuck in
    //     the contract's own balance, unattached to any payment, unrecoverable. ---

    function test_RecipientReceives100PercentWhenFeeAddressUnset() public {
        // Fresh escrow with the SAME default feeBps (50) but feeAddress deliberately never set
        // — the exact misconfiguration every existing test's setUp() avoids by calling
        // setFeeConfig(), which is precisely why this gap was never caught before.
        LegateEscrow freshEscrow = new LegateEscrow(address(aToken), admin);
        vm.startPrank(admin);
        ComplianceGate freshGate = new ComplianceGate(address(validator), address(freshEscrow), admin, PER_TX_CAP, DAILY_CAP);
        freshEscrow.setComplianceGate(address(freshGate));
        vm.stopPrank();
        vm.prank(admin);
        freshGate.grantCaller(address(freshEscrow));

        validator.setCompliant(address(freshEscrow), sender, true);
        validator.setCompliant(address(freshEscrow), recipient, true);
        aToken.mint(sender, 10_000e18);
        vm.startPrank(sender);
        aToken.approve(address(freshEscrow), type(uint256).max);
        bytes32 paymentId = freshEscrow.initiate(recipient, 1_000e18);
        vm.stopPrank();

        freshEscrow.settle(paymentId);

        assertEq(aToken.balanceOf(recipient), 1_000e18, "recipient must receive the full amount, not amount-minus-uncollected-fee");
        assertEq(aToken.balanceOf(address(freshEscrow)), 0, "nothing should be stranded in the contract");
    }

    // --- sweepSurplus(): provably safe, not just claimed safe ---

    function test_SweepSurplus_RecoversStrayDirectTransfer() public {
        // Simulate an operator error: a direct transfer to the escrow, not via initiate().
        aToken.mint(address(escrow), 777e18);
        assertEq(escrow.totalEscrowed(), 0);

        address treasury = makeAddr("treasury");
        vm.prank(admin);
        escrow.sweepSurplus(treasury, 777e18);

        assertEq(aToken.balanceOf(treasury), 777e18);
    }

    function test_RevertWhen_SweepSurplusExceedsActualSurplus() public {
        // Real escrowed funds sitting in the contract for an open payment — must not be
        // sweepable, proving the totalEscrowed accounting genuinely gates this, not just the
        // function's doc comment.
        vm.prank(sender);
        escrow.initiate(recipient, 1_000e18);
        assertEq(escrow.totalEscrowed(), 1_000e18);
        assertEq(aToken.balanceOf(address(escrow)), 1_000e18);

        address treasury = makeAddr("treasury");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(LegateEscrow.InsufficientSurplus.selector, 1_000e18, 0));
        escrow.sweepSurplus(treasury, 1_000e18);
    }

    function test_SweepSurplus_OnlyTouchesSurplusAboveEscrowedFunds() public {
        // A real open payment PLUS a stray extra transfer — sweep must recover only the
        // stray portion, leaving the genuinely-owed portion untouched.
        vm.prank(sender);
        escrow.initiate(recipient, 1_000e18);
        aToken.mint(address(escrow), 250e18); // stray extra

        address treasury = makeAddr("treasury");
        vm.prank(admin);
        escrow.sweepSurplus(treasury, 250e18);

        assertEq(aToken.balanceOf(treasury), 250e18);
        assertEq(aToken.balanceOf(address(escrow)), 1_000e18, "the real escrowed payment must remain fully funded");
    }

    // --- reclaimExpired(): self-service recovery for a stuck payment, real pilot-readiness
    //     gap found during review (no recourse existed before except an admin manually
    //     freezing then refunding). Sender-only, window-gated. ---

    function test_ReclaimExpired_SenderRecoversFundsAfterWindowPasses() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        uint256 senderBalanceBefore = aToken.balanceOf(sender);

        vm.warp(block.timestamp + escrow.CLAIM_WINDOW() + 1);

        vm.prank(sender);
        escrow.reclaimExpired(paymentId);

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Refunded));
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(aToken.balanceOf(sender), senderBalanceBefore + 1_000e18, "sender must get the full amount back, no fee on a reclaim");
        assertEq(aToken.balanceOf(address(escrow)), 0);
    }

    function test_RevertWhen_ReclaimExpired_CalledByNonSender() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        vm.warp(block.timestamp + escrow.CLAIM_WINDOW() + 1);

        vm.prank(recipient);
        vm.expectRevert(LegateEscrow.NotPaymentSender.selector);
        escrow.reclaimExpired(paymentId);
    }

    function test_RevertWhen_ReclaimExpired_WindowNotYetExpired() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);

        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(LegateEscrow.ClaimWindowNotExpired.selector, p.claimDeadline));
        escrow.reclaimExpired(paymentId);
    }

    function test_RevertWhen_ReclaimExpired_PaymentAlreadySettled() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);
        escrow.settle(paymentId);

        vm.warp(block.timestamp + escrow.CLAIM_WINDOW() + 1);

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegateEscrow.InvalidState.selector, LegateEscrow.PaymentState.Escrowed, LegateEscrow.PaymentState.Settled
            )
        );
        escrow.reclaimExpired(paymentId);
    }

    /// The claim window is a floor on the SENDER's right, not an expiry of the RECIPIENT's.
    /// If it cut both ways, a payment neither party touched for 30 days would be stranded
    /// forever. Proving it explicitly because "does the recipient lose their claim?" is the
    /// first question this design invites, and a doc comment isn't an answer.
    function test_RecipientCanStillSettleAfterTheClaimWindowCloses() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        vm.warp(block.timestamp + escrow.CLAIM_WINDOW() + 365 days);

        escrow.settle(paymentId);

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Settled));
        assertEq(aToken.balanceOf(recipient), 1_000e18 - (1_000e18 * 50) / 10_000);
    }

    /// The flip side of that race: once the sender has actually reclaimed, the recipient's
    /// window is genuinely closed and they get a clear typed revert, not a silent no-op.
    function test_RevertWhen_RecipientSettlesAfterSenderAlreadyReclaimed() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        vm.warp(block.timestamp + escrow.CLAIM_WINDOW() + 1);
        vm.prank(sender);
        escrow.reclaimExpired(paymentId);

        vm.expectRevert(
            abi.encodeWithSelector(
                LegateEscrow.InvalidState.selector, LegateEscrow.PaymentState.Escrowed, LegateEscrow.PaymentState.Refunded
            )
        );
        escrow.settle(paymentId);

        assertEq(aToken.balanceOf(recipient), 0, "recipient must not receive anything after a completed reclaim");
    }

    function test_RevertWhen_ReclaimExpired_PaymentAlreadyFrozen() public {
        vm.prank(sender);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        vm.prank(admin);
        escrow.freeze(paymentId, "sanctions hit");

        vm.warp(block.timestamp + escrow.CLAIM_WINDOW() + 1);

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegateEscrow.InvalidState.selector, LegateEscrow.PaymentState.Escrowed, LegateEscrow.PaymentState.Frozen
            )
        );
        escrow.reclaimExpired(paymentId);
    }
}
