// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {MockValidator} from "./mocks/MockValidator.sol";

contract ComplianceGateTest is Test {
    ComplianceGate gate;
    MockValidator validator;

    address admin = makeAddr("admin");
    address caller = makeAddr("caller"); // stands in for LegateEscrow/AgentMandate
    address pool = makeAddr("pool");
    address sender = makeAddr("sender");
    address recipient = makeAddr("recipient");

    uint256 constant PER_TX_CAP = 10_000e18;
    uint256 constant DAILY_CAP = 100_000e18;

    function setUp() public {
        vm.prank(admin);
        gate = new ComplianceGate(address(validator = new MockValidator()), pool, admin, PER_TX_CAP, DAILY_CAP);
        vm.prank(admin);
        gate.grantCaller(caller);

        validator.setCompliant(pool, sender, true);
        validator.setCompliant(pool, recipient, true);
    }

    // --- setLimits() underflow fix (real, proven bug found by adversarial review, see
    //     DECISIONS.md): lowering dailyCorridorCap below the volume already spent today must
    //     still produce the typed DailyCorridorCapExceeded error, not a raw arithmetic-panic
    //     revert — otherwise every downstream consumer of this error (the x402 middleware's
    //     structured-refusal decoding, see chain/contracts.ts) breaks silently in exactly
    //     this admin-action edge case. ---

    function test_LoweringDailyCapBelowSpentToday_StillRevertsWithTypedError() public {
        // Build up spentToday to 60,000e18 across multiple calls, each under PER_TX_CAP
        // (10,000e18) — a single call for the full amount would hit PerTxCapExceeded first
        // and never reach the daily-cap logic this test is actually about.
        vm.startPrank(caller);
        for (uint256 i = 0; i < 6; i++) {
            gate.checkAndRecord(sender, recipient, 10_000e18);
        }
        vm.stopPrank();
        assertEq(gate.spentToday(), 60_000e18);

        vm.prank(admin);
        gate.setLimits(PER_TX_CAP, 10_000e18); // admin cuts the daily cap below what's already spent

        // Must revert with the typed error, remaining clamped to 0 — not a raw Panic(0x11)
        // arithmetic-underflow revert, which is what (dailyCorridorCap - spentToday) alone
        // would produce here (10,000e18 - 60,000e18 underflows).
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ComplianceGate.DailyCorridorCapExceeded.selector, 1e18, 0));
        gate.checkAndRecord(sender, recipient, 1e18);
    }

    function test_HappyPath_CheckAndRecord() public {
        vm.prank(caller);
        gate.checkAndRecord(sender, recipient, 1_000e18);
        assertEq(gate.spentToday(), 1_000e18);
    }

    function test_RevertWhen_ConstructedWithZeroAddress() public {
        vm.expectRevert(ComplianceGate.ZeroAddress.selector);
        new ComplianceGate(address(0), pool, admin, PER_TX_CAP, DAILY_CAP);
    }

    /// @notice foundry.toml configures 512 fuzz runs project-wide; this is the cap-boundary
    ///         logic that most benefits from it — every prior test used hand-picked amounts.
    function testFuzz_PerTxCapBoundary(uint256 amount) public {
        amount = bound(amount, 1, DAILY_CAP);
        vm.prank(caller);
        if (amount > PER_TX_CAP) {
            vm.expectRevert(abi.encodeWithSelector(ComplianceGate.PerTxCapExceeded.selector, amount, PER_TX_CAP));
            gate.checkAndRecord(sender, recipient, amount);
        } else {
            gate.checkAndRecord(sender, recipient, amount);
            assertEq(gate.spentToday(), amount);
        }
    }

    function testFuzz_DailyCapNeverExceededAcrossMultipleCalls(uint8 numCalls, uint256 amountPerCall) public {
        numCalls = uint8(bound(numCalls, 1, 20));
        amountPerCall = bound(amountPerCall, 1, PER_TX_CAP);

        uint256 succeeded;
        vm.startPrank(caller);
        for (uint256 i = 0; i < numCalls; i++) {
            if (gate.spentToday() + amountPerCall > DAILY_CAP) {
                vm.expectRevert(
                    abi.encodeWithSelector(ComplianceGate.DailyCorridorCapExceeded.selector, amountPerCall, DAILY_CAP - gate.spentToday())
                );
                gate.checkAndRecord(sender, recipient, amountPerCall);
            } else {
                gate.checkAndRecord(sender, recipient, amountPerCall);
                succeeded++;
            }
        }
        vm.stopPrank();

        assertEq(gate.spentToday(), succeeded * amountPerCall);
        assertLe(gate.spentToday(), DAILY_CAP, "spentToday must never exceed the configured daily cap");
    }
}
