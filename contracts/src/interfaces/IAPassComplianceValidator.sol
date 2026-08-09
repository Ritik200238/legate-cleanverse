// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAPassComplianceValidator
/// @notice Interface to Cleanverse's real, deployed on-chain compliance validator.
/// @dev Signatures taken verbatim from Cleanverse's "Compliance Protocol (CCP) Integration
///      Guide (For CVI Compliance Validator) V2" PDF — not guessed. Deployed instance used
///      by Legate: 0xaC7e5179C2C7f03f209136886c172eb34F161792 (see PRD.md §5.1; chain scope
///      of this address is an open [RECON] item as of this writing).
///
///      Rule configuration (registerV2 / setRuleV2FromContract / etc.) is intentionally NOT
///      called directly through this interface by Legate's contracts. The REST API
///      (POST /validator/grant, POST /validator/register) is Cleanverse's documented path
///      for setting up a pool's rule from a plain `countries: string[]` + `is_black_list`
///      array — the bitmap encoding for `poolCountryBitmap` is undocumented anywhere in the
///      3577-line API reference, so Legate never constructs a RuleV2 struct itself. Only the
///      read-only `complianceVerify` call is used directly, on-chain, by Legate's contracts.
interface IAPassComplianceValidator {
    struct RuleV2 {
        bytes2 allowedGroup; // empty = no restriction
        bytes2 allowedSubGroup; // empty = no restriction
        uint8 minTier; // 0 = no restriction
        uint8 minSubTier; // 0 = no restriction
        uint256 poolCountryBitmap; // 0 = no restriction; encoding undocumented, never constructed by Legate
    }

    // --- Registration (REGISTER_ROLE) — not called directly by Legate; see note above ---
    function registerV2(address poolAddress, RuleV2 calldata rule) external;
    function registerApass(address poolAddress, address aTokenAddress) external;
    function registerApass(address poolAddress, address aTokenAddress, address feeAddress) external;
    function setRuleV2FromRegistrar(address poolAddress, RuleV2 calldata rule) external;
    function isRegistered(address poolAddress) external view returns (bool);

    // --- Rule management (business contract itself) — not called directly by Legate ---
    function setRuleV2FromContract(RuleV2 calldata rule) external;
    function addRuleV2FromContract(RuleV2 calldata rule) external;
    function removeRuleV2FromContract(uint256 index) external;
    function getRulesV2(address poolAddress) external view returns (RuleV2[] memory);

    /// @notice The one function Legate's contracts actually call, on-chain, per payment.
    /// @dev Public, no permission required, synchronous. Returns whether `userAddress` is
    ///      currently compliant against the rule registered for `poolAddress`.
    function complianceVerify(address poolAddress, address userAddress) external view returns (bool);
}
