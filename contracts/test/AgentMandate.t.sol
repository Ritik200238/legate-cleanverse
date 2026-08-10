// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockAToken} from "./mocks/MockAToken.sol";

contract AgentMandateTest is Test {
    LegateEscrow escrow;
    ComplianceGate gate;
    AgentMandate mandateContract;
    MockValidator validator;
    MockAToken aToken;

    address admin = makeAddr("admin");
    address principal = makeAddr("principal");
    address agent = makeAddr("agent");
    address recipient = makeAddr("recipient");
    address unverifiedRecipient = makeAddr("unverifiedRecipient");

    uint256 constant PER_TX_CAP = 500e18;
    uint256 constant DAILY_CAP = 2_000e18;
    uint256 constant TOTAL_CAP = 5_000e18;

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

        validator.setCompliant(address(escrow), principal, true);
        validator.setCompliant(address(escrow), recipient, true);
        validator.setCompliant(address(escrow), unverifiedRecipient, false);

        aToken.mint(principal, 1_000_000e18);
        vm.prank(principal);
        aToken.approve(address(escrow), type(uint256).max);
    }

    function _createMandate() internal {
        vm.prank(principal);
        mandateContract.createMandate(agent, PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp + 30 days));
    }

    // --- Happy path ---

    function test_HappyPath_ExecutePayment() public {
        _createMandate();

        vm.prank(agent);
        bytes32 paymentId = mandateContract.execute(recipient, 100e18);

        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Settled));
        assertGt(aToken.balanceOf(recipient), 0);
    }

    function test_RevertWhen_CreatingMandateForNonCompliantPrincipal() public {
        address badPrincipal = makeAddr("badPrincipal"); // never marked compliant
        vm.prank(badPrincipal);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.PrincipalNotCompliant.selector, badPrincipal));
        mandateContract.createMandate(agent, PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp + 30 days));
    }

    // --- Cap boundaries: tested at every edge, not just the happy path ---

    function test_RevertWhen_PerTxCapExceeded() public {
        _createMandate();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.PerTxCapExceeded.selector, PER_TX_CAP + 1, PER_TX_CAP));
        mandateContract.execute(recipient, PER_TX_CAP + 1);
    }

    function test_ExactlyAtPerTxCap_Succeeds() public {
        _createMandate();
        vm.prank(agent);
        bytes32 paymentId = mandateContract.execute(recipient, PER_TX_CAP); // exactly at the boundary
        LegateEscrow.Payment memory p = escrow.getPayment(paymentId);
        assertEq(uint8(p.state), uint8(LegateEscrow.PaymentState.Settled));
    }

    function test_RevertWhen_DailyCapExceeded() public {
        _createMandate();
        vm.startPrank(agent);
        uint256 spent = 0;
        while (spent + PER_TX_CAP <= DAILY_CAP) {
            mandateContract.execute(recipient, PER_TX_CAP);
            spent += PER_TX_CAP;
        }
        uint256 remaining = DAILY_CAP - spent;
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.DailyCapExceeded.selector, remaining + 1, remaining));
        mandateContract.execute(recipient, remaining + 1);
        vm.stopPrank();
    }

    function test_RevertWhen_TotalCapExceeded() public {
        _createMandate();
        vm.startPrank(agent);
        // Spend across multiple days to exhaust the lifetime cap without hitting the daily cap first.
        uint256 spent = 0;
        while (spent + PER_TX_CAP <= TOTAL_CAP) {
            mandateContract.execute(recipient, PER_TX_CAP);
            spent += PER_TX_CAP;
            vm.warp(block.timestamp + 1 days + 1); // reset daily window each iteration
        }
        uint256 remaining = TOTAL_CAP - spent;
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.TotalCapExceeded.selector, remaining + 1, remaining));
        mandateContract.execute(recipient, remaining + 1);
        vm.stopPrank();
    }

    function test_RevertWhen_RecipientNotCompliant() public {
        _createMandate();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.RecipientNotCompliant.selector, unverifiedRecipient));
        mandateContract.execute(unverifiedRecipient, 100e18);
    }

    function test_RevertWhen_MandateExpired() public {
        _createMandate();
        vm.warp(block.timestamp + 31 days);
        vm.prank(agent);
        vm.expectRevert(AgentMandate.MandateHasExpired.selector);
        mandateContract.execute(recipient, 100e18);
    }

    function test_RevertWhen_PrincipalRevokedAfterMandateCreated() public {
        _createMandate();
        // Principal's A-Pass gets revoked after the mandate was created.
        validator.setCompliant(address(escrow), principal, false);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.PrincipalNotCompliant.selector, principal));
        mandateContract.execute(recipient, 100e18);
    }

    function test_PrincipalCanRevokeOwnMandate() public {
        _createMandate();
        vm.prank(principal);
        mandateContract.revokeMandate(agent);

        vm.prank(agent);
        vm.expectRevert(AgentMandate.MandateNotActive.selector);
        mandateContract.execute(recipient, 100e18);
    }

    function test_RevertWhen_NonPrincipalTriesToRevoke() public {
        _createMandate();
        vm.prank(agent); // agent is not the principal
        vm.expectRevert(AgentMandate.NotMandatePrincipal.selector);
        mandateContract.revokeMandate(agent);
    }

    function test_RevertWhen_UnauthorizedCallsSuspendByMirror() public {
        _createMandate();
        vm.prank(unverifiedRecipient); // has no MONITOR_ROLE
        vm.expectRevert();
        mandateContract.suspendByMirror(agent);
    }

    // --- Mandate-hijacking fix (real, proven bug found during a security review, see DECISIONS.md):
    //     `mandates` is keyed only by agent address, so createMandate() must reject anyone
    //     other than the true principal trying to overwrite a still-live mandate. ---

    function test_RevertWhen_DifferentPrincipalTriesToHijackLiveMandate() public {
        _createMandate(); // principal owns agent's mandate

        address attacker = makeAddr("attacker");
        validator.setCompliant(address(escrow), attacker, true); // attacker is itself compliant — not the barrier

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.AgentAlreadyMandated.selector, agent, principal));
        mandateContract.createMandate(agent, PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp + 30 days));

        // Confirm the real-world consequence a hijack would have caused is what's now
        // prevented: the true principal can still revoke, and the mandate still spends
        // against the true principal's compliance/allowance, not the attacker's.
        vm.prank(principal);
        mandateContract.revokeMandate(agent);
        AgentMandate.Mandate memory m = mandateContract.getMandate(agent);
        assertFalse(m.active);
    }

    function test_PrincipalCanUpdateOwnLiveMandate() public {
        _createMandate();

        vm.prank(principal);
        mandateContract.createMandate(agent, PER_TX_CAP * 2, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp + 30 days));

        AgentMandate.Mandate memory m = mandateContract.getMandate(agent);
        assertEq(m.principal, principal);
        assertEq(m.perTxCap, PER_TX_CAP * 2);
    }

    function test_NewPrincipalCanClaimSlotAfterRevocation() public {
        _createMandate();
        vm.prank(principal);
        mandateContract.revokeMandate(agent);

        address newPrincipal = makeAddr("newPrincipal");
        validator.setCompliant(address(escrow), newPrincipal, true);

        vm.prank(newPrincipal);
        mandateContract.createMandate(agent, PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp + 30 days));

        AgentMandate.Mandate memory m = mandateContract.getMandate(agent);
        assertEq(m.principal, newPrincipal);
        assertTrue(m.active);
    }

    function test_NewPrincipalCanClaimSlotAfterExpiry() public {
        _createMandate();
        vm.warp(block.timestamp + 31 days); // past the mandate's expiry, never explicitly revoked

        address newPrincipal = makeAddr("newPrincipal");
        validator.setCompliant(address(escrow), newPrincipal, true);

        vm.prank(newPrincipal);
        mandateContract.createMandate(agent, PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp + 30 days));

        AgentMandate.Mandate memory m = mandateContract.getMandate(agent);
        assertEq(m.principal, newPrincipal);
    }

    // --- Guards: line coverage was 98% while branch coverage was 68.75% -- the happy side of
    //     every zero-address and boundary check was exercised, the refusing side mostly was
    //     not. AgentMandate is the module half of the Safe module/guard pattern this project's
    //     own pitch leans on; its untested refusals deserved the same scrutiny LegateEscrow's
    //     already got. ---

    function test_RevertWhen_ConstructedWithAnyZeroAddress() public {
        vm.expectRevert(AgentMandate.ZeroAddress.selector);
        new AgentMandate(address(0), address(escrow), address(escrow), admin);
        vm.expectRevert(AgentMandate.ZeroAddress.selector);
        new AgentMandate(address(validator), address(0), address(escrow), admin);
        vm.expectRevert(AgentMandate.ZeroAddress.selector);
        new AgentMandate(address(validator), address(escrow), address(0), admin);
        vm.expectRevert(AgentMandate.ZeroAddress.selector);
        new AgentMandate(address(validator), address(escrow), address(escrow), address(0));
    }

    function test_RevertWhen_CreatingMandateForZeroAddressAgent() public {
        vm.prank(principal);
        vm.expectRevert(AgentMandate.ZeroAddress.selector);
        mandateContract.createMandate(address(0), PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp + 30 days));
    }

    /// Distinct from test_RevertWhen_MandateExpired above, which times out an already-created
    /// mandate at execute(). This is the other half: createMandate() itself must refuse an
    /// expiry that is already in the past, not silently create a mandate that can never be used.
    function test_RevertWhen_CreatingMandateWithExpiryInThePast() public {
        vm.warp(1_700_000_000); // clear of timestamp 0 edge cases
        vm.prank(principal);
        vm.expectRevert(AgentMandate.ExpiryInPast.selector);
        mandateContract.createMandate(agent, PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp - 1));
    }

    function test_RevertWhen_CreatingMandateWithExpiryExactlyNow() public {
        vm.prank(principal);
        vm.expectRevert(AgentMandate.ExpiryInPast.selector);
        mandateContract.createMandate(agent, PER_TX_CAP, DAILY_CAP, TOTAL_CAP, uint64(block.timestamp));
    }

    /// suspendByMirror returns false rather than reverting on an already-inactive mandate, so a
    /// batch revocation sweep across many agents doesn't abort on one that's already suspended
    /// or was never created. Prove the false branch actually returns, not just that a mandate
    /// exists to suspend once.
    function test_SuspendByMirror_ReturnsFalseForAlreadyInactiveMandate() public {
        address mirror = makeAddr("mirror");
        vm.prank(admin);
        mandateContract.setMirror(mirror);

        // Never created at all -- .active defaults to false on an empty struct.
        vm.prank(mirror);
        bool result = mandateContract.suspendByMirror(agent);
        assertFalse(result);

        // Created, then already suspended once -- the second call must also return false, not
        // revert or emit a second MandateSuspended for a mandate that's already down.
        _createMandate();
        vm.prank(mirror);
        assertTrue(mandateContract.suspendByMirror(agent));
        vm.prank(mirror);
        assertFalse(mandateContract.suspendByMirror(agent));
    }

    function test_RevertWhen_SettingZeroAddressMirror() public {
        vm.prank(admin);
        vm.expectRevert(AgentMandate.ZeroAddress.selector);
        mandateContract.setMirror(address(0));
    }

    /// This file's setUp() never configures a fee address, so every other test in it exercises
    /// settleFromMandate()'s fee==0 branch only — the agent-payment path's fee-actually-taken
    /// branch (LegateEscrow.sol's second `if (fee > 0)`, distinct from settle()'s own) had
    /// literally never run. Same class of bug already found and fixed once on the human Send
    /// path (a fee computed but the transfer silently skipped, stranding funds); nothing was
    /// proving the agent path couldn't regress the same way.
    function test_AgentPayment_FeeIsActuallyCollectedWhenConfigured() public {
        address feeAddr = makeAddr("agentPathFee");
        vm.prank(admin);
        escrow.setFeeConfig(feeAddr, 50); // 0.5%, same rate the human-path tests use

        _createMandate();
        vm.prank(agent);
        mandateContract.execute(recipient, PER_TX_CAP); // within cap, unlike the 1_000e18 this test first tried

        uint256 expectedFee = (PER_TX_CAP * 50) / 10_000;
        assertEq(aToken.balanceOf(feeAddr), expectedFee, "fee must actually be collected on the agent-settlement path");
        assertEq(aToken.balanceOf(recipient), PER_TX_CAP - expectedFee);
    }
}
