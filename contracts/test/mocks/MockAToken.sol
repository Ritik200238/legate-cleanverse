// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test double for the real aUSDC A-Token on Monad testnet — see PRD.md §5.1 for which
///         address that currently is (unsettled as of 2026-08-09; Cleanverse's own API
///         returned two different addresses within a single day, see DECISIONS.md). A standard
///         ERC-20 for test purposes: the real A-Token's compliance-hook behavior on transfer is
///         Cleanverse's internal implementation, not something Legate can replicate exactly in
///         a mock — Legate's own on-chain complianceVerify() checks (in ComplianceGate) are
///         what Legate's tests actually exercise, matching the "two independent enforcement
///         points" design in PRD.md §5.1.
contract MockAToken is ERC20 {
    constructor() ERC20("Mock aUSDC", "aUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev 18, matching the real token. It was 6 until Cleanverse redeployed Monad's aUSDC
    ///      (found 2026-08-08 — see DECISIONS.md). Kept faithful to reality on purpose: a mock
    ///      that quietly disagrees with the asset it stands in for is how decimal bugs reach
    ///      production having passed every test.
    function decimals() public pure override returns (uint8) {
        return 18;
    }
}
