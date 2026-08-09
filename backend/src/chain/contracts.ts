import { Contract, type Signer, type Provider } from "ethers";

/**
 * Minimal ABIs — only the functions Legate's backend actually calls, not the full contract
 * interface. Matches the real deployed contract signatures in contracts/src/*.sol exactly
 * (kept in sync manually since this backend doesn't share a build pipeline with Foundry).
 */

export const AGENT_MANDATE_ABI = [
  "function execute(address recipient, uint256 amount) external returns (bytes32 paymentId)",
  "function createMandate(address agent, uint256 perTxCap, uint256 dailyCap, uint256 totalCap, uint64 expiry) external",
  "function revokeMandate(address agent) external",
  "function getMandate(address agent) external view returns (tuple(address principal, uint256 perTxCap, uint256 dailyCap, uint256 totalCap, uint256 spentToday, uint256 spentTotal, uint64 dayWindowStart, uint64 expiry, bool active))",
  "error PrincipalNotCompliant(address principal)",
  "error MandateNotActive()",
  "error MandateHasExpired()",
  "error PerTxCapExceeded(uint256 amount, uint256 cap)",
  "error DailyCapExceeded(uint256 amount, uint256 remaining)",
  "error TotalCapExceeded(uint256 amount, uint256 remaining)",
  "error RecipientNotCompliant(address recipient)",
  "error NotMandatePrincipal()",
  "error ZeroAddress()",
  "error ExpiryInPast()",
  "error AgentAlreadyMandated(address agent, address currentPrincipal)",
  // execute() calls escrow.settleFromMandate() -> complianceGate.checkAndRecord(), which can
  // revert with these two errors too (a real, previously-missing gap: without them here,
  // ethers.Interface.parseError() throws instead of decoding, and mapRevertToRefusalReason()
  // silently mapped that failure to a wrong, specific, invented reason — see DECISIONS.md).
  "error DailyCorridorCapExceeded(uint256 amount, uint256 remaining)",
  "error ZeroAmount()",
  "event MandateExecuted(address indexed agent, address indexed recipient, uint256 amount, bytes32 paymentId)",
  "event MandateCreated(address indexed agent, address indexed principal, uint256 perTxCap, uint256 dailyCap, uint256 totalCap, uint64 expiry)",
  "event MandateRevokedEvt(address indexed agent, address indexed principal)",
  "event MandateSuspended(address indexed agent)",
];

export const LEGATE_ESCROW_ABI = [
  "function initiate(address recipient, uint256 amount) external returns (bytes32 paymentId)",
  "function settle(bytes32 paymentId) external",
  "function reclaimExpired(bytes32 paymentId) external",
  "function getPayment(bytes32 paymentId) external view returns (tuple(address sender, address recipient, uint256 amount, uint8 state, uint64 createdAt, uint64 settledAt, uint64 claimDeadline))",
  "function feeBps() external view returns (uint256)",
  "function aToken() external view returns (address)",
  "function complianceGate() external view returns (address)",
  "function CLAIM_WINDOW() external view returns (uint64)",
  "event PaymentEscrowed(bytes32 indexed paymentId, address indexed sender, address indexed recipient, uint256 amount)",
  "event PaymentSettled(bytes32 indexed paymentId, uint256 amountToRecipient, uint256 fee)",
  "event PaymentRefunded(bytes32 indexed paymentId)",
  "error NotPaymentSender()",
  "error ClaimWindowNotExpired(uint64 deadline)",
  "error InvalidState(uint8 expected, uint8 actual)",
];

/**
 * The gate's own preview. This is what makes the backend's compliance preview honest: without
 * it the preview only knew what Cleanverse's REST layer knows, so a payment could pass the
 * preview and then be refused on-chain by a corridor cap or an operator rule the backend had
 * never heard of. previewCheck runs the exact same three layers checkAndRecord runs, as a
 * view call, and returns rather than reverts so it can name which layer refused.
 */
export const COMPLIANCE_GATE_ABI = [
  "function previewCheck(address sender, address recipient, uint256 amount) external view returns (bool allowed, address rejectingRule, bytes32 reason)",
  "function perTxCap() external view returns (uint256)",
  "function dailyCorridorCap() external view returns (uint256)",
  "function spentToday() external view returns (uint256)",
  "function rules() external view returns (address[])",
  "function ruleCount() external view returns (uint256)",
];

export const COMPLIANCE_RULE_ABI = ["function name() external view returns (string)"];

export const TRAVEL_RULE_ANCHOR_ABI = [
  "function anchor(bytes32 paymentId, bytes32 reportHash, bytes32 settlementTxHash) external",
  "function getAnchor(bytes32 paymentId) external view returns (tuple(bytes32 reportHash, bytes32 settlementTxHash, uint64 anchoredAt))",
  "error AlreadyAnchored(bytes32 paymentId)",
];

export const ATOKEN_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

export function getAgentMandateContract(address: string, signerOrProvider: Signer | Provider): Contract {
  return new Contract(address, AGENT_MANDATE_ABI, signerOrProvider);
}

export function getLegateEscrowContract(address: string, signerOrProvider: Signer | Provider): Contract {
  return new Contract(address, LEGATE_ESCROW_ABI, signerOrProvider);
}

export function getTravelRuleAnchorContract(address: string, signerOrProvider: Signer | Provider): Contract {
  return new Contract(address, TRAVEL_RULE_ANCHOR_ABI, signerOrProvider);
}

/**
 * Maps a revert from AgentMandate.execute() to the exact structured x402 refusal reason
 * codes defined in PRD.md §5.3. Uses ethers' custom-error parsing (Solidity ^0.8.24 custom
 * errors, not string reverts) so the mapping is exact, not a string-matching guess.
 */
export type RefusalReason =
  | "PRINCIPAL_UNVERIFIED"
  | "RECIPIENT_NOT_COMPLIANT"
  | "MANDATE_CAP_EXCEEDED"
  | "MANDATE_EXPIRED"
  | "MANDATE_REVOKED"
  // A real, previously-missing case: every unmapped/undecodable failure used to fall through
  // to RECIPIENT_NOT_COMPLIANT — a specific, invented accusation for what could be a
  // corridor-wide cap hit, a malformed input, an RPC failure, or any other unrelated revert.
  // See DECISIONS.md for the real case (DailyCorridorCapExceeded via the shared
  // ComplianceGate) this was first caught on.
  | "EXECUTION_FAILED";

export function mapRevertToRefusalReason(errorName: string | undefined): RefusalReason {
  switch (errorName) {
    case "PrincipalNotCompliant":
      return "PRINCIPAL_UNVERIFIED";
    case "RecipientNotCompliant":
      return "RECIPIENT_NOT_COMPLIANT";
    case "PerTxCapExceeded":
    case "DailyCapExceeded":
    case "TotalCapExceeded":
    case "DailyCorridorCapExceeded":
      return "MANDATE_CAP_EXCEEDED";
    case "MandateHasExpired":
      return "MANDATE_EXPIRED";
    case "MandateNotActive":
      return "MANDATE_REVOKED";
    default:
      // Genuinely unknown/undecodable failure — reported as such, never guessed at.
      return "EXECUTION_FAILED";
  }
}
