import { Badge } from "@/components/ui/badge";
import type { CompliancePreview } from "@/lib/api";

const REASON_LABELS: Record<string, string> = {
  SENDER_NOT_COMPLIANT: "Sender is not compliant for this corridor",
  RECIPIENT_NOT_COMPLIANT: "Recipient is not compliant for this corridor",
  POOL_PAUSED: "Legate's compliance pool is currently paused",
  SENDER_APASS_MISSING: "Sender has no A-Pass on file",
  RECIPIENT_APASS_MISSING: "Recipient has no A-Pass on file",
  POOL_NOT_VERIFIABLE: "Legate's pool is not yet registered on the real Cleanverse validator",
};

export function ComplianceBadge({ preview }: { preview: CompliancePreview | null | undefined }) {
  if (!preview) return <Badge variant="outline">Not checked</Badge>;
  if (preview.allowed) {
    return (
      <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/40 hover:bg-emerald-600/20">
        2/2 checks passed
      </Badge>
    );
  }
  return (
    <div className="flex flex-col gap-1 items-start">
      <Badge variant="destructive">Blocked</Badge>
      <span className="text-xs text-muted-foreground">{REASON_LABELS[preview.reason ?? ""] ?? preview.reason ?? "Unknown reason"}</span>
    </div>
  );
}
