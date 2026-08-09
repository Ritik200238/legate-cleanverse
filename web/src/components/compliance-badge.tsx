import { Badge } from "@/components/ui/badge";
import { shortAddress } from "@/lib/format";
import type { CompliancePreview } from "@/lib/api";

/**
 * The preview covers three enforcement layers, and the labels say which one refused. A user
 * told only "blocked" cannot tell whether to fix their KYC, wait until tomorrow, send less, or
 * call their provider — and those are four completely different actions.
 */
const REASON_LABELS: Record<string, string> = {
  // Layer 1 — Cleanverse: who are these parties?
  SENDER_NOT_COMPLIANT: "Sender is not compliant for this corridor",
  RECIPIENT_NOT_COMPLIANT: "Recipient is not compliant for this corridor",
  SENDER_APASS_MISSING: "Sender has no A-Pass on file",
  RECIPIENT_APASS_MISSING: "Recipient has no A-Pass on file",
  POOL_PAUSED: "Legate's compliance pool is currently paused",
  POOL_NOT_VERIFIABLE: "Legate's pool is not yet registered on the real Cleanverse validator",
  // Layer 2 — Legate: how much, how often?
  PER_TX_CAP_EXCEEDED: "Over the per-transaction cap for this corridor — send a smaller amount",
  DAILY_CAP_EXCEEDED: "The corridor's daily volume cap is exhausted — this resets at 00:00 UTC",
  // Layer 3 — the operator's own registered policy.
  OPERATOR_RULE_REJECTED: "Refused by a compliance rule this corridor's operator registered",
};

/** Reason codes that come from a rule module rather than from Legate or Cleanverse. */
const RULE_CODE_LABELS: Record<string, string> = {
  STRUCTURING_SUSPECTED:
    "This looks like structuring — repeated transfers to the same recipient that together cross a reporting threshold.",
  OPERATOR_DENYLIST: "This counterparty is on the operator's internal denylist.",
};

export function ComplianceBadge({ preview }: { preview: CompliancePreview | null | undefined }) {
  if (!preview) return <Badge variant="outline">Not checked</Badge>;
  if (preview.allowed) {
    return (
      <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/40 hover:bg-emerald-600/20">
        3/3 layers passed
      </Badge>
    );
  }

  const rejected = preview.rejectedBy;
  return (
    <div className="flex flex-col gap-1 items-start">
      <Badge variant="destructive">Blocked</Badge>
      <span className="text-xs text-muted-foreground">
        {REASON_LABELS[preview.reason ?? ""] ?? preview.reason ?? "Unknown reason"}
      </span>
      {rejected && (
        <span className="text-xs text-muted-foreground">
          {RULE_CODE_LABELS[rejected.code] ?? rejected.code}{" "}
          <span className="font-mono opacity-70">({shortAddress(rejected.rule)})</span>
        </span>
      )}
    </div>
  );
}
