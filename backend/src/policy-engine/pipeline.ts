import { Contract, JsonRpcProvider, decodeBytes32String } from "ethers";
import type { CleanverseConfig } from "../cleanverse/client.js";
import { queryApass, validatorVerify, validatorIsPaused, CleanverseApiError } from "../cleanverse/client.js";
import { COMPLIANCE_GATE_ABI, LEGATE_ESCROW_ABI } from "../chain/contracts.js";

/**
 * Pre-transaction preview pipeline — PRD.md §5.2. This is a GAS-FREE PREVIEW of what the
 * on-chain contracts (ComplianceGate.checkAndRecord, LegateEscrow.settle) will independently
 * re-verify themselves. It exists purely for UX (fail fast, don't waste gas on a doomed
 * transaction) — it is never trusted blindly by the contracts, which re-derive everything on
 * their own. See PRD.md §3's note on why there's no attestation-signing step.
 */

export interface PreviewResult {
  allowed: boolean;
  reason?:
    | "SENDER_NOT_COMPLIANT"
    | "RECIPIENT_NOT_COMPLIANT"
    | "POOL_PAUSED"
    | "SENDER_APASS_MISSING"
    | "RECIPIENT_APASS_MISSING"
    | "POOL_NOT_VERIFIABLE"
    | "PER_TX_CAP_EXCEEDED"
    | "DAILY_CAP_EXCEEDED"
    | "OPERATOR_RULE_REJECTED";
  senderStatus?: { tier: string; group: string; status: 1 | 2 };
  recipientStatus?: { tier: string; group: string; status: 1 | 2 };
  /** Set when an operator rule module vetoed — the rule's address and its own reason code. */
  rejectedBy?: { rule: string; code: string };
}

export interface PreviewArgs {
  chain: string;
  pool: string; // the registered validator pool address (LegateEscrow's address)
  sender: string;
  recipient: string;
  /**
   * Supplying this makes the preview complete rather than partial. Without it the preview only
   * reflects what Cleanverse's REST layer knows about identity — so a payment could clear the
   * preview and then be refused on-chain by a corridor cap or an operator rule, which is the
   * one thing a preview must never do. Optional because identity-only previews are still
   * useful before a deployment exists (e.g. the recipient-lookup path, which has no amount).
   */
  onChain?: { rpcUrl: string; escrowAddress: string; amountBaseUnits: bigint };
}

export async function previewCompliance(config: CleanverseConfig, args: PreviewArgs): Promise<PreviewResult> {
  const { chain, pool, sender, recipient } = args;

  // Pre-flight: a paused pool makes validator/verify error out (code 12027) instead of
  // returning a clean valid:true/false — check this first so we surface a specific,
  // actionable reason instead of a confusing downstream error. (CLEANVERSE_API.md, Validator
  // Compliance module.)
  const paused = await validatorIsPaused(config, chain, pool);
  if (paused) {
    return { allowed: false, reason: "POOL_PAUSED" };
  }

  const [senderApass, recipientApass] = await Promise.all([
    queryApass(config, chain, sender),
    queryApass(config, chain, recipient),
  ]);

  if (!senderApass) return { allowed: false, reason: "SENDER_APASS_MISSING" };
  if (!recipientApass) return { allowed: false, reason: "RECIPIENT_APASS_MISSING" };

  // validator/verify throws code 12027 ("Validator on-chain read failed") whenever the chain
  // read can't produce a valid/invalid answer — a paused pool per the docs, but live-verified
  // (2026-08-08) to also cover a pool that was never registered at all. Both are real,
  // expected states (this pool isn't registered on real Monad testnet yet — see PRD.md §8) —
  // surfaced as a specific preview reason, not an uncaught crash.
  let senderValid: { valid: boolean };
  let recipientValid: { valid: boolean };
  try {
    [senderValid, recipientValid] = await Promise.all([
      validatorVerify(config, chain, pool, sender),
      validatorVerify(config, chain, pool, recipient),
    ]);
  } catch (err) {
    if (err instanceof CleanverseApiError && err.code === "12027") {
      return { allowed: false, reason: "POOL_NOT_VERIFIABLE" };
    }
    throw err;
  }

  if (!senderValid.valid) {
    return {
      allowed: false,
      reason: "SENDER_NOT_COMPLIANT",
      senderStatus: { tier: senderApass.tier, group: senderApass.group, status: senderApass.status },
    };
  }
  if (!recipientValid.valid) {
    return {
      allowed: false,
      reason: "RECIPIENT_NOT_COMPLIANT",
      recipientStatus: { tier: recipientApass.tier, group: recipientApass.group, status: recipientApass.status },
    };
  }

  const identity = {
    senderStatus: { tier: senderApass.tier, group: senderApass.group, status: senderApass.status },
    recipientStatus: { tier: recipientApass.tier, group: recipientApass.group, status: recipientApass.status },
  };

  // Layers 2 and 3. Cleanverse answered "who"; only the chain can answer "how much, how often,
  // and does this operator's own policy allow it". Skipping this is what made the preview
  // capable of disagreeing with the contract.
  if (args.onChain) {
    const gateResult = await previewOnChain(args.onChain, sender, recipient);
    if (gateResult) return { ...gateResult, ...identity };
  }

  return { allowed: true, ...identity };
}

/**
 * Runs ComplianceGate.previewCheck — the same three layers checkAndRecord enforces, as a view
 * call. Returns null when the chain says the payment is fine, or a refusal when it isn't.
 *
 * A failure to reach the chain returns null rather than a refusal: an RPC outage must not
 * render every payment "blocked" in the UI, and the contract re-verifies everything on
 * submission regardless — a preview is an optimisation, never the enforcement point.
 */
async function previewOnChain(
  onChain: NonNullable<PreviewArgs["onChain"]>,
  sender: string,
  recipient: string,
): Promise<PreviewResult | null> {
  try {
    const provider = new JsonRpcProvider(onChain.rpcUrl);
    const escrow = new Contract(onChain.escrowAddress, LEGATE_ESCROW_ABI, provider);
    const gateAddress: string = await escrow.complianceGate();
    // Read the gate off the escrow rather than from its own env var: the escrow is the single
    // source of truth for which gate is actually enforcing, so the preview cannot drift from
    // the deployment by way of a stale config value.
    if (!gateAddress || gateAddress === "0x0000000000000000000000000000000000000000") return null;

    const gate = new Contract(gateAddress, COMPLIANCE_GATE_ABI, provider);
    const [allowed, rejectingRule, reason] = await gate.previewCheck(sender, recipient, onChain.amountBaseUnits);
    if (allowed) return null;

    const code = decodeBytes32String(reason);
    if (code === "PER_TX_CAP_EXCEEDED") return { allowed: false, reason: "PER_TX_CAP_EXCEEDED" };
    if (code === "DAILY_CAP_EXCEEDED") return { allowed: false, reason: "DAILY_CAP_EXCEEDED" };
    if (code === "SENDER_NOT_COMPLIANT") return { allowed: false, reason: "SENDER_NOT_COMPLIANT" };
    if (code === "RECIPIENT_NOT_COMPLIANT") return { allowed: false, reason: "RECIPIENT_NOT_COMPLIANT" };
    return { allowed: false, reason: "OPERATOR_RULE_REJECTED", rejectedBy: { rule: rejectingRule, code } };
  } catch {
    return null;
  }
}
