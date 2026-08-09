// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {CVIRegistryMirror} from "../src/CVIRegistryMirror.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockAToken} from "./mocks/MockAToken.sol";

/// @notice Demo Scene 3, proven with a test: revocation reaches funds already sitting in
///         escrow, and suspends active mandates, via the same path the off-chain poller uses.
contract CVIRegistryMirrorTest is Test {
    LegateEscrow escrow;
    ComplianceGate gate;
    AgentMandate mandateContract;
    CVIRegistryMirror mirror;
    MockValidator validator;
    MockAToken aToken;

    address admin = makeAddr("admin");
    address poller = makeAddr("poller");
    address principal = makeAddr("principal");
    address agent = makeAddr("agent");
    address recipient = makeAddr("recipient");

    function setUp() public {
        aToken = new MockAToken();
        validator = new MockValidator();
        escrow = new LegateEscrow(address(aToken), admin);

        vm.prank(admin);
        gate = new ComplianceGate(address(validator), address(escrow), admin, 100_000e18, 1_000_000e18);
        vm.prank(admin);
        escrow.setComplianceGate(address(gate));
        vm.prank(admin);
        gate.grantCaller(address(escrow));

        mandateContract = new AgentMandate(address(validator), address(escrow), address(escrow), admin);
        vm.prank(admin);
        escrow.setMandate(address(mandateContract));

        mirror = new CVIRegistryMirror(address(escrow), address(mandateContract), admin);
        vm.prank(admin);
        escrow.setMirror(address(mirror));
        vm.prank(admin);
        mandateContract.setMirror(address(mirror));
        vm.prank(admin);
        mirror.grantPoller(poller);

        validator.setCompliant(address(escrow), principal, true);
        validator.setCompliant(address(escrow), recipient, true);

        aToken.mint(principal, 1_000_000e18);
        vm.prank(principal);
        aToken.approve(address(escrow), type(uint256).max);
    }

    function test_RevocationFreezesOpenPayment() public {
        vm.prank(principal);
        bytes32 paymentId = escrow.initiate(recipient, 1_000e18);

        bytes32[] memory paymentIds = new bytes32[](1);
        paymentIds[0] = paymentId;
        address[] memory agents = new address[](0);

        vm.prank(poller);
        mirror.reportRevocation(principal, paymentIds, agents);

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Frozen));
        assertTrue(mirror.isRevoked(principal));
    }

    function test_RevocationSuspendsActiveMandate() public {
        vm.prank(principal);
        mandateContract.createMandate(agent, 500e18, 2_000e18, 5_000e18, uint64(block.timestamp + 30 days));

        bytes32[] memory paymentIds = new bytes32[](0);
        address[] memory agents = new address[](1);
        agents[0] = agent;

        vm.prank(poller);
        mirror.reportRevocation(principal, paymentIds, agents);

        AgentMandate.Mandate memory m = mandateContract.getMandate(agent);
        assertFalse(m.active);

        vm.prank(agent);
        vm.expectRevert(AgentMandate.MandateNotActive.selector);
        mandateContract.execute(recipient, 100e18);
    }

    function test_BatchRevocation_AlreadySettledPaymentSkippedNotReverted() public {
        vm.prank(principal);
        bytes32 paymentId1 = escrow.initiate(recipient, 1_000e18);
        vm.prank(principal);
        bytes32 paymentId2 = escrow.initiate(recipient, 1_000e18);
        escrow.settle(paymentId1); // paymentId1 already settled before revocation is reported

        bytes32[] memory paymentIds = new bytes32[](2);
        paymentIds[0] = paymentId1;
        paymentIds[1] = paymentId2;
        address[] memory agents = new address[](0);

        vm.prank(poller);
        mirror.reportRevocation(principal, paymentIds, agents); // must not revert on paymentId1

        LegateEscrow.Payment memory p1 = escrow.getPayment(paymentId1);
        LegateEscrow.Payment memory p2 = escrow.getPayment(paymentId2);
        assertEq(uint8(p1.state), uint8(LegateEscrow.PaymentState.Settled)); // untouched
        assertEq(uint8(p2.state), uint8(LegateEscrow.PaymentState.Frozen)); // frozen
    }

    function test_RevertWhen_NonPollerReportsRevocation() public {
        bytes32[] memory paymentIds = new bytes32[](0);
        address[] memory agents = new address[](0);
        vm.prank(principal); // has no POLLER_ROLE
        vm.expectRevert();
        mirror.reportRevocation(principal, paymentIds, agents);
    }

    function test_Reactivation_ClearsRevokedFlag() public {
        bytes32[] memory paymentIds = new bytes32[](0);
        address[] memory agents = new address[](0);
        vm.prank(poller);
        mirror.reportRevocation(principal, paymentIds, agents);
        assertTrue(mirror.isRevoked(principal));

        vm.prank(poller);
        mirror.reportReactivation(principal);
        assertFalse(mirror.isRevoked(principal));
    }

    function test_RevertWhen_ConstructedWithAnyZeroAddress() public {
        vm.expectRevert(CVIRegistryMirror.ZeroAddress.selector);
        new CVIRegistryMirror(address(0), address(mandateContract), admin);
        vm.expectRevert(CVIRegistryMirror.ZeroAddress.selector);
        new CVIRegistryMirror(address(escrow), address(0), admin);
        vm.expectRevert(CVIRegistryMirror.ZeroAddress.selector);
        new CVIRegistryMirror(address(escrow), address(mandateContract), address(0));
    }
}
