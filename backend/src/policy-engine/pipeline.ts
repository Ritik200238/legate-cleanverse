import type { CleanverseConfig } from "../cleanverse/client.js";
import { queryApass, validatorVerify, validatorIsPaused, CleanverseApiError } from "../cleanverse/client.js";

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
    | "POOL_NOT_VERIFIABLE";
  senderStatus?: { tier: string; group: string; status: 1 | 2 };
  recipientStatus?: { tier: string; group: string; status: 1 | 2 };
}

export interface PreviewArgs {
  chain: string;
  pool: string; // the registered validator pool address (LegateEscrow's address)
  sender: string;
  recipient: string;
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

  return {
    allowed: true,
    senderStatus: { tier: senderApass.tier, group: senderApass.group, status: senderApass.status },
    recipientStatus: { tier: recipientApass.tier, group: recipientApass.group, status: recipientApass.status },
  };
}
