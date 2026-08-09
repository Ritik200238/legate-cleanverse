// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TravelRuleAnchor} from "../src/TravelRuleAnchor.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockAToken} from "./mocks/MockAToken.sol";

contract TravelRuleAnchorTest is Test {
    TravelRuleAnchor anchorContract;
    LegateEscrow escrow;
    ComplianceGate gate;
    MockValidator validator;
    MockAToken aToken;

    address admin = makeAddr("admin");
    address stranger = makeAddr("stranger");
    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");

    bytes32 settledPaymentId;

    function setUp() public {
        aToken = new MockAToken();
        validator = new MockValidator();
        escrow = new LegateEscrow(address(aToken), admin);

        vm.prank(admin);
        gate = new ComplianceGate(address(validator), address(escrow), admin, 10_000e18, 100_000e18);

        vm.startPrank(admin);
        escrow.setComplianceGate(address(gate));
        anchorContract = new TravelRuleAnchor(address(escrow), admin);
        vm.stopPrank();

        vm.prank(admin);
        gate.grantCaller(address(escrow));

        validator.setCompliant(address(escrow), sender, true);
        validator.setCompliant(address(escrow), recipient, true);
        aToken.mint(sender, 1_000_000e18);
        vm.prank(sender);
        aToken.approve(address(escrow), type(uint256).max);

        // A real settled payment — anchor() now checks this via a real cross-contract call,
        // not a caller-supplied claim, so the test needs a genuine Settled payment to anchor.
        vm.prank(sender);
        settledPaymentId = escrow.initiate(recipient, 1_000e18);
        escrow.settle(settledPaymentId);
    }

    function test_AnchorAndRetrieve() public {
        bytes32 reportHash = keccak256("report-contents");
        bytes32 txHash = keccak256("tx-hash");

        vm.prank(admin);
        anchorContract.anchor(settledPaymentId, reportHash, txHash);

        TravelRuleAnchor.Anchor memory a = anchorContract.getAnchor(settledPaymentId);
        assertEq(a.reportHash, reportHash);
        assertEq(a.settlementTxHash, txHash);
        assertGt(a.anchoredAt, 0);
    }

    function test_RevertWhen_DoubleAnchoring() public {
        vm.startPrank(admin);
        anchorContract.anchor(settledPaymentId, keccak256("a"), keccak256("b"));
        vm.expectRevert(abi.encodeWithSelector(TravelRuleAnchor.AlreadyAnchored.selector, settledPaymentId));
        anchorContract.anchor(settledPaymentId, keccak256("c"), keccak256("d"));
        vm.stopPrank();
    }

    function test_RevertWhen_UnauthorizedAnchors() public {
        vm.prank(stranger);
        vm.expectRevert();
        anchorContract.anchor(settledPaymentId, keccak256("a"), keccak256("b"));
    }

    /// @notice The real fix under test: anchor() now cross-checks the real LegateEscrow
    ///         state instead of trusting whatever paymentId the caller supplies — a payment
    ///         that was never even created (let alone settled) must be rejected, closing the
    ///         data-integrity gap a security review found (see DECISIONS.md).
    function test_RevertWhen_PaymentNeverExisted() public {
        bytes32 fakePaymentId = keccak256("never-happened");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TravelRuleAnchor.PaymentNotSettled.selector, fakePaymentId));
        anchorContract.anchor(fakePaymentId, keccak256("a"), keccak256("b"));
    }

    /// @notice A payment that exists but is still Escrowed (not yet Settled) must also be
    ///         rejected — anchoring is only valid once a real settlement has actually happened.
    function test_RevertWhen_PaymentStillEscrowed() public {
        vm.prank(sender);
        bytes32 escrowedPaymentId = escrow.initiate(recipient, 500e18);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TravelRuleAnchor.PaymentNotSettled.selector, escrowedPaymentId));
        anchorContract.anchor(escrowedPaymentId, keccak256("a"), keccak256("b"));
    }

    function test_RevertWhen_ConstructedWithZeroEscrow() public {
        vm.expectRevert(TravelRuleAnchor.ZeroAddress.selector);
        new TravelRuleAnchor(address(0), admin);
    }
}
