// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IComplianceRule
/// @notice The extension point for compliance policy Legate does not — and should not — try
///         to anticipate.
///
///         The division of labour in this system has three layers, not two. Cleanverse's
///         validator answers *who is this*. `ComplianceGate` answers *how much, how often*,
///         corridor-wide. Neither can answer the questions a specific licensed operator is
///         obliged to answer under their own licence: their internal denylist, their
///         jurisdiction's structuring thresholds, their correspondent bank's exposure limits.
///
///         Those belong to the operator, so this interface hands them the pen. A rule is a
///         separate contract, registered against a `ComplianceGate` by its admin, consulted
///         on every payment, and able to veto. It requires no fork of the escrow, no upgrade
///         of the gate, and no change to anything already audited.
///
///         Modelled on Safe's module/guard split, which is the proven pattern for programmable
///         control over other people's money — Safe secured ~$27B in Q2 2026 not by shipping
///         every policy anyone might want, but by making the extension point public so third
///         parties could ship them instead.
///
/// @dev    Split into `check` (view, decides) and `record` (mutating, remembers) for the same
///         reason `ComplianceGate` itself is: a rule that must be consulted before funds move
///         has to be callable from a view context, and a rule that tracks velocity has to
///         persist state — but only *after* the whole payment is known to be allowed. Merging
///         them would let a rule that rejects still mutate state, so a blocked payment would
///         silently count toward a later one's limit.
interface IComplianceRule {
    /// @notice Decide whether this payment may proceed. MUST NOT modify state.
    /// @return allowed False vetoes the payment. The gate reverts; no other rule's `record`
    ///         runs, and no corridor volume is recorded.
    /// @return reason  Short machine-readable code surfaced in the revert (and therefore in
    ///         x402 / MCP refusals). Empty when allowed. Use a bytes32 literal such as
    ///         "STRUCTURING_SUSPECTED" — a string would cost more gas on a path every single
    ///         payment traverses.
    function check(address sender, address recipient, uint256 amount)
        external
        view
        returns (bool allowed, bytes32 reason);

    /// @notice Persist whatever this rule needs to remember about an ALLOWED payment.
    ///         Called by the gate only after every rule has approved. Implementations MUST
    ///         restrict this to their gate — an unrestricted `record` lets anyone poison a
    ///         velocity window and deny service to a legitimate sender.
    function record(address sender, address recipient, uint256 amount) external;

    /// @notice Human-readable identifier, for audit output and the Auditor view.
    function name() external view returns (string memory);
}
