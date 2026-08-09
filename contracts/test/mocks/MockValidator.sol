// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAPassComplianceValidator} from "../../src/interfaces/IAPassComplianceValidator.sol";

/// @notice Test double for Cleanverse's real IAPassComplianceValidator. Lets tests set
///         per-address compliance status directly, simulating A-Pass verification/revocation
///         without needing the live sandbox. The real contract's actual behavior was
///         verified live against the sandbox separately (see DECISIONS.md) — this mock
///         exists only to make LegateEscrow/AgentMandate/ComplianceGate's logic testable
///         in isolation, not to assert anything about Cleanverse's real behavior.
contract MockValidator is IAPassComplianceValidator {
    mapping(address => mapping(address => bool)) public compliant; // pool => user => compliant

    function setCompliant(address pool, address user, bool value) external {
        compliant[pool][user] = value;
    }

    function complianceVerify(address poolAddress, address userAddress) external view override returns (bool) {
        return compliant[poolAddress][userAddress];
    }

    // --- Unused by tests, present only to satisfy the interface ---
    function registerV2(address, RuleV2 calldata) external override {}
    function registerApass(address, address) external override {}
    function registerApass(address, address, address) external override {}
    function setRuleV2FromRegistrar(address, RuleV2 calldata) external override {}
    function isRegistered(address) external pure override returns (bool) {
        return true;
    }
    function setRuleV2FromContract(RuleV2 calldata) external override {}
    function addRuleV2FromContract(RuleV2 calldata) external override {}
    function removeRuleV2FromContract(uint256) external override {}
    function getRulesV2(address) external pure override returns (RuleV2[] memory) {
        return new RuleV2[](0);
    }
}
