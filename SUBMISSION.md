# Legate — one-page summary

**Cleanverse Build: Trusted Assets · Track 02 (DeFi) · Monad testnet**
Team: Chancery Labs · Repo: this repository · Demo: `demo/run-demo.sh`

---

## The problem

A Malaysian worker sending money home to Manila pays 6–7% and waits days. The correspondent-banking rail that makes it slow is also what makes it compliant — Travel Rule data, sanctions screening, counterparty identity. Stablecoins remove the cost and the delay by removing exactly that layer, which is why no licensed remittance operator can put a customer on one.

The same wall now blocks a second, newer user. AI agents transact — 160M+ transactions a year and climbing — and have no compliant way to hold or move value. The workaround everyone reaches for is a custodial account with a spending limit enforced by a prompt. A prompt is not a control.

Both problems are the same problem: **there is no rail where identity and asset provenance are preconditions to settlement rather than paperwork bolted on afterwards.**

## The solution

Legate is a cross-border stablecoin payment rail where compliance is a precondition, enforced on-chain, for humans and AI agents through the same contracts.

Every payment independently clears Cleanverse's real on-chain `IAPassComplianceValidator` for **both** parties before any value moves, moves exclusively in Cleanverse's compliance-gated A-Token, and carries a hash-anchored Travel Rule proof. Humans use a web app. Agents use the identical rail via **x402** and **MCP**.

The design choice that matters: **the backend cannot authorise anything.** An earlier version had it issue signed attestations the contracts would trust — cut, because `complianceVerify()` is a public on-chain view the contracts call themselves, and an agent's spend caps are contract storage, not an off-chain promise. A fully compromised Legate backend still cannot cause a non-compliant transfer. The backend's only job is a gas-free preview of what the chain will do anyway.

**The necessity test.** Remove A-Pass and counterparties are anonymous — an ordinary token bridge. Remove A-Token and the asset carries no provenance or transfer rules. Remove the validator and there is no pre-transaction check and no audit trail. Strip Cleanverse out and Legate isn't degraded; it stops being a compliant rail at all.

## CVI · CVA integration points

| | Where it actually bites |
|---|---|
| **CVI (A-Pass)** | Both parties must clear `complianceVerify()` at escrow **and again at settlement**. Revocation therefore reaches funds already in flight — a payment escrowed while compliant cannot be settled after a revocation, with no poller, no admin, and nobody noticing in time. Corridor rule pinned to `min_tier: 30`, countries `["MY","PH"]`. |
| **CVA (A-Token)** | The only asset `LegateEscrow` will accept or move. Transfer restrictions are enforced by the token's own on-chain hook, not by our API deciding what to call. |
| **CCP (validator)** | Called directly and synchronously on-chain — no off-chain bridge, no oracle, no attestation to forge. `download_travel_rule` is pulled post-settlement and hash-anchored via `TravelRuleAnchor`, which cross-checks `LegateEscrow`'s real state and refuses to anchor a payment that isn't genuinely settled. |
| **Gateway (Fiat Ramp)** | Real MYR→USDC and USDC→PHP legs, both wired. **Disclosed gap:** the docs list `monad` as a ramp settlement network; live testing proves the sandbox does not route ramp settlement there (`base` succeeds, `monad` fails for every input tried). The fiat legs use the verified-working network and we do not fake the bridge step. |
| **Agent Skill Framework** | Nothing like it exists in Cleanverse's docs, so we built it: `AgentMandate.sol` binds an agent to a principal who must hold a valid A-Pass, with per-transaction / daily / lifetime caps in contract storage. Cap and compliance refusals surface as structured x402 codes decoded from the actual revert. |

**Privacy:** no personal or KYC data ever touches the chain — hashes and references only.

## What's verifiable right now

- **54/54 Foundry tests**, including a real reentrancy attack and a real mandate-hijack exploit, both written as working PoCs before their fixes existed.
- **`bash demo/run-demo.sh`** — all four demo scenes end to end in ~40 seconds, no credentials, no testnet funds. Every refusal it prints is asserted against the exact custom-error selector, so a generic failure fails the run rather than passing as a convincing "BLOCKED".
- **Real end-to-end harnesses**, not mocks: real contracts on a real chain, a real MCP client driving the server over real stdio, real HTTP against the real backend.
- **`DECISIONS.md`** — every verified fact with the call that verified it, and every claim that turned out false. Including two places where Cleanverse's published docs disagree with their live sandbox: the phantom Monad ramp support above, and a redeployed Monad A-Token whose decimals moved 6→18, which a live test caught and which would otherwise have shipped a per-transaction cap of 0.00000001 aUSDC.

## Deployed chains

**Monad testnet**, single-chain by design — we claim **CVI, CVA, Gated Pools**, and deliberately not Cross-Chain.

> **Status — stated plainly rather than implied.** The deployment is scripted and verified (`contracts/script/DeployMonadTestnet.s.sol`, `backend/scripts/register-validator.ts`) but is **not yet live**: the deployer wallet is unfunded and Monad's faucet is CAPTCHA-gated. The contracts, the compliance logic, and all four scenes are proven against real bytecode on a real chain today; what is pending is one funding step and the REST registration call that follows it.
>
> Fill in on deploy: `LegateEscrow` `<addr>` · `ComplianceGate` `<addr>` · `AgentMandate` `<addr>` · `CVIRegistryMirror` `<addr>` · `TravelRuleAnchor` `<addr>`
> Receipt permalinks (`/receipt/:paymentId`) become live at the same moment — they are walletless and server-rendered specifically because judging is asynchronous.

**Honest disclosure:** `ADMIN_ROLE` is a single deployer EOA for this build. Migrating to a Safe multisig before any real-money pilot is a stated roadmap item, not something discovered later.

## Why this is worth continuing

Remittance is a ~$150B fee pool defended by compliance, not technology. Notabene reached 2,300+ institutions selling compliance *messaging* alone; Legate sells messaging **and** settlement, with a real 50bps fee mechanism working from day one rather than a deferred revenue story.

The agent side is the asymmetric bet. Agent payment volume is growing with no compliant option at all, and the winning primitive there is not a wallet — it is a mandate the agent cannot argue its way past, which is the thing this build already has on-chain.

**We intend to keep building Legate after the hackathon and would like the incubation slot.**
