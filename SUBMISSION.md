# Legate — one-page summary

**Cleanverse Build: Trusted Assets · Track 02 (DeFi) · Monad testnet**
Team: Chancery Labs · Repo: this repository · Demo: `demo/run-demo.sh`

---

## What it is, in one paragraph

`LegateEscrow` is a **permissioned pool registered with Cleanverse's validator under a real `RuleV2`**. CVI is the protocol's entry condition: both counterparties must clear `complianceVerify()` on-chain before the pool will accept or release anything, and again before it settles. CVA is the only asset it will move. On top of that sits an open extension point — `IComplianceRule` — that lets a licensed operator register policy Legate deliberately does not own.

The use case built on that primitive is a Malaysia↔Philippines remittance corridor, usable by a human through a web app and by an AI agent through **x402** and **MCP**, over the same contracts.

**In July 2026 Uniswap shipped Permissioned Pools — compliance moved into the AMM's execution layer rather than a frontend gate. Legate is that thesis applied to payments, and it adds the agent.**

## The problem

A Malaysian worker sending money home to Manila pays 6–7% and waits days. The correspondent-banking rail that makes it slow is also what makes it compliant — Travel Rule data, sanctions screening, counterparty identity. Stablecoins remove the cost and the delay by removing exactly that layer, which is why no licensed remittance operator can put a customer on one.

The same wall now blocks a second, newer user. AI agents transact — 160M+ transactions a year and climbing — and have no compliant way to hold or move value. The workaround everyone reaches for is a custodial account with a spending limit enforced by a prompt. A prompt is not a control.

Both problems are the same problem: **there is no rail where identity and asset provenance are preconditions to settlement rather than paperwork bolted on afterwards.**

## Three enforcement layers, each owned by whoever is accountable for it

| Layer | Answers | Owned by |
|---|---|---|
| Cleanverse validator | *Who is this?* — identity, tier, sanctions | **Cleanverse.** Legate holds no identity list of its own. |
| `ComplianceGate` | *How much, how often?* — per-transaction and daily corridor caps | Legate |
| `IComplianceRule` modules | *Whatever this operator's licence demands* | **The operator**, registered on-chain, no fork required |

The third layer is the part most compliance products get wrong by owning it. A licensed remittance operator has obligations no protocol author can enumerate in advance. Guessing at them and being wrong is worse than not shipping them; hardcoding one jurisdiction's rules makes the corridor useless everywhere else. So the gate exposes an interface and hands the operator the pen — the same reason Safe secured ~$27B without shipping every policy anyone might want.

Legate ships one such module to prove the extension point is real rather than decorative: **`StructuringRule`**, which detects smurfing — one large transfer split into many small ones to stay under a reporting threshold. Neither other layer can express it. Cleanverse's `RuleV2` is static and answers questions about *parties*, not *patterns across time*. The gate's caps are aggregates, and a pair moving 20 × 500 aUSDC never trips a 10,000 per-transaction cap. That is precisely why structuring defeats threshold controls, and precisely why the extension point has to exist.

## The design choices that matter

**The backend cannot authorise anything.** An earlier version had it issue signed attestations the contracts would trust — cut, because `complianceVerify()` is a public on-chain view the contracts call themselves, and an agent's spend caps are contract storage, not an off-chain promise. A fully compromised Legate backend still cannot cause a non-compliant transfer.

**The agent never holds a key.** `AgentMandate` is Safe's *module* (it can initiate a payment without the principal's key, bounded by caps in storage); `ComplianceGate` is Safe's *guard* (it can only refuse). An agent needs both halves. This beats a prompt-level spending limit not because the code is better, but because the agent cannot reach the ledger except through a contract that counts.

**A freeze is a hold, not a black hole.** Circle — the most widely adopted compliant asset in existence — [froze $12.6M in Zama's contract](https://www.ccn.com/education/crypto/circle-zama-freeze-stablecoin-censorship-resistance/) and separately [froze 16 wallets](https://finance.yahoo.com/markets/crypto/articles/circle-first-froze-16-usdc-085427724.html) tied to a sealed case, catching unrelated businesses whose only recourse was a legal petition. Legate's answer is deliberately *narrow*: a payment sitting unclaimed is recoverable by its sender unilaterally, on-chain, with no admin involved (`reclaimExpired`). A payment **frozen for compliance** is not — a sanctions hold the sanctioned party can reverse is not a hold. What frozen payments get instead is an on-chain reason and a defined refund path, both visible in the Auditor. Recourse where recourse is legitimate; no bypass where it isn't.

**The necessity test.** Remove A-Pass and counterparties are anonymous — an ordinary token bridge. Remove A-Token and the asset carries no provenance or transfer rules. Remove the validator and there is no pre-transaction check and no audit trail. Strip Cleanverse out and Legate isn't degraded; it stops being a compliant rail at all.

## CVI · CVA integration points

| | Where it actually bites |
|---|---|
| **CVI (A-Pass)** | The protocol's **entry condition**, not a login. Both parties must clear `complianceVerify()` at escrow **and again at settlement** — so revocation reaches funds already in flight, with no poller, no admin, and nobody needing to notice in time. Corridor rule pinned to `min_tier: 30`, countries `["MY","PH"]`. |
| **CVA (A-Token)** | The only asset `LegateEscrow` will accept or move. Transfer restrictions are enforced by the token's own on-chain hook, not by our API deciding what to call. |
| **CCP (validator)** | Called directly and synchronously on-chain — no off-chain bridge, no oracle, no attestation to forge. `download_travel_rule` is pulled post-settlement and hash-anchored via `TravelRuleAnchor`, which cross-checks `LegateEscrow`'s real state and refuses to anchor a payment that isn't genuinely settled. |
| **Gateway (Fiat Ramp)** | Real MYR→USDC and USDC→PHP legs, both wired. **Disclosed gap:** the docs list `monad` as a ramp settlement network; live testing proves the sandbox does not route ramp settlement there (`base` succeeds, `monad` fails for every input tried). The fiat legs use the verified-working network and we do not fake the bridge step. |
| **Agent Skill Framework** | Nothing like it exists in Cleanverse's docs, so we built it: `AgentMandate.sol` binds an agent to a principal who must hold a valid A-Pass, with per-transaction / daily / lifetime caps in contract storage. Cap and compliance refusals surface as structured x402 codes decoded from the actual revert. |

**Privacy:** no personal or KYC data ever touches the chain — hashes and references only.

### The one place we are not deep, stated before you find it

Track 02 asks for CVI as *"a protocol entry condition **or** risk parameter."* Legate does the first thoroughly. It does **not** do graduated risk — tier 30 gets one cap, tier 50 gets a larger one.

That is not an oversight, and it is worth being precise about why. `complianceVerify()` returns a bare boolean. There is no per-user tier readable on-chain anywhere. The only ways to get graduated behaviour today are to have our backend assert each user's tier to the contract — which would make a compromised backend able to raise its own limits, destroying the one property this entire design exists to guarantee — or to fabricate a tier in the UI, which is worse.

So we do what the chain can actually prove: tier gates entry at the corridor's `min_tier: 30` threshold, enforced by Cleanverse's own rule rather than by us.

**The architecturally honest route to graduated limits** is multiple pools, each registered with the validator at a different `min_tier` and carrying its own `ComplianceGate` caps — the tier check stays entirely inside Cleanverse's rule engine, and Legate never asserts anything about anyone's identity. That is a deployment-and-registration change, not a contract change, and it is the next thing after the corridor is live.

We would rather show you a real gap with a real plan than a fake tier.

## What's verifiable right now

- **88/88 Foundry tests**, including a real reentrancy attack and a real mandate-hijack exploit, both written as working PoCs before their fixes existed, plus 19 covering the rule layer — the ones worth reading prove that a vetoed payment leaves no residue in corridor volume or any rule's state, and that a rule contract the gate was never compiled against still changes what the corridor refuses.
- **`bash demo/run-demo.sh`** — all four demo scenes end to end in ~40 seconds, no credentials, no testnet funds. Every refusal it prints is asserted against the exact custom-error selector, so a generic failure fails the run rather than passing as a convincing "BLOCKED".
- **Real end-to-end harnesses**, not mocks: real contracts on a real chain, a real MCP client driving the server over real stdio, real HTTP against the real backend.
- **`DECISIONS.md`** — every verified fact with the call that verified it, and every claim that turned out false. Including two places where Cleanverse's published docs disagree with their live sandbox: the phantom Monad ramp support above, and a redeployed Monad A-Token whose decimals moved 6→18, which a live test caught and which would otherwise have shipped a per-transaction cap of 0.00000001 aUSDC.

## Deployed chains

**Monad testnet**, single-chain by design — we claim **CVI, CVA, Gated Pools**, and deliberately not Cross-Chain.

> **Status — stated plainly rather than implied.** The deployment is scripted and verified (`contracts/script/DeployMonadTestnet.s.sol`, `backend/scripts/register-validator.ts`) but is **not yet live**: the deployer wallet is unfunded and Monad's faucet is CAPTCHA-gated. The contracts, the compliance logic, and all four scenes are proven against real bytecode on a real chain today; what is pending is one funding step and the REST registration call that follows it.
>
> Fill in on deploy: `LegateEscrow` `<addr>` · `ComplianceGate` `<addr>` · `AgentMandate` `<addr>` · `CVIRegistryMirror` `<addr>` · `TravelRuleAnchor` `<addr>`
> Receipt permalinks (`/receipt/:paymentId`) become live at the same moment — they are walletless and server-rendered specifically because judging is asynchronous.

**Named, accountable operator.** `ADMIN_ROLE` is a single deployer EOA for this build, migrating to a Safe multisig before any real-money pilot. This is the same shape Maple uses at ~$2.1B TVL — accountable human underwriters rather than the pretence that an algorithm can price trust — and it is stated here rather than discovered later.

## Why this is worth continuing

Remittance is a ~$150B fee pool defended by compliance, not technology. Notabene reached 2,300+ institutions selling compliance *messaging* alone; Legate sells messaging **and** settlement, with a real 50bps fee mechanism working from day one rather than a deferred revenue story.

The agent side is the asymmetric bet. Agent payment volume is growing with no compliant option at all, and the winning primitive there is not a wallet — it is a mandate the agent cannot argue its way past, which is the thing this build already has on-chain.

**The roadmap item that scales this:** asymmetric permissioning. [Aave Horizon](https://aave.com/blog/horizon-built-for-institutions) reached ~$540M in deposits by gating *borrowers and collateral* while leaving *stablecoin supply* open — compliance where regulation demands it, openness where it doesn't, so liquidity never dries up. Legate's version: keep gating the payment counterparties, where the obligation genuinely sits, but let anyone supply settlement liquidity or run a relayer and earn the 50bps. That turns a two-sided compliance problem into a one-sided one, and it is the difference between a corridor and a network.

**We intend to keep building Legate after the hackathon and would like the incubation slot.**
