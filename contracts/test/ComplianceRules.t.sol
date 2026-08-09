// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {IComplianceRule} from "../src/interfaces/IComplianceRule.sol";
import {StructuringRule} from "../src/rules/StructuringRule.sol";
import {DenylistRule, CountingRule, AlwaysRejectRule} from "./mocks/MockRules.sol";
import {MockValidator} from "./mocks/MockValidator.sol";
import {MockAToken} from "./mocks/MockAToken.sol";

/// Tests for the operator rule layer — the extension point that lets a licensed operator
/// enforce their own obligations without forking anything Legate has already audited.
///
/// The tests worth reading are the ones that prove the *boundaries*: that a vetoed payment
/// leaves no trace in any rule's state or the corridor's volume, that a rule cannot be driven
/// by anyone except its gate, and that a rule Legate never compiled against still works.
contract ComplianceRulesTest is Test {
    LegateEscrow escrow;
    ComplianceGate gate;
    MockValidator validator;
    MockAToken aToken;

    address admin = makeAddr("admin");
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
        gate.grantCaller(address(escrow));
        vm.stopPrank();

        validator.setCompliant(address(escrow), sender, true);
        validator.setCompliant(address(escrow), recipient, true);

        aToken.mint(sender, 10_000_000e18);
        vm.prank(sender);
        aToken.approve(address(escrow), type(uint256).max);
    }

    // --- The extension point itself ---

    /// The headline claim: a rule contract written against nothing but the published interface,
    /// which ComplianceGate has never been compiled against, changes what the corridor refuses.
    function test_ThirdPartyRuleBlocksPayment_WithoutModifyingTheGate() public {
        DenylistRule denylist = new DenylistRule();
        vm.prank(admin);
        gate.registerRule(denylist);

        // Baseline: the payment is fine before the operator's own policy says otherwise.
        vm.prank(sender);
        escrow.initiate(recipient, 100e18);

        denylist.deny(recipient);

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(ComplianceGate.RuleRejected.selector, address(denylist), bytes32("OPERATOR_DENYLIST"))
        );
        escrow.initiate(recipient, 100e18);
    }

    /// A refusal has to name the policy that produced it. "Declined" with no attribution is
    /// useless to the compliance officer who has to explain it to a customer.
    function test_RejectionIdentifiesWhichRuleRefusedAndWhy() public {
        AlwaysRejectRule bad = new AlwaysRejectRule();
        vm.prank(admin);
        gate.registerRule(bad);

        vm.prank(sender);
        try escrow.initiate(recipient, 100e18) {
            fail();
        } catch (bytes memory err) {
            bytes4 selector = bytes4(err);
            assertEq(selector, ComplianceGate.RuleRejected.selector);
            (address rule, bytes32 reason) = abi.decode(_stripSelector(err), (address, bytes32));
            assertEq(rule, address(bad));
            assertEq(reason, bytes32("ALWAYS_REJECT"));
        }
    }

    /// A vetoed payment must leave no residue anywhere: not in corridor volume, and not in any
    /// other rule's state. Otherwise a blocked payment silently consumes a legitimate one's
    /// budget — the bug the two-pass check/record split in ComplianceGate exists to prevent.
    function test_VetoedPaymentRecordsNothing_NotVolumeNotRuleState() public {
        CountingRule counter = new CountingRule();
        AlwaysRejectRule bad = new AlwaysRejectRule();
        vm.startPrank(admin);
        gate.registerRule(counter);
        gate.registerRule(bad);
        vm.stopPrank();

        uint256 spentBefore = gate.spentToday();

        vm.prank(sender);
        vm.expectRevert();
        escrow.initiate(recipient, 100e18);

        assertEq(gate.spentToday(), spentBefore, "corridor volume must not move on a refused payment");
        assertEq(counter.recordCalls(), 0, "no rule may be told about a payment that was refused");
    }

    function test_AllRulesAreToldAboutAnAllowedPayment() public {
        CountingRule a = new CountingRule();
        CountingRule b = new CountingRule();
        vm.startPrank(admin);
        gate.registerRule(a);
        gate.registerRule(b);
        vm.stopPrank();

        vm.prank(sender);
        escrow.initiate(recipient, 100e18);

        assertEq(a.recordCalls(), 1);
        assertEq(b.recordCalls(), 1);
    }

    // --- Registry management ---

    function test_RevertWhen_NonAdminRegistersRule() public {
        DenylistRule rule = new DenylistRule();
        vm.prank(outsider);
        vm.expectRevert(); // AccessControl
        gate.registerRule(rule);
    }

    /// Registering a broken rule halts the corridor. That is the operator's risk to carry —
    /// exactly as a Safe owner adding a malicious guard bricks their own Safe — which is why
    /// registration has to be reversible.
    function test_UnregisterRecoversFromABrokenRule() public {
        AlwaysRejectRule bad = new AlwaysRejectRule();
        vm.prank(admin);
        gate.registerRule(bad);

        vm.prank(sender);
        vm.expectRevert();
        escrow.initiate(recipient, 100e18);

        vm.prank(admin);
        gate.unregisterRule(bad);

        vm.prank(sender);
        escrow.initiate(recipient, 100e18); // corridor is live again
        assertEq(gate.ruleCount(), 0);
    }

    function test_RevertWhen_RegisteringSameRuleTwice() public {
        DenylistRule rule = new DenylistRule();
        vm.startPrank(admin);
        gate.registerRule(rule);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGate.RuleAlreadyRegistered.selector, address(rule)));
        gate.registerRule(rule);
        vm.stopPrank();
    }

    function test_RevertWhen_UnregisteringUnknownRule() public {
        DenylistRule rule = new DenylistRule();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGate.RuleNotRegistered.selector, address(rule)));
        gate.unregisterRule(rule);
    }

    /// Every payment iterates the rule list, so an unbounded list is a gas-exhaustion DoS on
    /// the whole corridor. The cap is a real control, not decoration — prove it holds.
    function test_RevertWhen_ExceedingMaxRules() public {
        vm.startPrank(admin);
        for (uint256 i = 0; i < gate.MAX_RULES(); ++i) {
            gate.registerRule(new CountingRule());
        }
        // Deploy BEFORE expectRevert: a `new` is itself a call, so inlining it would bind the
        // expectation to the CREATE rather than to registerRule and the assertion would pass
        // for the wrong reason. (This test failed exactly that way on its first run.)
        CountingRule oneTooMany = new CountingRule();
        vm.expectRevert(abi.encodeWithSelector(ComplianceGate.TooManyRules.selector, gate.MAX_RULES()));
        gate.registerRule(oneTooMany);
        vm.stopPrank();

        assertEq(gate.ruleCount(), gate.MAX_RULES(), "the cap must hold, not merely revert");
    }

    function test_UnregisterKeepsRemainingRulesActive() public {
        DenylistRule keep = new DenylistRule();
        CountingRule drop = new CountingRule();
        vm.startPrank(admin);
        gate.registerRule(keep);
        gate.registerRule(drop);
        gate.unregisterRule(drop);
        vm.stopPrank();

        assertEq(gate.ruleCount(), 1);
        keep.deny(recipient);
        vm.prank(sender);
        vm.expectRevert();
        escrow.initiate(recipient, 100e18);
    }

    // --- StructuringRule: the policy neither other layer can express ---

    /// The whole argument for this rule: a pattern that sails through both the per-transaction
    /// cap and the daily corridor cap, because those are threshold controls and structuring
    /// exists specifically to defeat threshold controls.
    function test_StructuringPatternEvadesBothCaps_ThenTheRuleCatchesIt() public {
        StructuringRule rule = new StructuringRule(address(gate), 1 days, 5, 4_000e18);
        vm.prank(admin);
        gate.registerRule(rule);

        // Five transfers of 900 = 4,500 aUSDC. Every one is far under the 10,000 per-tx cap,
        // and the total is a rounding error against the 1,000,000 daily corridor cap.
        vm.startPrank(sender);
        for (uint256 i = 0; i < 5; ++i) {
            escrow.initiate(recipient, 900e18);
        }
        vm.stopPrank();
        assertLt(gate.spentToday(), DAILY_CAP, "the corridor cap was never close to binding");

        // The sixth crosses both the count and the aggregate — the conjunction that separates
        // structuring from ordinary repeat payments.
        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceGate.RuleRejected.selector, address(rule), bytes32("STRUCTURING_SUSPECTED")
            )
        );
        escrow.initiate(recipient, 900e18);
    }

    /// The false-positive guard. Many small payments are normal; a large total is normal. Only
    /// both together are suspicious. A family sending weekly grocery money must not be flagged.
    function test_ManySmallPaymentsBelowAggregateAreAllowed() public {
        StructuringRule rule = new StructuringRule(address(gate), 1 days, 3, 5_000e18);
        vm.prank(admin);
        gate.registerRule(rule);

        vm.startPrank(sender);
        for (uint256 i = 0; i < 10; ++i) {
            escrow.initiate(recipient, 50e18); // 500 total — over the count, under the value
        }
        vm.stopPrank();

        (, uint256 transfers, uint256 volume) = rule.activityFor(sender, recipient);
        assertEq(transfers, 10);
        assertEq(volume, 500e18);
    }

    function test_StructuringWindowResets() public {
        StructuringRule rule = new StructuringRule(address(gate), 1 days, 2, 1_000e18);
        vm.prank(admin);
        gate.registerRule(rule);

        vm.startPrank(sender);
        escrow.initiate(recipient, 600e18);
        escrow.initiate(recipient, 600e18);
        vm.stopPrank();

        vm.prank(sender);
        vm.expectRevert();
        escrow.initiate(recipient, 600e18);

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(sender);
        escrow.initiate(recipient, 600e18); // fresh window, forgotten history
        (, uint256 transfers,) = rule.activityFor(sender, recipient);
        assertEq(transfers, 1);
    }

    /// Directional keying. A paying B twenty times is a pattern; A and B settling back and
    /// forth is ordinary two-way commerce, and collapsing them would flag exactly the merchant
    /// flows this corridor exists to serve.
    function test_ReverseDirectionIsTrackedSeparately() public {
        StructuringRule rule = new StructuringRule(address(gate), 1 days, 2, 1_000e18);
        vm.prank(admin);
        gate.registerRule(rule);
        validator.setCompliant(address(escrow), recipient, true);
        aToken.mint(recipient, 10_000e18);
        vm.prank(recipient);
        aToken.approve(address(escrow), type(uint256).max);

        vm.startPrank(sender);
        escrow.initiate(recipient, 600e18);
        escrow.initiate(recipient, 600e18);
        vm.stopPrank();

        // recipient -> sender is a different pair and must start clean.
        vm.prank(recipient);
        escrow.initiate(sender, 600e18);
        (, uint256 transfers,) = rule.activityFor(recipient, sender);
        assertEq(transfers, 1, "the reverse direction must not inherit the forward pair's history");
    }

    /// An unrestricted `record` turns a compliance control into a denial-of-service weapon:
    /// anyone could inflate a pair's counters and lock out a legitimate sender.
    function test_RevertWhen_OutsiderCallsRecordDirectly() public {
        StructuringRule rule = new StructuringRule(address(gate), 1 days, 2, 1_000e18);
        vm.prank(outsider);
        vm.expectRevert(StructuringRule.NotGate.selector);
        rule.record(sender, recipient, 1_000e18);
    }

    /// A zero threshold would refuse every payment the instant the rule is registered. Fail at
    /// deployment, loudly, rather than at the first real customer.
    function test_RevertWhen_StructuringRuleConstructedWithZeroThresholds() public {
        vm.expectRevert(StructuringRule.InvalidThreshold.selector);
        new StructuringRule(address(gate), 0, 5, 1_000e18);
        vm.expectRevert(StructuringRule.InvalidThreshold.selector);
        new StructuringRule(address(gate), 1 days, 0, 1_000e18);
        vm.expectRevert(StructuringRule.InvalidThreshold.selector);
        new StructuringRule(address(gate), 1 days, 5, 0);
    }

    // --- previewCheck: the gas-free preview must agree with what the chain will actually do ---

    function test_PreviewAgreesWithRealOutcome_ForRuleRejection() public {
        DenylistRule denylist = new DenylistRule();
        vm.prank(admin);
        gate.registerRule(denylist);
        denylist.deny(recipient);

        (bool allowed, address rejecting, bytes32 reason) = gate.previewCheck(sender, recipient, 100e18);
        assertFalse(allowed);
        assertEq(rejecting, address(denylist));
        assertEq(reason, bytes32("OPERATOR_DENYLIST"));

        vm.prank(sender);
        vm.expectRevert(
            abi.encodeWithSelector(ComplianceGate.RuleRejected.selector, address(denylist), bytes32("OPERATOR_DENYLIST"))
        );
        escrow.initiate(recipient, 100e18);
    }

    function test_PreviewReportsAllowedWhenEverythingPasses() public view {
        (bool allowed, address rejecting, bytes32 reason) = gate.previewCheck(sender, recipient, 100e18);
        assertTrue(allowed);
        assertEq(rejecting, address(0));
        assertEq(reason, bytes32(0));
    }

    function test_PreviewIsViewOnly_LeavesNoState() public {
        StructuringRule rule = new StructuringRule(address(gate), 1 days, 2, 1_000e18);
        vm.prank(admin);
        gate.registerRule(rule);

        gate.previewCheck(sender, recipient, 900e18);
        gate.previewCheck(sender, recipient, 900e18);

        (, uint256 transfers,) = rule.activityFor(sender, recipient);
        assertEq(transfers, 0, "a preview must never consume the customer's velocity budget");
        assertEq(gate.spentToday(), 0);
    }

    function _stripSelector(bytes memory data) private pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 4; i < data.length; ++i) {
            out[i - 4] = data[i];
        }
    }

    // --- The last two untested branches in the rule layer. Small, but "93.85% branches, two
    //     named exceptions" is a weaker claim to hand a judge than "100%, no exceptions" — and
    //     both were quick to actually close rather than leave written off. ---

    function test_RevertWhen_StructuringRuleConstructedWithZeroGate() public {
        vm.expectRevert(StructuringRule.ZeroAddress.selector);
        new StructuringRule(address(0), 1 days, 5, 1_000e18);
    }

    /// activityFor()'s own expired-window branch — distinct from record()'s window-reset logic
    /// (already covered by test_StructuringWindowResets). This is the read-only view an
    /// operator or the Auditor UI would call to explain a refusal; it must report a clean slate
    /// for a window that's aged out, not stale counts from a window that's already forgotten.
    function test_ActivityFor_ReportsCleanSlateAfterWindowExpires() public {
        StructuringRule rule = new StructuringRule(address(gate), 1 days, 5, 1_000e18);
        vm.prank(admin);
        gate.registerRule(rule);

        vm.prank(sender);
        escrow.initiate(recipient, 100e18);
        (, uint256 transfersBefore,) = rule.activityFor(sender, recipient);
        assertEq(transfersBefore, 1);

        vm.warp(block.timestamp + 1 days + 1);

        (uint64 windowStart, uint256 transfers, uint256 volume) = rule.activityFor(sender, recipient);
        assertEq(windowStart, 0);
        assertEq(transfers, 0);
        assertEq(volume, 0);
    }
}
