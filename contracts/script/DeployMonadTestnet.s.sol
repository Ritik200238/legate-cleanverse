// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {CVIRegistryMirror} from "../src/CVIRegistryMirror.sol";
import {TravelRuleAnchor} from "../src/TravelRuleAnchor.sol";
import {StructuringRule} from "../src/rules/StructuringRule.sol";

/// @notice Deploys the real Legate stack to real Monad testnet, wired to Cleanverse's real,
///         live-verified contracts — no mocks. Addresses confirmed live via
///         query_deposit_atoken_list({chain:"monad"}) and the real on-chain validator (see
///         PRD.md §5.1 and DECISIONS.md for how each was verified).
///
///         This deploys the pool; it does NOT register it with Cleanverse's validator — that
///         is a REST call (POST /validator/grant, then POST /validator/register), not an
///         on-chain transaction this contract can make itself. Run
///         backend/scripts/register-validator.ts with the deployed LegateEscrow address
///         immediately after this script succeeds.
///
/// Usage (from contracts/, with foundry on PATH):
///   1. RE-VERIFY the A-Token address first — curl the real query_deposit_atoken_list endpoint
///      (chain:"monad") and confirm it against what A_TOKEN_DEFAULT below currently says. It
///      has changed within a single day before; do not skip this.
///   2. DEPLOYER_PRIVATE_KEY=0x... [A_TOKEN_ADDRESS=0x... if it changed] \
///        forge script script/DeployMonadTestnet.s.sol:DeployMonadTestnet \
///        --rpc-url https://testnet-rpc.monad.xyz --broadcast --verify -vvvv
///   (the deployer wallet needs real MON for gas — fund via faucet.monad.xyz first)
contract DeployMonadTestnet is Script {
    // ⚠️  DO NOT TRUST THIS DEFAULT. Cleanverse's own API told us two DIFFERENT addresses were
    //     canonical Monad aUSDC within the same calendar day (2026-08-09): first
    //     0xfA96De5B...af1026 (18 decimals, confirmed live via query_deposit_atoken_list AND
    //     independently via direct Monad RPC decimals()/symbol() reads), then — hours later,
    //     confirmed stable across 3 consecutive calls, and corroborated by verify_apass's
    //     separate internal registry also only recognizing it — back to
    //     0xaC0893567D...1f20D (6 decimals, the ORIGINAL pre-"redeploy" address). See
    //     DECISIONS.md's 2026-08-09 "Cleanverse's own aUSDC address flip-flopped" entry for the
    //     full evidence trail. Both addresses are real, live, deployed ERC-20 contracts on
    //     Monad testnet right now — the ambiguity is which one Cleanverse's own backend
    //     currently treats as canonical, and that has already changed once today.
    //
    //     BEFORE RUNNING THIS SCRIPT FOR REAL: call query_deposit_atoken_list({chain:"monad"})
    //     one more time and pass whatever it currently returns via A_TOKEN_ADDRESS. The default
    //     below is a last-known-value fallback, not a verified-at-this-moment fact.
    address constant A_TOKEN_DEFAULT = 0xaC0893567D43C3E7e6e35a72803df05416C1f20D;
    address constant COMPLIANCE_VALIDATOR = 0xaC7e5179C2C7f03f209136886c172eb34F161792; // IAPassComplianceValidator

    // Corridor limits, in whole aUSDC. Scaled by the token's REAL decimals at deploy time
    // rather than a hardcoded 1e6/1e18 literal — the redeploy above also silently moved aUSDC
    // from 6 decimals to 18, and a hardcoded literal would have set a per-transaction cap of
    // 0.00000001 aUSDC and bricked the corridor on day one. Ask the chain, don't assume.
    uint256 constant PER_TX_CAP_WHOLE = 10_000; // 10,000 aUSDC per transaction
    uint256 constant DAILY_CORRIDOR_CAP_WHOLE = 1_000_000; // 1,000,000 aUSDC per day, corridor-wide

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Override with A_TOKEN_ADDRESS after re-verifying live — see the warning above. This
        // is deliberately NOT a hardcoded constant: the address itself has proven unstable
        // within a single day, and a deploy script that silently trusts a stale value here
        // would point LegateEscrow at a token Cleanverse's own systems may no longer recognize.
        address aToken = vm.envOr("A_TOKEN_ADDRESS", A_TOKEN_DEFAULT);
        console.log("Using A_TOKEN:", aToken);
        console.log("(re-verify this against a fresh query_deposit_atoken_list call if it's been more than a few hours since you read this)");

        uint8 decimals = IERC20Metadata(aToken).decimals();
        uint256 unit = 10 ** decimals;
        uint256 perTxCap = PER_TX_CAP_WHOLE * unit;
        uint256 dailyCorridorCap = DAILY_CORRIDOR_CAP_WHOLE * unit;
        console.log("aUSDC decimals read live from the token:", decimals);

        vm.startBroadcast(deployerKey);

        LegateEscrow escrow = new LegateEscrow(aToken, deployer);

        ComplianceGate gate = new ComplianceGate(COMPLIANCE_VALIDATOR, address(escrow), deployer, perTxCap, dailyCorridorCap);
        escrow.setComplianceGate(address(gate));
        gate.grantCaller(address(escrow));

        AgentMandate mandate = new AgentMandate(COMPLIANCE_VALIDATOR, address(escrow), address(escrow), deployer);
        escrow.setMandate(address(mandate));

        CVIRegistryMirror mirror = new CVIRegistryMirror(address(escrow), address(mandate), deployer);
        escrow.setMirror(address(mirror));
        mandate.setMirror(address(mirror));

        TravelRuleAnchor anchorContract = new TravelRuleAnchor(address(escrow), deployer);

        // Layer 3: the operator's own policy, registered rather than hardcoded. Structuring
        // detection ships as the default corridor rule because it is the pattern a MY->PH
        // remittance corridor is most likely to be abused for, and because neither of the
        // other two layers can express it — Cleanverse's RuleV2 is static, and the gate's caps
        // are aggregates that many-small-transfers is specifically designed to slip under.
        //
        // Thresholds: more than 6 transfers between the same pair, in one rolling day,
        // cumulatively at or above 5,000 aUSDC. Both conditions must hold — a family sending
        // weekly grocery money trips neither, a smurfing pattern trips both.
        //
        // Deliberately NOT registered in DeployLocal: the local script backs the end-to-end
        // test suite, and a stateful velocity rule would make those runs order-dependent.
        // The rule has its own dedicated suite (test/ComplianceRules.t.sol) instead.
        StructuringRule structuringRule = new StructuringRule(address(gate), 1 days, 6, 5_000 * unit);
        gate.registerRule(structuringRule);

        // Optional: grant POLLER_ROLE to the real revocation-poller service's signing key
        // (backend/src/poller/revocation-poller.ts). Left ungranted if not supplied.
        address pollerAddress = vm.envOr("POLLER_ADDRESS", address(0));
        if (pollerAddress != address(0)) {
            mirror.grantPoller(pollerAddress);
        }

        vm.stopBroadcast();

        console.log("=== Legate deployed to Monad testnet ===");
        console.log("aToken (real Cleanverse aUSDC):", aToken);
        console.log("perTxCap (base units):", perTxCap);
        console.log("dailyCorridorCap (base units):", dailyCorridorCap);
        console.log("complianceValidator (real Cleanverse):", COMPLIANCE_VALIDATOR);
        console.log("escrow:", address(escrow));
        console.log("complianceGate:", address(gate));
        console.log("agentMandate:", address(mandate));
        console.log("registryMirror:", address(mirror));
        console.log("travelRuleAnchor:", address(anchorContract));
        console.log("structuringRule (registered operator policy):", address(structuringRule));
        console.log("deployer:", deployer);
        console.log("");
        console.log("NEXT STEP (not done by this script): register 'escrow' as a validator pool");
        console.log("via backend/scripts/register-validator.ts -- LegateEscrow.complianceVerify()");
        console.log("calls will revert with code 12027 until that real REST call completes.");
    }
}
