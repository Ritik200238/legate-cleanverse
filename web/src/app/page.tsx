import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FUNNEL_STEPS } from "@/lib/funnel-steps";

/**
 * The entry to the walkthrough, not a directory of features.
 *
 * The person most likely to open this has no wallet, no testnet funds, and no A-Pass — they
 * are evaluating, not remitting. A grid of four equal cards makes that person choose a
 * starting point before they know what any of it does, and then drops them into a form they
 * cannot complete. So: the claim first, the mechanism second, one primary path third, and an
 * explicit wallet-free route for anyone who just wants to check the work.
 */
export default function Home() {
  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-5">
        <Badge variant="outline" className="self-start font-normal">
          Cleanverse Build: Trusted Assets · Track 02 · Monad testnet
        </Badge>
        <h1 className="text-4xl font-semibold tracking-tight leading-tight max-w-3xl">
          Compliance runs <span className="text-primary">before</span> the payment exists.
        </h1>
        <p className="max-w-2xl text-muted-foreground leading-relaxed">
          Legate is a cross-border payment rail where identity and asset provenance are
          preconditions to settlement, not paperwork filed afterwards. Every payment clears
          Cleanverse&apos;s real on-chain validator for <strong>both</strong> parties before any
          value moves — and again before it settles, so a revocation reaches money already in
          flight. Humans use this app; AI agents use the same contracts.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/send"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Start the walkthrough →
          </Link>
          <Link
            href="/auditor"
            className="inline-flex items-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm hover:bg-secondary transition-colors"
          >
            No wallet? Verify a payment instead
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Four steps, about three minutes. The last one needs no wallet at all.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Three enforcement layers, each owned by whoever is accountable for it
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              n: "1",
              q: "Who is this?",
              owner: "Cleanverse",
              body: "Both parties must clear the real on-chain validator. Legate keeps no identity list of its own.",
            },
            {
              n: "2",
              q: "How much, how often?",
              owner: "Legate",
              body: "Per-transaction and rolling daily corridor caps — the time-based limits a static rule cannot express.",
            },
            {
              n: "3",
              q: "Whatever the licence demands",
              owner: "The operator",
              body: "Operators register their own policy on-chain. Legate ships smurfing detection to prove the extension point is real.",
            },
          ].map((layer) => (
            <Card key={layer.n} className="h-full">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-primary/60 text-primary text-[11px]">
                    {layer.n}
                  </span>
                  <CardTitle className="text-base">{layer.q}</CardTitle>
                </div>
                <CardDescription className="text-xs uppercase tracking-wide pt-1">
                  owned by {layer.owner}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{layer.body}</CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          The walkthrough
        </h2>
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {FUNNEL_STEPS.map((step, i) => (
            <Link
              key={step.href}
              href={step.href}
              className="flex items-start gap-4 p-4 hover:bg-secondary/40 transition-colors group"
            >
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 text-xs text-muted-foreground group-hover:border-primary group-hover:text-primary transition-colors">
                {i + 1}
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{step.label}</span>
                <span className="text-sm text-muted-foreground">{step.proves}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="text-sm text-muted-foreground border-t border-border pt-6 flex flex-col gap-2">
        <p>
          <strong className="text-foreground">Nothing here is staged.</strong> Every refusal you
          see is a real contract revert, decoded from its actual revert data. Every A-Pass lookup
          is a live call to Cleanverse&apos;s sandbox. Where something could not be made real, it
          says so on screen rather than pretending.
        </p>
        <p>
          Reading the code instead?{" "}
          <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
            bash demo/run-demo.sh
          </code>{" "}
          runs all four scenes against real contracts in about forty seconds — no wallet, no
          credentials, no testnet funds.
        </p>
      </section>
    </div>
  );
}
