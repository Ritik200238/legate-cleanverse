// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IComplianceRule} from "../../src/interfaces/IComplianceRule.sol";

/// @notice A rule written by nobody on the Legate team, against nothing but the published
///         interface. Its only job in the suite is to prove the extension point is real:
///         `ComplianceGate` has never heard of this contract, was not modified to accept it,
///         and still consults it on every payment.
contract DenylistRule is IComplianceRule {
    mapping(address => bool) public denied;

    function deny(address who) external {
        denied[who] = true;
    }

    function check(address sender, address recipient, uint256) external view returns (bool, bytes32) {
        if (denied[sender] || denied[recipient]) return (false, "OPERATOR_DENYLIST");
        return (true, bytes32(0));
    }

    function record(address, address, uint256) external {}

    function name() external pure returns (string memory) {
        return "Operator internal denylist";
    }
}

/// @notice Counts how many times `record` was called, so a test can prove the gate does NOT
///         tell rules about a payment that some other rule vetoed.
contract CountingRule is IComplianceRule {
    uint256 public recordCalls;

    function check(address, address, uint256) external pure returns (bool, bytes32) {
        return (true, bytes32(0));
    }

    function record(address, address, uint256) external {
        recordCalls += 1;
    }

    function name() external pure returns (string memory) {
        return "Counting rule (test instrumentation)";
    }
}

/// @notice Always refuses. Models the operator footgun the gate deliberately does not prevent:
///         registering a broken rule halts the corridor, and `unregisterRule` is the recovery.
contract AlwaysRejectRule is IComplianceRule {
    function check(address, address, uint256) external pure returns (bool, bytes32) {
        return (false, "ALWAYS_REJECT");
    }

    function record(address, address, uint256) external {}

    function name() external pure returns (string memory) {
        return "Always reject (test)";
    }
}
