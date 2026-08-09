import { defineChain } from "viem";

/**
 * Monad testnet, as actually verified live during this project (DECISIONS.md) — the docs'
 * stated rpc.testnet.monad.xyz does not respond; testnet-rpc.monad.xyz does, confirmed via a
 * real eth_chainId call returning 0x279f (10143), matching the documented chain ID.
 */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
});

/** Local Anvil chain, used when NEXT_PUBLIC_CHAIN_MODE=local for development/demo against the
 *  reproducible local deployment (contracts/script/DeployLocal.s.sol). If
 *  NEXT_PUBLIC_MONAD_RPC_URL is unset, the browser talks to it via the same-origin "/rpc"
 *  proxy (next.config.ts) to backend/test/browser-relay.ts — used when this app is reached
 *  through a tunnel that can't reach a bare localhost port directly. Server-side code (the
 *  receipt page) never constructs this chain's RPC calls itself, so a relative URL is safe
 *  here despite the general server/browser split in lib/api.ts. */
export const anvilLocal = defineChain({
  id: 31337,
  name: "Anvil Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_MONAD_RPC_URL || "/rpc"] } },
  testnet: true,
});

export const activeChain = process.env.NEXT_PUBLIC_CHAIN_MODE === "local" ? anvilLocal : monadTestnet;

export const CONTRACTS = {
  aToken: (process.env.NEXT_PUBLIC_ATOKEN_ADDRESS ?? "") as `0x${string}`,
  legateEscrow: (process.env.NEXT_PUBLIC_LEGATE_ESCROW_ADDRESS ?? "") as `0x${string}`,
  agentMandate: (process.env.NEXT_PUBLIC_AGENT_MANDATE_ADDRESS ?? "") as `0x${string}`,
  travelRuleAnchor: (process.env.NEXT_PUBLIC_TRAVEL_RULE_ANCHOR_ADDRESS ?? "") as `0x${string}`,
};

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4021";

// --- ABIs, hand-matched to the real deployed Solidity signatures (contracts/src/*.sol) ---
// Kept minimal — exactly the functions/errors this frontend actually calls or decodes.

export const ATOKEN_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const LEGATE_ESCROW_ABI = [
  {
    type: "function",
    name: "initiate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "paymentId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaimExpired",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "CLAIM_WINDOW",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "getPayment",
    stateMutability: "view",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "state", type: "uint8" },
          { name: "createdAt", type: "uint64" },
          { name: "settledAt", type: "uint64" },
          { name: "claimDeadline", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "PaymentEscrowed",
    inputs: [
      { name: "paymentId", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "NotCompliantAtSettlement", inputs: [] },
  { type: "error", name: "NotPaymentSender", inputs: [] },
  { type: "error", name: "ClaimWindowNotExpired", inputs: [{ name: "deadline", type: "uint64" }] },
  {
    type: "error",
    name: "InvalidState",
    inputs: [
      { name: "expected", type: "uint8" },
      { name: "actual", type: "uint8" },
    ],
  },
  // ComplianceGate.checkAndRecord() reverts surface through initiate()/settleFromMandate() —
  // decoded here since the frontend calls initiate() directly with the user's own wallet.
  { type: "error", name: "SenderNotCompliant", inputs: [{ name: "sender", type: "address" }] },
  { type: "error", name: "RecipientNotCompliant", inputs: [{ name: "recipient", type: "address" }] },
  {
    type: "error",
    name: "PerTxCapExceeded",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "DailyCorridorCapExceeded",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "remaining", type: "uint256" },
    ],
  },
] as const;

export const AGENT_MANDATE_ABI = [
  {
    type: "function",
    name: "createMandate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "perTxCap", type: "uint256" },
      { name: "dailyCap", type: "uint256" },
      { name: "totalCap", type: "uint256" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeMandate",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
  {
    type: "event",
    name: "MandateCreated",
    inputs: [
      { name: "agent", type: "address", indexed: true },
      { name: "principal", type: "address", indexed: true },
      { name: "perTxCap", type: "uint256", indexed: false },
      { name: "dailyCap", type: "uint256", indexed: false },
      { name: "totalCap", type: "uint256", indexed: false },
      { name: "expiry", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MandateExecuted",
    inputs: [
      { name: "agent", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "paymentId", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MandateRevokedEvt",
    inputs: [
      { name: "agent", type: "address", indexed: true },
      { name: "principal", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "MandateSuspended",
    inputs: [{ name: "agent", type: "address", indexed: true }],
  },
  {
    type: "function",
    name: "getMandate",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "principal", type: "address" },
          { name: "perTxCap", type: "uint256" },
          { name: "dailyCap", type: "uint256" },
          { name: "totalCap", type: "uint256" },
          { name: "spentToday", type: "uint256" },
          { name: "spentTotal", type: "uint256" },
          { name: "dayWindowStart", type: "uint64" },
          { name: "expiry", type: "uint64" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  { type: "error", name: "PrincipalNotCompliant", inputs: [{ name: "principal", type: "address" }] },
  // Real, previously-missing gap: revokeMandate()'s only possible error wasn't in this ABI,
  // so decodeContractError couldn't name it and fell back to viem's generic message — see
  // DECISIONS.md.
  { type: "error", name: "NotMandatePrincipal", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ExpiryInPast", inputs: [] },
  {
    type: "error",
    name: "AgentAlreadyMandated",
    inputs: [
      { name: "agent", type: "address" },
      { name: "currentPrincipal", type: "address" },
    ],
  },
] as const;

/** Human-readable messages for every custom error this frontend can decode from a real
 *  revert — surfaced verbatim in the UI so a refusal always names the real on-chain reason,
 *  never a generic "transaction failed." */
export const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  ZeroAmount: "Amount must be greater than zero.",
  NotCompliantAtSettlement: "One of the parties lost compliance status since this payment was escrowed — refused at settlement, funds remain safely escrowed.",
  InvalidState: "This payment is not in a state that allows this action (already settled, frozen, or refunded).",
  NotPaymentSender: "Only the wallet that originally sent this payment can reclaim it.",
  ClaimWindowNotExpired: "The claim window hasn't closed yet — the recipient still has time to claim. You can reclaim after it expires.",
  SenderNotCompliant: "Your wallet does not currently pass Cleanverse's on-chain compliance check for this corridor.",
  RecipientNotCompliant: "The recipient does not currently pass Cleanverse's on-chain compliance check for this corridor.",
  PerTxCapExceeded: "This amount exceeds Legate's per-transaction cap for this corridor.",
  DailyCorridorCapExceeded: "This amount would exceed Legate's daily corridor volume cap.",
  PrincipalNotCompliant: "The mandate's principal wallet does not currently pass compliance — mandate actions are blocked until it does.",
  NotMandatePrincipal: "Only the principal who created this mandate can revoke it.",
  ZeroAddress: "A required address was left empty.",
  ExpiryInPast: "The mandate's expiry must be in the future.",
  AgentAlreadyMandated: "This agent already has an active mandate from a different principal — only that principal can update or revoke it.",
};
