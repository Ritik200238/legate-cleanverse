import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const VIEWS = [
  {
    href: "/send",
    title: "Send",
    description: "Look up a recipient's real A-Pass, get a live compliance preview and fee quote, fund via the real Fiat Ramp, and escrow a payment on-chain.",
  },
  {
    href: "/claim",
    title: "Claim / Receive",
    description: "Verify your own A-Pass, claim escrowed funds from LegateEscrow, and cash out via the real Fiat Ramp.",
  },
  {
    href: "/agent",
    title: "Agent Console",
    description: "Create and revoke on-chain spend mandates for an AI agent wallet — caps, expiry, and live activity, all enforced by AgentMandate.sol.",
  },
  {
    href: "/auditor",
    title: "Auditor",
    description: "Look up any payment by ID: on-chain state, the real Cleanverse Travel Rule report, and its on-chain hash anchor.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          Legate
        </h1>
        <p className="max-w-2xl text-muted-foreground leading-relaxed">
          A compliant cross-border stablecoin payment rail for humans and AI agents. Every
          payment clears a real, on-chain check against Cleanverse&apos;s{" "}
          <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">IAPassComplianceValidator</code>{" "}
          on Monad — the rail stays open, every payment independently proves it&apos;s clean.
          Malaysia &harr; Philippines corridor.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {VIEWS.map((view) => (
          <Link key={view.href} href={view.href}>
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader>
                <CardTitle>{view.title}</CardTitle>
                <CardDescription>{view.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </section>
    </div>
  );
}
