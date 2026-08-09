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
///   DEPLOYER_PRIVATE_KEY=0x... forge script script/DeployMonadTestnet.s.sol:DeployMonadTestnet \
///     --rpc-url https://testnet-rpc.monad.xyz --broadcast --verify -vvvv
///   (the deployer wallet needs real MON for gas — fund via faucet.monad.xyz first)
contract DeployMonadTestnet is Script {
    // Real Monad testnet addresses, re-verified live 2026-08-08 (see PRD.md §5.1, DECISIONS.md).
    // NOTE: this aUSDC address is NOT the one in Cleanverse's published docs — they redeployed
    // the Monad A-Token, and the docs snapshot is stale. Verified by calling the real
    // query_deposit_atoken_list({chain:"monad"}) and then confirming symbol()/decimals()
    // directly against Monad RPC. Do not "correct" this back to the docs' address.
    address constant A_TOKEN = 0xfA96De5B8F434c26FdFf953303dD66fF80af1026; // aUSDC — the only asset LegateEscrow accepts
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

        uint8 decimals = IERC20Metadata(A_TOKEN).decimals();
        uint256 unit = 10 ** decimals;
        uint256 perTxCap = PER_TX_CAP_WHOLE * unit;
        uint256 dailyCorridorCap = DAILY_CORRIDOR_CAP_WHOLE * unit;
        console.log("aUSDC decimals read live from the token:", decimals);

        vm.startBroadcast(deployerKey);

        LegateEscrow escrow = new LegateEscrow(A_TOKEN, deployer);

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
        console.log("aToken (real Cleanverse aUSDC):", A_TOKEN);
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
