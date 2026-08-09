// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LegateEscrow} from "../src/LegateEscrow.sol";
import {ComplianceGate} from "../src/ComplianceGate.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {CVIRegistryMirror} from "../src/CVIRegistryMirror.sol";
import {TravelRuleAnchor} from "../src/TravelRuleAnchor.sol";
import {MockValidator} from "../test/mocks/MockValidator.sol";
import {MockAToken} from "../test/mocks/MockAToken.sol";

/// @notice Deploys the full Legate stack to a LOCAL anvil chain, with a MockValidator
///         standing in for Cleanverse's real validator (which only exists on real chains).
///         Used to prove the backend/x402/MCP layers work end-to-end against real, deployed
///         contract bytecode — not to claim anything about Cleanverse's real behavior, which
///         was verified separately, live, against the actual sandbox (see DECISIONS.md).
contract DeployLocal is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        MockAToken aToken = new MockAToken();
        MockValidator validator = new MockValidator();

        LegateEscrow escrow = new LegateEscrow(address(aToken), deployer);

        ComplianceGate gate = new ComplianceGate(address(validator), address(escrow), deployer, 10_000e18, 1_000_000e18);
        escrow.setComplianceGate(address(gate));
        gate.grantCaller(address(escrow));

        AgentMandate mandate = new AgentMandate(address(validator), address(escrow), address(escrow), deployer);
        escrow.setMandate(address(mandate));

        CVIRegistryMirror mirror = new CVIRegistryMirror(address(escrow), address(mandate), deployer);
        escrow.setMirror(address(mirror));
        mandate.setMirror(address(mirror));

        TravelRuleAnchor anchorContract = new TravelRuleAnchor(address(escrow), deployer);

        // Optional: grant POLLER_ROLE to the real revocation-poller service's signing key
        // (backend/src/poller/revocation-poller.ts), if the deploying script was given one.
        // Left ungranted by default so existing e2e scripts that don't need the poller are
        // unaffected.
        address pollerAddress = vm.envOr("POLLER_ADDRESS", address(0));
        if (pollerAddress != address(0)) {
            mirror.grantPoller(pollerAddress);
        }

        vm.stopBroadcast();

        console.log("aToken:", address(aToken));
        console.log("validator:", address(validator));
        console.log("escrow:", address(escrow));
        console.log("complianceGate:", address(gate));
        console.log("agentMandate:", address(mandate));
        console.log("registryMirror:", address(mirror));
        console.log("travelRuleAnchor:", address(anchorContract));
        console.log("deployer:", deployer);
    }
}
