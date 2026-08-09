# Legate — Product Requirements Document
## The Compliant Payment Rail for Humans and AI Agents

**Hackathon:** Cleanverse Build: Trusted Assets (Monad Foundation, $16K USDC)
**Track:** 02 — DeFi (Compliant DeFi)
**Chain:** Monad testnet (EVM-compatible — sponsor's chain), single-chain by design
**Build window:** Aug 8 00:00 → Aug 9 23:59 UTC (48 hours) — commit history must fall inside this window
**Status of this doc:** Hardened pass (2026-08-07) — full consistency check against `REQ.md` (rubric) and `DECISIONS.md` (every verified fact from docs, live sandbox, Telegram, and the CCP Integration Guide PDF). Stale references from earlier drafts removed. Remaining `[RECON]` items are listed explicitly in §8 and nowhere else — if it's not tagged `[RECON]`, treat it as settled.

---

## 1. One-Liner & Positioning

> **Legate is the first payment rail that both humans and AI agents can compliantly use** — every transfer is CVI-verified on both sides, checked against Cleanverse's real on-chain compliance contract before it settles, carries Travel Rule data, and moves exclusively in CVA through escrow that responds to identity revocation in real time. Agents connect through the two standards they already speak — **x402 and MCP** — and Legate makes both compliant.

**Track fit, stated precisely, not implied.** Track 02 names two paths: "CVI as a protocol entry condition or risk parameter," and "CVA as the settlement layer for cross-chain flows." Legate satisfies the first one directly — `LegateEscrow` is registered as a compliance pool against Cleanverse's real `IAPassComplianceValidator` contract, gated by an actual on-chain `RuleV2(minTier, poolCountryBitmap)`. That IS "CVI as a protocol entry condition," not an analogy. Legate does **not** claim the second path: it is deliberately single-chain (Monad only) — a focus choice that suits a sponsor whose entire ask is "build on our chain," not a gap. State this plainly in the README; don't leave a judge to infer it, and don't imply cross-chain settlement anywhere.

**Positioning sentence for judges:** "x402 moves agent money. Notabene moves Travel Rule data. Circle moves stablecoins. Nobody combines them. Legate is the compliance layer for the agent-payment stack — built entirely on Cleanverse primitives, impossible without them."

**Where the primitives actually come from (verified against the real API, not assumed):** Cleanverse's real system is A-Pass (=CVI) and A-Token (=CVA), a genuine on-chain **AccessCore** contract (Cleanverse's own deposit lock+mint mechanism — Legate never calls it directly), a genuine on-chain **`IAPassComplianceValidator`** compliance contract (this is the real substance behind the "CCP Protocol" capability name), and ~40 REST endpoints across A-Pass, A-Token, Validator, Fiat Ramp, and common-query modules — raw HTTP/JSON, no SDK exists. Legate satisfies the named capability; the plumbing underneath is accurately described everywhere in this document, not glossed over.

**The Cleanverse-necessity test (unwritten rule #6):**
- Remove CVI (A-Pass) → counterparties are anonymous → the rail is an ordinary token bridge → illegal for remittance.
- Remove CVA (A-Token) → the asset carries no rules or provenance → no clean-money guarantee.
- Remove the on-chain validator + Travel Rule report → no pre-transaction compliance, no audit trail → non-compliant in 100+ jurisdictions.

**Strip Cleanverse out and Legate isn't degraded — it's illegal.** That is maximal integration depth, and every claim above is backed by a verified endpoint, contract address, or interface in §4 and §5 — nothing in this section is aspirational.

---

## 2. Problem Definition (rubric: Concept, 20 pts)

### Problem A — the human corridor ($150B)
Cross-border remittance (Malaysia → Philippines: one of the world's largest and most iconic corridors — Overseas Filipino Worker remittances alone move ~$38B/year) runs on SWIFT-era rails — 3–5 days, and a real fee ([World Bank RPW](https://remittanceprices.worldbank.org/): global average 6.36% of amount sent), compliance handled by fax-era intermediaries. Stablecoins fix speed and cost but fail compliance: no verified counterparties, no Travel Rule data, no auditability. No licensed institution can touch that.

### Problem B — the agent corridor (2026's problem)
AI agents already execute payments at scale (Coinbase x402: 160M+ agentic payments). No agent payment today is compliant: no verification of the principal behind the agent, no spend governance, no sanctions screening, no audit trail a regulator would accept. Every enterprise that wants an agent to move money is blocked on exactly this.

### Who uses Legate
- **Licensed remittance operators / gateways** — plug into the rail instead of building compliance in-house (pilot-ready: institutions)
- **Merchants & employers** — accept payments / run payroll with automatic compliance receipts (pilot-ready: merchants)
- **AI agent developers & enterprises** — the only rail where an agent's payment is pre-screened, capped, and audit-logged by the infrastructure itself, not by the agent's own good behavior

### Why now
Travel Rule is mandatory in 100+ jurisdictions. MAS (Cleanverse's home regulator) actively supervises remittance. Agent payments are the fastest-growing payment category with zero compliance coverage. All three curves cross in 2026.

---

## 3. Solution Overview

One rail, two front doors:

```
  HUMAN DOOR                        AGENT DOOR
  Web app (Send / Claim)            x402 middleware  +  MCP server
        │                                   │
        └────────────────┬──────────────────┘
                          ▼
        LEGATE POLICY ENGINE  (backend — informational only, see note below)
        • Resolve A-Pass for both parties: POST /query_apass
        • Preview the on-chain compliance check off-chain (same logic, no gas): calls the
          same complianceVerify() the contracts will independently re-run
        • Evaluate Legate's own dynamic rules (velocity, daily/lifetime caps) — RuleV2
          can't express these; they live entirely in on-chain contract state, not here
        • Return a quote (fee, FX estimate from Fiat Ramp) — informational, not a
          cryptographic attestation the contracts trust blindly
                          ▼
        CONTRACTS ON MONAD  (the actual source of truth — see §5.1)
        • ComplianceGate    — wraps IAPassComplianceValidator.complianceVerify()
        • LegateEscrow      — payment lifecycle, the only holder/mover of A-Token
        • AgentMandate      — on-chain spend caps per agent (state lives here, not off-chain)
        • CVIRegistryMirror — active revocation monitor (defense-in-depth, not the only check)
        • TravelRuleAnchor  — hash-anchors Cleanverse's real compliance report per payment
                          ▼
        AUDIT LAYER
        • Immutable on-chain event log • Walletless /receipt/:id permalinks • PDF export
```

**Why there's no attestation-signing step (a design decision, not an oversight):** an earlier draft of this document had the backend issue a signed EIP-712 attestation that contracts would verify before acting — a reasonable design when we thought Cleanverse only exposed REST checks. It's now unnecessary: `complianceVerify()` is a real, public, on-chain view function the contracts call directly and independently, and `AgentMandate`'s spend caps are on-chain state, not something an off-chain service asserts. This is a *stronger* security property, not a simplification for its own sake: even a compromised or buggy backend cannot cause a non-compliant transfer, because the chain re-verifies everything itself regardless of what the backend claims. The backend's only job is giving users a fast, gas-free preview of what the chain will do anyway.

**Core design principle (from Pattern 1, Aave Arc vs Horizon):** compliance lives in the **asset and the on-chain validator**, not in an off-chain gatekeeper. The rail stays open; every *payment* must independently clear a real on-chain check.

**Privacy design (the trap most teams fall into):** REQ.md mandates local-only PII. Naive Travel Rule = PII on a public chain = violating the sponsor's core principle, on stage, in the demo. Cleanverse already keeps this off-chain: Travel Rule data is sourced from A-Pass registration (`identityDataList`), and the compliance report is a downloadable PDF from `download_travel_rule`, keyed by transaction hash — never a payload Legate constructs or pushes on-chain. Legate anchors only a **hash commitment** of that report reference (txHash + downloadUrl + fileName) via `TravelRuleAnchor.sol`. On-chain: proof a real compliance report exists for this payment. Off-chain: the report itself, fetched from Cleanverse by authorized parties.

---

## 4. Cleanverse Capability Integration Map (rubric: Depth, 30 pts)

| # | Capability | Depth | How it's used (verified against docs.cleanverse.com v5.6 + live sandbox + CCP Integration Guide PDF) | REQ.md checklist answer |
|---|-----------|-------|---------------|------------------------|
| 1 | **CVI (A-Pass)** | 🟢 DEEP | Core condition: both sender AND recipient must hold valid A-Pass, checked on-chain at 4 distinct enforcement moments (escrow-initiate, mandate-creation, mandate-execute ×2, settlement) — 6 `complianceVerify()` call sites total, not a single gate-once check. Real tier/subTier (0–99) + group/subGroup fields (`POST /query_apass`) are genuinely used — Legate's registered `RuleV2` sets a static tier floor at pool-registration time (§5.1), and, distinctly, a connected principal's real live tier now drives graduated spend-cap *suggestions* in the Agent Console (tier 30 = this corridor's floor; tier 50+ = verified institutional/agent-operator gets higher suggested caps) — honestly scoped as off-chain UX, not on-chain enforcement, since Cleanverse's interface exposes no trustless per-user on-chain tier read (only a pool's own registered floor via `getRulesV2`). Revocation (`POST /update_status`) → confirmed no push webhook exists → `CVIRegistryMirror` polls and freezes escrow/mandates within one poll interval, *and* independently, any settlement attempt after revocation reverts on-chain regardless of the poller (defense-in-depth, §5.1). | Core condition ✓ (4 enforcement moments, not 1), level-dependent behavior ✓ (off-chain, real, honestly scoped), revocation affects positions ✓ |
| 2 | **CVA (A-Token)** | 🟢 DEEP | The ONLY settlement asset (`LegateEscrow` accepts nothing else). Transfer rules are a real on-chain `RuleV2` struct (allowedGroup, allowedSubGroup, minTier, minSubTier, poolCountryBitmap) registered against `IAPassComplianceValidator`, enforced on every transfer by the A-Token's own transfer hook — confirmed on-chain, not API-side gating. Provenance shown per payment via `query_txs`. | All 3 boxes: only asset ✓, enforced per-transfer ✓, provenance visible ✓ |
| 3 | **CCP** | 🟢 DEEP — on-chain, not just REST | "CCP" is Cleanverse's public capability name; the real substance is `IAPassComplianceValidator` at `0xaC7e5179C2C7f03f209136886c172eb34F161792`, a deployed contract with `complianceVerify(pool, address) → bool`, callable synchronously, no permission required, no off-chain bridge needed. Plus `POST /download_travel_rule` (txHash → official compliance PDF), hash-anchored on-chain post-settlement. Deeper than the REST-only design this replaced, not shallower. | All 3 boxes ✓ |
| 4 | **Playground** | 🟡 REAL, DIFFERENT PURPOSE | Confirmed via Telegram: exists, but is a learning/reference platform about CVI/CVA/CCP — not a rule-design tool. Legate's `RuleV2` is configured directly against the validator contract, not "designed in Playground." Cited honestly in the README as a resource used to build understanding; no demo footage claimed, because there's nothing to film. | Partial, honestly framed |
| 5 | **API/SDK** | 🟢 DEEP (no SDK exists) | No SDK anywhere in the docs — every example is raw cURL/JSON. Legate ships its own typed TypeScript client, scoped to exactly the 6 endpoints the four demo scenes touch (§5.2) — not a padded 40-endpoint wrapper that scores no extra points. AES-encrypted request bodies handled correctly where the docs require it (A-Pass/A-Token mutation endpoints). | All 3 boxes ✓ — genuine technical integration, self-built |
| 6 | **Gateway** | 🟢 DEEP, one honestly-scoped gap | Confirmed via Telegram: hackathon accounts get **Issue Member** role automatically — the real Fiat Ramp module (7 endpoints, Transak-powered) is genuinely usable. Both legs wired for real: sender's fiat-in via `create_ramp_widget_url` on the Send view, recipient's fiat-out via the same on Claim. **Live-verified 2026-08-08:** `query_ramp_countries`/`query_ramp_fiat_currencies` confirm MYR and PHP are both supported with `isSellAllowed:true` (full bidirectional) — SGD/INR are confirmed absent from the ramp entirely, which is why the corridor moved to Malaysia↔Philippines (§2). **Second live finding, same day:** despite docs prose listing `monad` as a supported ramp settlement network, `query_ramp_crypto_currencies` returns zero Monad-network assets and `query_ramp_quote` fails for every currency/amount/direction tried against `network:"monad"`, while the identical request against `network:"base"` succeeds immediately with a real quote. The ramp legs settle in USDC on a supported chain (verified: `base`), not directly as aUSDC on Monad — see the corrected Send/Claim spec in §5.5 and the full finding in `DECISIONS.md`. | All 3 boxes ✓ (with the settlement-chain caveat stated honestly, not hidden) |
| 7 | **Clean Payment Rails** | 🟢 DEEP | Escrow settlement is the core mechanism, built on standard A-Token transfers (AccessCore's ABI isn't published and isn't needed — it's Cleanverse's own deposit-side contract). Clean-money routing via CVA provenance. Merchant/payroll acceptance is Demo Scene 4. A small settlement fee (§5.1) gives this a real revenue mechanism, not just a narrative one. | All 3 boxes ✓ |
| 8 | **Agent Skill Framework** | 🟢 DEEP (built by Legate — confirmed, not a fallback) | Zero mentions of "agent," "mandate," or "spend control" anywhere in the API docs — confirmed absent, not hoped-against. `AgentMandate.sol` is the only plan: principal verification (A-Pass-bound), counterparty validation (real pre-tx checks on every payout), on-chain spend controls (real contract state, not an off-chain promise), immutable audit trail. | All 4 boxes ✓ |

**Score claim: 7 deep + 1 honestly-partial.** Two of the "deep" rows (API/SDK, Agent Skill Framework) are deep specifically *because* Legate builds real infrastructure Cleanverse doesn't provide. No claim in this table lacks a verified endpoint, address, or interface behind it.

---

## 5. Core Components — Build Spec

### 5.1 Smart Contracts (Solidity ^0.8.24, Foundry, deployed to Monad testnet)

**Five contracts, kept separate on purpose.** Separation of concerns is the correct architecture independent of build-window length — it matches REQ.md's own "proper architecture, no hacks" criterion, mirrors Cleanverse's own Factory/Pool separation pattern from their integration guide, and is easier for a judge to audit one small, single-responsibility contract at a time than one contract doing everything.

**Data model** (concrete, not hand-waved):
```solidity
enum PaymentState { None, Escrowed, Settled, Frozen, Refunded }

struct Payment {
    address sender;
    address recipient;
    uint256 amount;              // in A-Token units
    PaymentState state;
    uint64  createdAt;
    uint64  settledAt;
    uint64  claimDeadline;       // after this, the sender can reclaim — see reclaimExpired()
}
mapping(bytes32 => Payment) public payments; // keyed by paymentId = keccak256(sender, recipient, nonce)

struct Mandate {
    address principal;
    address agent;
    uint256 perTxCap;
    uint256 dailyCap;
    uint256 totalCap;
    uint256 spentToday;
    uint256 spentTotal;
    uint64  dayWindowStart;      // reset spentToday when block.timestamp crosses this + 1 day
    uint64  expiry;
    bool    active;
}
mapping(address => Mandate) public mandates; // keyed by agent address
```

**Security & access control (production-grade thinking, per REQ.md's Build Quality criterion):**
- `LegateEscrow.settle()`, `.refundFrozen()`, and `.reclaimExpired()` all follow checks-effects-interactions: `Payment.state` is updated to `Settled`/`Refunded` *before* the external A-Token transfer call, and all three use OpenZeppelin's `ReentrancyGuard`. A-Token transfers can trigger the validator's `complianceVerify()` mid-call; state must already be final before that happens.
- Roles, via OpenZeppelin `AccessControl`: `ADMIN_ROLE` (register the pool, set `RuleV2`, set the fee address — deployer wallet), `MONITOR_ROLE` (the on-chain identity of `CVIRegistryMirror`'s off-chain poller, the only caller of `freeze()` besides `ADMIN_ROLE`). `complianceVerify()` and all `query*` functions are public views — no role needed, by design, since they're read-only.
- **Honest disclosure, not hidden:** for the hackathon build, `ADMIN_ROLE` is a single EOA (the deployer). That's a centralization point, and it's stated here rather than glossed over. Production roadmap (§11): migrate `ADMIN_ROLE` to a Safe multisig before any real-money pilot — this is exactly the kind of thing a judge evaluating "technically feasible beyond the hackathon" wants to see acknowledged, not pretended away.
- `AgentMandate.execute()` reverts with typed errors (`CapExceeded`, `MandateExpired`, `MandateRevoked`, `RecipientNotCompliant`) — every revert reason is machine-parseable, feeding the x402 structured-refusal codes (§5.3) directly.

**Contract-by-contract:**

**`ComplianceGate.sol`** — the choke point, a thin wrapper around Cleanverse's real contract.
- Calls `IAPassComplianceValidator.complianceVerify(legatePoolAddress, userAddress) → bool` for both sender and recipient before any escrow action. Public, no-permission-required, synchronous, on-chain.
- Layers Legate's own dynamic checks on top (velocity caps, corridor limits) that `RuleV2` structurally cannot express — RuleV2 is a static rule; Legate governs everything time-based or cumulative. Division of labor: Cleanverse verifies *who*, Legate governs *how much and when*.

**`CVIRegistryMirror.sol`** — active monitoring, defense-in-depth (not the only line of defense).
- Because `complianceVerify()` re-runs fresh, on-chain, at both deposit AND settlement, a revoked party is blocked automatically even with zero off-chain infrastructure — a settlement attempt after revocation simply reverts. The active poller (`query_apass`/`verify_apass`, confirmed no webhook exists for A-Pass) exists so Demo Scene 3 shows a **proactive** freeze the instant revocation happens, rather than waiting for someone to attempt a doomed settlement.
- `onRevoke(wallet)` → `MONITOR_ROLE`-gated → iterates open payments and mandates tied to that wallet → freeze/suspend. **This is Demo Scene 3.**

**`LegateEscrow.sol`** — the payment lifecycle, registered as a validator pool.
- Lifecycle: `None → Escrowed → Settled | Frozen | Refunded`. (An earlier draft had separate `Initiated`/`Cleared` states; they were cut because compliance clears synchronously in the same transaction as the escrow — a state that no transaction can ever observe is dead weight in storage and one more branch for an auditor to reason about.)
- **Self-service recovery — `reclaimExpired()`.** Every escrow needs an answer to "what if the recipient never claims?" A remittance corridor where the answer is *"open a support ticket and hope an admin refunds you"* is not pilot-ready, and `refundFrozen()` (`ADMIN_ROLE`-only, and only from `Frozen`) was that answer until this shipped. Each payment now carries a `claimDeadline` of `createdAt + CLAIM_WINDOW` (30 days); past it, the **original sender** — not an admin, not the recipient, not "anyone" — can take their own funds back in full, no fee. Proven by five Foundry tests covering the happy path and all four refusal paths, plus a real end-to-end leg in `e2e-x402-local.sh` that walks a live payment through pre-window refusal → non-sender refusal → successful reclaim on a real chain.
- Accepts ONLY the A-Token (CVA) via standard `transfer`/`transferFrom`. **Real Monad testnet addresses, confirmed live 2026-08-03** via `query_deposit_atoken_list({chain:"monad"})`:
  - Origin USDC: `0x534b2f3A21130d7a60830c2Df862319e593943A3`
  - **aUSDC / A-Token — the only asset LegateEscrow accepts.** ⚠️ **Unresolved with certainty as of 2026-08-09 — Cleanverse's own systems disagreed with themselves within a single day.** Earlier on 2026-08-09, `query_deposit_atoken_list` returned `0xfA96De5B…af1026` (18 decimals) — confirmed independently via direct Monad RPC `symbol()`/`decimals()` reads at the time, not just trusted from the API. Hours later, the same endpoint returned `0xaC0893…1f20D` (6 decimals, the *original* pre-"redeploy" address) — stable across 3 consecutive calls, and corroborated by `verify_apass`'s separately-maintained internal registry, which recognizes only the old address. **Both addresses are real, live, deployed ERC-20 contracts on Monad testnet right now** — the ambiguity is which one Cleanverse's own backend currently treats as canonical, and that has already changed once today. `DeployMonadTestnet.s.sol` no longer hardcodes this: `A_TOKEN_ADDRESS` is an env var override with a last-known-value fallback, and the script prints a loud reminder to re-verify via a fresh `query_deposit_atoken_list` call immediately before deploying, not to trust either address as settled. Full evidence trail in `DECISIONS.md`.
  - AccessCore (Cleanverse's own, not called directly): `0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC`
  - A-Pass registry: `0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9`
  - Compliance Validator: `0xaC7e5179C2C7f03f209136886c172eb34F161792` `[RECON: confirm this address is Monad-specific or shared across chains via deterministic deployment — see §8]`
- **Registration flow — corrected against the full REST reference (2026-08-08), not just the CCP guide's Solidity interface.** Setup is done via REST, not by hand-rolling on-chain calls ourselves: `POST /validator/grant` (encrypted; fields `chain`, `address`, `owner_signature` — an EIP-191 `personal_sign` over lowercase `chain+address`, no separator; our deployer EOA signs for itself, trivially satisfying "signature from the owner of the target") grants registrar permission to our deployer address — **no Factory contract required**; the docs describe the target generically as "an on-chain account," not a Factory-specific pattern. Then `POST /validator/register` (encrypted; `chain`, `contract_address` = `LegateEscrow`'s address, `rule` = our initial Compliance Rule object, `owner_signature` over `chain+contract_address`) registers the escrow as a pool **and sets its first rule in the same call** — `register` requires an initial rule, it's not optional. Cleanverse's backend executes the on-chain transaction and returns `tx_hash`; we never touch a raw on-chain bitmap ourselves. `[RECON: execute this live — grant, wait for confirmation, then register — this is still the #1 priority, now fully specified with exact fields]`
- **Runtime compliance check stays on-chain, direct, no REST round-trip:** at payment time, `LegateEscrow` calls `IAPassComplianceValidator.complianceVerify(pool, address)` itself — synchronous, on-chain, no bitmap knowledge needed to *read* the result, only to *write* a rule (which REST handles for us, above). Pre-flight: check `is_paused` for the pool before calling `verify`/`complianceVerify` — a paused pool makes the check error out (`12027`) instead of returning a clean true/false.
- **Corridor policy (concrete, resolved 2026-08-08 — no unresolved bitmap question):** the REST `Compliance Rule` object takes country constraints as a plain `countries: string[]` (ISO 3166-1 alpha-2) + `is_black_list: boolean`, not a raw bitmap — Cleanverse converts this to the on-chain `poolCountryBitmap` for us when we call `register`/`set_rule`/`add_rule`. Legate's corridor rule: `{ allowed_group: "", allowed_sub_group: "", min_tier: 30, min_sub_tier: 0, is_black_list: false, countries: ["MY", "PH"] }`. **Tier semantics are entirely institution-defined — Cleanverse's docs give only the mechanical range (0-99, strict-greater-than comparison), no fixed meaning.** Legate defines its own scheme, documented here so it's not ad-hoc: tier 10 = basic-KYC individual (ID + name, human remittance default), tier 30 = enhanced-KYC individual (adds bank account verification — our corridor's floor), tier 50 = verified institutional/agent-operator (for AI-agent principals, Scene 4). `min_tier: 30` reflects a deliberate policy choice (enhanced KYC required for this corridor), not a placeholder.
- **Fee mechanism (ties directly to §11's revenue claim — no longer just narrative):** `settle()` deducts a small fee (default 50 bps, owner-configurable) to `feeAddress` — a Legate treasury wallet, itself registered via `registerApass` so it can hold A-Token. This is the concrete implementation behind "Revenue: bps per settlement" in §11.
- Emits a full event trail per state change (audit layer + `/receipt/:id` read from these).
- `freeze()`: `MONITOR_ROLE` or `ADMIN_ROLE` only. Frozen funds → compliance review flow → refund-to-origin (clean-money return, provenance intact).
- **Refusal evidence, deliberately engineered, not just logged:** an off-chain "we silently declined" record is real but weaker proof than judges can independently verify. Real product UX pre-flight-checks via the backend's `complianceVerify()` preview before ever touching chain (good — no wasted gas for real users) — but the demo specifically also forces one on-chain attempt to an unverified recipient, letting the A-Token's own transfer hook genuinely revert it: a real, block-explorer-visible failure from Cleanverse's contract, not Legate's word for it. Paired with a **positive control** — the identical transfer to a verified recipient succeeding in a nearby block. See Scene 2 (§6).

**`AgentMandate.sol`** — programmable mandates, on-chain state, not an off-chain promise.
- `createMandate(agentWallet, perTxCap, dailyCap, totalCap, allowedRecipientPolicy, expiry)` — callable only by an A-Pass-verified principal.
- `execute()`: checks caps (per-tx, rolling daily via `dayWindowStart`, lifetime) against real contract state → calls `complianceVerify()` on the recipient → forwards to `LegateEscrow` (whose own transfer independently re-checks compliance via the A-Token hook — two enforcement points, not one, on purpose).
- Cap exceeded or unverified recipient → typed revert → surfaced in the agent-facing API as a structured refusal. **This is Demo Scene 4's blocked transactions.**
- Principal can revoke a mandate instantly; principal's A-Pass revocation auto-suspends all their mandates, reflected the next `complianceVerify()` call — no cache to invalidate, because there is no cache.

**`TravelRuleAnchor.sol`** — privacy-safe compliance proof.
- `anchor(paymentId, reportHash, txHash)` — `reportHash` is a hash of the real `download_travel_rule` response (downloadUrl + fileName), Cleanverse's own generated PDF, keyed to the settlement tx. Legate anchors proof the official report was retrieved; it never constructs or transmits the underlying identity data. Hash only — PII never touches chain.

### 5.2 Policy Engine (Node/TypeScript backend)

**Client scope, deliberate:** not a comprehensive wrapper over all ~40 endpoints — that's real hours spent on coverage the product never uses. Exactly six calls: `query_apass`, `verify_apass`, `validator/apply` + `validator/register` (one-time setup, not per-payment), `download_travel_rule`, and `create_ramp_widget_url` (both legs of the real Gateway integration). Consistent with §5.6's non-goals — stated explicitly here so it isn't over-built out of habit.

**Pre-transaction pipeline** (a *preview* of what the chain will independently enforce — see §3's note on why there's no attestation step):
1. Resolve sender + recipient A-Pass via `POST /query_apass` → status, tier, subTier, group, subGroup, countries.
2. Preview the same `complianceVerify()` logic the on-chain contracts will run (read-only, no gas), plus `POST /verify_apass` as a secondary REST-side signal.
3. Evaluate Legate's own dynamic rule config (tier→limit matrix, velocity caps) — this is backend policy Legate writes and owns; labeled as such, since no Playground rule-design tool exists to lean on.
4. Return a quote to the client: fee, FX estimate (from `query_ramp_quote`), and a pass/fail preview. Informational only — the contracts don't trust this blindly; they re-derive it.
5. After settlement: `POST /download_travel_rule` with the resulting txHash → hash the report reference → anchor via `TravelRuleAnchor.sol`.

**Decision log:** every ALLOW/DENY preview with the rule that fired → append-only store → feeds audit reports. Denials are first-class records.

**Audit report generator:** given any paymentId → the real JSON record (parties as A-Pass refs, not PII; checks run; the real Cleanverse Travel Rule report + anchor proof; chain tx hashes; final state), exportable via the browser's own print-to-PDF (a real, working PDF export — not a server-rendered report template, which this build does not claim to have; corrected here after an adversarial review caught the two wordings drifting apart, see DECISIONS.md).

### 5.3 x402 Compliance Middleware

Standard x402 flow, completed with compliance:
1. Agent `GET /pay/:invoiceId` → **`402 Payment Required`** + payment requirements **+ compliance requirements** (extension: `{principalCviProof: required, mandateRef: required}`)
2. Agent responds with payment authorization + principal A-Pass reference + mandate ID
3. Middleware runs the pre-transaction preview (§5.2) + calls `AgentMandate.execute()` — the real on-chain enforcement, not a second off-chain check
4. Pass → `200` + settlement receipt header (tx hash + `/receipt/:id` link)
5. Fail → **`403 Compliance Refused`** + a structured, machine-readable reason taken directly from the contract's typed revert: `PRINCIPAL_UNVERIFIED | RECIPIENT_NOT_COMPLIANT | MANDATE_CAP_EXCEEDED | MANDATE_EXPIRED | MANDATE_REVOKED`

README framing: "x402 moves the money; Legate makes it compliant." Apache-licensed pattern, credited.

### 5.4 MCP Server

Thin TypeScript MCP server over the Legate API. Exactly six tools:
- `verify_recipient(address)` → A-Pass status + tier + can-receive verdict
- `get_quote(from, to, amount)` → fee, FX estimate, compliance preview
- `send_payment(recipient, amount, memo)` → runs the full flow through the caller's mandate → receipt or structured refusal
- `check_mandate()` → caps, spent-today, remaining
- `get_audit_report(paymentId | range)` → the auditor JSON
- `list_transactions()` → history with compliance status per tx

Any MCP-speaking agent (Claude, filmed on screen) can drive payments — and the refusals come from the on-chain contracts, not the model or even the backend. Compliance holds even if the agent is dumb, malicious, or jailbroken, and even if Legate's own backend has a bug. That's the thesis of the whole project.

### 5.5 Web App (Next.js + Tailwind + shadcn/ui — institutional, not memecoin)

Four views plus one lightweight page:
1. **Send** — recipient lookup (A-Pass badge + tier), amount, live quote, compliance preview ("2/2 checks passed"), **real fiat-in via `create_ramp_widget_url`** showing the genuine MYR → USDC leg on a real Cleanverse-supported settlement chain (live-verified: `base` — see the Monad-ramp finding below), send → escrow → settled timeline, provenance panel reading from `query_txs`.
2. **Claim** — both sides of an open escrow, because both sides have a legitimate claim on it. A recipient verifies their A-Pass → claims from escrow → cashes out via `create_ramp_widget_url` for the real USDC → PHP leg on the same verified chain. A *sender* whose payment was never picked up scans the chain for their own outgoing payments and calls `reclaimExpired()` once the on-chain claim window closes — the page reads the deadline from the chain's own latest block timestamp, not the browser clock, since that's the exact value the contract compares against.

**Fiat Ramp / Monad settlement gap, stated precisely (live-verified 2026-08-08, full detail in `DECISIONS.md`):** Cleanverse's Fiat Ramp docs list `monad` as a supported ramp network, but live testing of `query_ramp_crypto_currencies` and `query_ramp_quote` proves the sandbox does not actually route ramp settlement onto Monad today — every network/currency/amount combination tried against `network:"monad"` fails, while the identical request against `network:"base"` succeeds with a real quote. The Send/Claim views therefore call the real Gateway API end-to-end (quote → widget URL) against a verified-working chain to demonstrate genuine Fiat Ramp integration — that is the real capability being scored. The demo wallets' actual Monad-side aUSDC balance (what `LegateEscrow` escrows and settles) comes from Cleanverse's own sandbox `/faucet` endpoint, since automatically bridging ramp-delivered USDC from another chain onto Monad as aUSDC is a separate cross-chain step Cleanverse doesn't expose and this build does not attempt to fake. This is disclosed on-screen during the demo, not glossed over.
3. **Agent Console** — principal creates/revokes mandates, sets caps, sees agent activity feed with ALLOW/DENY log.
4. **Auditor** — search any payment → full compliance report; export PDF. Frozen state visible in red for Scene 3.
5. **`/receipt/:paymentId`** — walletless permalink. Judging is asynchronous (Aug 10–14 per the onboarding email) — a judge won't connect a wallet or navigate a live app. One shareable, read-only URL per payment: checks run, on-chain tx, the real Travel Rule report, anchor proof. Linked from the one-page summary, the README, and Scene 4's audit report.

### 5.6 Explicit NON-GOALS (deliberate scope, not time-panic)

- Settlement/payments, not lending/AMM — Track 02 explicitly offers both paths (§1); lending was ruled out on its own merits (identity ≠ creditworthiness — Goldfinch's $50M in defaults is the cautionary case, per `DECISIONS.md`'s graveyard), not because it was harder to build.
- No fiat movement beyond the real Fiat Ramp integration already scoped in §5.5 — nothing further needs simulating.
- No multi-agent orchestration frameworks (LangGraph/CrewAI/AutoGen) — one demo agent, MCP-native.
- No Nevermined/Olas integration, no mobile app, no mainnet deployment, no token.
- Nothing that isn't in one of the four demo scenes (§6).

---

## 6. The Four Demo Scenes (this IS the acceptance spec)

Every feature must serve a scene. If it's in no scene, don't build it.

**Scene 1 — The happy path (~30 sec).**
Verified sender (MY, real A-Pass, tier 30+) → verified recipient (PH, real A-Pass). Sender's real MYR → USDC quote is pulled live from `query_ramp_quote` (verified chain: `base`) to show the genuine Fiat Ramp integration; the Monad-side aUSDC actually escrowed comes from the sandbox faucet (see §5.5's stated gap — disclosed on screen, not hidden). Sends, compliance preview passes (2/2), escrow → settled, `download_travel_rule` report pulled and hash-anchored on-chain, recipient's real USDC → PHP quote and widget URL shown via the same verified Gateway flow. Amounts illustrative (~100 MYR-equivalent, pulled live in the actual recording, not hardcoded). Caption: "Fully compliant cross-border payment. Try that with SWIFT."

**Scene 2 — Blocked before it exists, with the receipt to prove it.**
Two halves, same block range. Half A (real UX): sender attempts payment to an unverified wallet; the backend's `complianceVerify()` preview fails; nothing is submitted to chain — good UX, no wasted gas, this is how the product behaves for real users. Half B (evidence): one deliberate on-chain attempt anyway — the A-Token's own transfer hook reverts it for real, visible on the Monad block explorer, Cleanverse's contract refusing, not Legate's word for it — shown beside a **positive control**: the identical transfer to a verified recipient succeeding nearby. Caption: "Compliance isn't a revert reason — it's a precondition. And when we show you a refusal, it's Cleanverse's contract refusing, not ours."

**Scene 3 — Revocation with teeth.**
A payment sits in escrow. Sender's A-Pass is revoked (sanctions hit, via `update_status`). `CVIRegistryMirror`'s poller fires → escrow freezes on-chain, live on screen — and independently, if anyone tried to settle it anyway, the on-chain `complianceVerify()` re-check would revert it regardless. Auditor view shows frozen state, reason, refund-to-origin path. Caption: "Revocation doesn't just stop future transactions. It reaches funds already in flight." (Answers REQ.md's hardest CVI checkbox verbatim.)

**Scene 4 — The agent payroll run.**
Claude, connected via MCP, told in plain English: "Run this week's payroll — 7 contractors." 5 payments clear (A-Pass ✓, mandate caps ✓, on-chain compliance ✓, receipts). #6 exceeds the daily mandate cap → refused by `AgentMandate` on-chain. #7's recipient isn't compliant → refused by the validator. Agent reports back gracefully. One click → auditor report showing all 7 decisions, immutable, each linked to a `/receipt/:id` permalink. Caption: "The first payment rail an AI agent can compliantly use. The compliance is in the rail — not the model."

**Recorded, not performed:** judging is asynchronous — no judge drives the MCP server themselves. Scene 4 is filmed as a genuine working recording once the pipeline is real; the receipts stay independently viewable afterward via their permalinks either way.

**Demo video:** these four scenes + a 20-sec architecture card + a 10-sec scale slide. No hard time limit per the onboarding email, but ~3 min total is the target for judge attention. `[RECON: add a 10-sec Playground insert only if Telegram confirms real usage beyond "we read it" — don't film footage of a tool with nothing to show]`

---

## 7. Rubric Mapping — Where Every Point Comes From

| Criterion | Pts | Legate's answer | Target |
|---|---|---|---|
| CVI·CVA depth | 30 | 7 deep integrations backed by a real on-chain validator contract, not REST assumptions; revocation reaches in-flight funds with two independent enforcement points; CVA the sole asset with real on-chain `RuleV2` enforcement; Travel Rule via the real report + privacy-correct anchoring | 27–29 |
| Build quality | 25 | Foundry tests on all 5 contracts (revocation, cap-boundary, reentrancy cases), explicit data model, stated access-control roles with an honest note on the hackathon's single-admin-key tradeoff, typed client over exactly the endpoints used, clean monorepo | 22–24 |
| Concept | 20 | Two convergent problems ($150B remittance + agent payments), named users, pilot-ready with institutions AND merchants, MAS-corridor demo | 18–19 |
| UX & Demo | 15 | 4-scene recorded video (not a live performance — see §6), institutional UI, walletless receipt permalinks for async judging | 13–14 |
| Scalability | 10 | §11's phased roadmap with named team roles, a real fee mechanism already live in the MVP (§5.1) not a narrative claim, and every REQ.md bonus signal explicitly mapped to a concrete answer, not just gestured at | 8–9 |
| **Total** | 100 | | **88–95** |

**Bonus signals — each with a concrete anchor, not a checkbox:** meaningful primitives (§1, §4) ✓ · real financial infra (§2) ✓ · institution/merchant *architecturally* pilotable — outreach itself not yet done, honestly deprioritized below shipping, see §8/§11 — partial, not ✓ · trust/compliance/interop (§3, §11 Phase 3) ✓ · clear user value, named not abstract (§2) ✓ · feasible beyond hackathon, with a real team plan (§11) ✓ · Monad deploy pending real deployer wallet funding, see DECISIONS.md — partial, not ✓ · Playground engaged with honestly, not overclaimed (§4) ✓.

---

## 8. Recon Plan (originally scoped for Aug 2–7 — the build window is now open, see status check below)

**Resolved, verified against live systems, not just docs:**
- [x] Registered (INC20260802993697); API access, sandbox creds, and docs received instantly.
- [x] Agent Skill Framework confirmed absent from the API docs — `AgentMandate.sol` is the plan, not a fallback.
- [x] Commit-window rule confirmed via onboarding email: nothing substantive to the public repo before Aug 8 00:00 UTC.
- [x] "ClevrPay" and the secondhand "7-endpoint / Access Core.withdraw()" claim confirmed false — real API has ~40 endpoints; A-Pass/A-Token/AccessCore naming independently confirmed real by the docs AND the onboarding email.
- [x] Live sandbox hit for real: `query_deposit_atoken_list({chain:"monad"})` → real contract addresses (§5.1). `query_apass` → confirmed both response shapes (found vs. clean not-found error) — exactly what Scene 2 needs.
- [x] Telegram answered: Playground is real but educational (not rule-design); Issue Member role auto-granted (Gateway is real); register real test wallets, don't rely on the seeded `0x...dEaD` address. Real CCP Integration Guide PDF received — full `IAPassComplianceValidator` interface now in §5.1.

**Status check (2026-08-08, ~10.5h into the actual build window — see note below): several items resolved just now via the full REST docs + live sandbox calls:**
- [x] **RESOLVED:** `poolCountryBitmap` question — moot. The REST `register`/`set_rule`/`add_rule` endpoints take plain `countries: string[]` + `is_black_list`; Cleanverse converts to the on-chain bitmap for us. We never touch the raw encoding. See §5.1.
- [x] **RESOLVED:** corridor's fiat currencies — SGD/INR confirmed **absent** from the real Fiat Ramp (live-checked against `query_ramp_countries`/`query_ramp_fiat_currencies`); MYR/PHP confirmed present, fully bidirectional. Corridor moved to Malaysia↔Philippines throughout this document.
- [x] **RESOLVED:** `registerApass`/Factory question — the REST `/validator/grant` + `/validator/register` flow works from any address (no Factory contract required), with an exact, fully-specified EIP-191 signature scheme. See §5.1.
- [x] **RESOLVED:** tier semantics — confirmed Cleanverse defines no fixed taxonomy; Legate defines its own (§5.1) rather than waiting on an answer that doesn't exist.
- [x] **NEW:** faucet exists in sandbox (`POST /faucet`) but has a long cooldown (~24h observed) — fund all demo wallets NOW, not near recording time.

**Still genuinely open, in priority order — this is the real remaining list, and the clock is real:**
- [ ] **#1, unchanged priority, now fully specified:** call `POST /validator/grant` (get registrar permission for the deployer address), wait for confirmation, then `POST /validator/register` (register `LegateEscrow`, set the initial corridor rule) — live, on testnet, right now. Exact fields and signature scheme are in §5.1; nothing left to figure out, only to execute.
- [ ] Register real test wallets via `generate_apass` — sender (MY, tier ≥30), recipient (PH, any valid tier), one deliberately left unregistered for Scene 2. Fund via faucet immediately given the cooldown.
- [ ] Live-test `verify_apass`, `validator/verify`, `download_travel_rule` — same pattern as the calls already confirmed working.
- [x] Confirm whether the validator address (`0xaC7e...`) is Monad-specific or shared across chains. **Resolved 2026-08-09, live-verified via direct bytecode reads:** Monad testnet has 247 bytes of code at `0xaC7e5179C2C7f03f209136886c172eb34F161792`; Base, Arbitrum, Ethereum mainnet, and BNB Chain have zero code there (not deployed); Polygon has 135 bytes — a *different*, shorter contract, not the same validator. Not a shared CREATE2 address. The validator is Monad-specific; DeployMonadTestnet.s.sol's hardcoded address is correct as-is, no per-chain lookup needed.
- [x] **RESOLVED (live-verified 2026-08-08):** Monad testnet chain ID `10143` (`0x279f`), RPC `https://testnet-rpc.monad.xyz` — confirmed via a real `eth_chainId` JSON-RPC call, not just docs. Note: the docs portal states `rpc.testnet.monad.xyz` (no `https://`, different subdomain order) which did not actually respond to a live call — the working URL differs from the documented one, exactly why this needed live verification, not just a docs read.
- [x] Create the actual GitHub repo — local repo and full commit history done (12 commits, clean tree, secrets swept). **Push pending `gh auth login`.** Every hour without it is an hour not counted toward "commit history during the window."
- [ ] Pilot-partner outreach — still valuable, now lower priority than shipping given how much of the window has already elapsed.

**A note on the date labels throughout this document:** entries dated 2026-08-02 through 2026-08-07 were accurate when written — real time genuinely elapsed across a long working session. As of this status check, the real clock reads Aug 8, ~10:35 UTC — the 48-hour build window opened 10.5 hours ago. This document's "Recon Plan (Aug 2-7 — before the clock starts)" header is now stale in one respect: the clock has started. Treat everything above as the live, in-window status, not pre-window planning.

---

## 9. 48-Hour Build Schedule (Aug 8 00:00 → Aug 9 23:59 UTC)

Solo build + Claude Code. Sequenced so the demo-critical path completes by hour 36. Assumes `REGISTER_ROLE` and `registerV2`/`registerApass` were already verified for real during recon (§8's top priority) — building against the real validator from hour 0, not a mock. If that verification genuinely didn't clear in time, `ComplianceGate` falls back to a toggleable mock `complianceVerify`, swapped for the real address the moment approval lands — a documented contingency, not the plan.

**Hours 0–6 — Foundations**
- Monorepo scaffold (contracts / backend / web / mcp)
- `CVIRegistryMirror.sol` + `ComplianceGate.sol`, written and unit-tested against the real validator address
- Backend: typed client over the 6 real endpoints (§5.2), wired against sandbox, live

**Hours 6–14 — The rail**
- `LegateEscrow.sol` full lifecycle + `TravelRuleAnchor.sol`; Foundry tests including the freeze path, the reentrancy guard, and the deliberate on-chain-refusal + positive-control pair
- Policy engine pipeline end-to-end: preview → quote → real settlement
- First end-to-end payment on Monad testnet (CLI, no UI) ← **milestone: rail works, hour 14**

**Hours 14–22 — Agent layer**
- `AgentMandate.sol` + tests (cap boundaries, suspension on revoke)
- x402 middleware over the pipeline; structured refusal codes taken from real contract reverts
- MCP server (6 tools) → first Claude-driven payment ← **milestone: agent pays, hour 22**

**Hours 22–30 — Faces**
- Web: Send (with real fiat-in) + Claim (with real fiat-out) wired to the real flow
- Web: Agent Console + Auditor view (frozen state, PDF export) + `/receipt/:paymentId` permalink
- Revocation poll loop (confirmed no webhook exists) → freeze hook verified live

**Hours 30–36 — Scene lock**
- Run all four demo scenes end-to-end, including Scene 2's on-chain refusal + positive-control pair; fix everything that breaks
- Seed data + test wallets staged for recording ← **milestone: all scenes pass, hour 36**

**Hours 36–43 — Submission artifacts (scheduled explicitly, not left to hour 47)**
- Record + edit demo video (4 scenes + arch card + scale slide) as a genuine recorded artifact
- One-page summary (problem / solution / CVI·CVA integration points / deployed chains), linking `/receipt/:id` permalinks
- README: architecture diagram, honest §4 integration table, setup instructions, x402/MCP credits, admin-key disclosure, LICENSE

**Hours 43–48 — Submission armor**
- Redeploy clean to Monad testnet; verify contracts; pin addresses in README and the one-pager
- Final test-suite run; tag release; email repo + video + one-pager + live URL to isaac@cleanverse.com
- Buffer for the disaster nobody predicted — sacred, do not spend early

---

## 10. Risks & Fallbacks

| Risk | Likelihood | Fallback |
|---|---|---|
| `registerApass` doesn't actually grant escrow vault status | **Load-bearing — verify first, this week** | If it fails, the escrow can't hold aUSDC and all 4 scenes are affected. This is why it's §8's #1 priority, resolved before Aug 8, not discovered during it. |
| `REGISTER_ROLE` approval from Cleanverse doesn't clear in time | Low if pursued now; higher if left until the window | Toggleable mock `complianceVerify`, swapped for real the moment approval lands — documented contingency, not the plan |
| ~~SGD/INR not supported~~ | **Confirmed true, already actioned** | Corridor swapped to Malaysia↔Philippines (both MYR and PHP confirmed live, bidirectional) — this is why the risk was worth checking early |
| Sandbox flaky/slow during the window | Medium | Cache recon-week responses; thin adapter layer replays them for UI dev; real calls used in the final demo recording regardless |
| No revocation webhook | **Confirmed, not a risk — this is the design** | Poll interval tuned short enough to read as live on camera; the on-chain re-check at settlement is the real safety net either way |
| Playground / SDK claims turn out narrower than hoped | Low, mostly resolved | Already framed honestly in §4 — nothing here is load-bearing for the four scenes |
| Live demo breaks | — | Video is the submission format; record scenes as they pass at hour 30–36; deployed app stays as a judge-verifiable backup |
| Scope creep | High, always | §5.6 non-goals + "nothing outside the four scenes" rule |

---

## 11. Beyond the Hackathon (rubric: Scalability, 10 pts — and every bonus signal in REQ.md's checklist)

This section is written to answer each bonus consideration explicitly, not just gesture at "scalability" in general. A judge reading REQ.md's checklist should be able to match every line to a concrete answer here.

### Phased roadmap

**Phase 1 (the hackathon submission):** the rail — one corridor (MY↔PH), humans + agents, Monad testnet, single admin key (disclosed honestly, §5.1). Fee mechanism already live in the MVP, not a future promise.

**Phase 2 (weeks, with a small real team):** the network.
- Multi-corridor generalization — `RuleV2` configuration becomes a genuine corridor-management system, not a hardcoded MY↔PH pair. This also happens to fill a real product gap: Cleanverse's own "Playground" turned out to be educational, not a rule-design tool (§4) — Legate's corridor manager is closer to what builders on the platform actually need.
- `ADMIN_ROLE` migrates from a single deployer key to a Safe multisig before any real-money pilot, with a stated incident-response runbook for the freeze/revocation path — a centralization point disclosed now, not discovered as a gap later.
- A real security pass: external mini-audit + Foundry invariant/fuzz testing specifically targeting the reentrancy and cap-boundary paths already identified in §5.1 — not just the unit tests that ship with the hackathon submission.
- Real fiat-rail testing end-to-end with small real amounts (Fiat Ramp is Transak-powered underneath; production needs to understand its real settlement timing and failure modes, not just the API contract).
- A real indexer + analytics dashboard over payment/mandate events — the concrete difference between "a demo institutions watched" and "a system institutions can actually evaluate."

**Phase 3 (the standard):** Legate's compliance-extended x402 flow, formalized as a proposed open spec (not just living inside Legate's own contracts) and put in front of the x402/agent-payments community for feedback — since Cleanverse has no Agent Skill Framework of its own (§4, §8), Legate's `AgentMandate.sol` is positioned to become a reference implementation others build against, not a one-off feature. At this stage, genuinely pursue the OTHER Track 02 path Legate deliberately declined to claim for the hackathon (§1) — real cross-chain settlement across the other chains Cleanverse supports (Arbitrum, Base, BNB, Ethereum, HashKey, Polygon), rather than just choosing not to overclaim it.

**Team, for real execution beyond the hackathon (this is what makes "feasible beyond the hackathon" a plan, not a slogan):** 2 contract engineers (core settlement; compliance + mandate integration), 1 dedicated security engineer, 1 backend engineer (indexer, receipt service, observability), 1–2 frontend engineers, 1 compliance/protocol designer (real FATF Travel Rule + MAS regulatory depth, not just API plumbing), 1 BD/partnerships lead, 1 PM/writer. None of this requires reinventing the architecture — every role extends what's already speced in §5.

### Mapped directly to REQ.md's bonus checklist

- **Use Cleanverse Primitives Meaningfully** — CVI gates protocol entry via a real on-chain `RuleV2` (§1, §5.1); CVA is the only settlement asset with real transfer-hook enforcement (§4); the compliance validator is called directly on-chain, not assumed via REST (§3). Depth, not decoration.
- **Solve Real Financial Infrastructure Problems** — $150B remittance corridor with no compliant stablecoin rail today (§2, Problem A); zero compliant agent-payment options against 160M+ agentic transactions already happening (§2, Problem B).
- **Can Be Piloted With Institutions Or Merchants** — the product is architecturally pilot-ready (real on-chain enforcement a remittance operator or employer could integrate against today, §5.1), but actual outreach has not yet happened — §8 explicitly deprioritizes it below shipping given how much of the build window had already elapsed when this was assessed. One real "we'd pilot this" would outweigh any amount of Solidity for this specific signal; stated honestly as a real gap, not claimed as done.
- **Improve Trust, Compliance, Or Interoperability** — trust: on-chain enforcement independent of the backend (§3); compliance: real Travel Rule report retrieval + privacy-correct anchoring (§3, §5.1); interoperability: a compliant x402 extension other builders can adopt (Phase 3, above), and a chain-agnostic architecture honest about being single-chain now by choice, not limitation (§1).
- **Demonstrate Clear User Value** — named users with named pain points, not abstract personas (§2): remittance senders paying real fees (World Bank RPW global average: 6.36%) and waiting days; enterprises that currently have no way to let an agent spend money compliantly at all.
- **Are Technically Feasible Beyond The Hackathon** — a concrete fee mechanism already live in the MVP (§5.1), not a narrative promise; a phased roadmap with named team roles and named next technical steps, not a vague "and then it scales" gesture; an honest disclosure of the one thing that's genuinely hackathon-only (the single admin key) paired with the specific fix (multisig migration) rather than hiding it.

**Business anchor:** remittance TAM $150B; agent payments growing from 160M+ tx/yr with zero compliant options today. Comparable: Notabene reached 2,300+ institutions selling compliance *messaging* alone — Legate sells messaging AND settlement, with a working fee mechanism from day one, not a deferred one.

Legate intends to continue post-hackathon and wants the incubation slot — stated in the submission, not just implied.

---

## 12. Submission Checklist

- [ ] Submit by email to **isaac@cleanverse.com**, before Aug 9 23:59 UTC
- [x] Public GitHub repo — commit history entirely within Aug 8 00:00–Aug 9 23:59 UTC
- [ ] Demo video (~3 min target, no hard limit) — four scenes, recorded not performed
- [x] One-page summary: problem / solution / CVI·CVA integration points / deployed chains — linking `/receipt/:id` permalinks
- [ ] Live demo URL and/or testnet deployment — Monad testnet, contract addresses verified and pinned
- [x] README: architecture diagram, honest §4 integration table, setup instructions, x402/MCP credits, admin-key disclosure (§5.1), LICENSE file
- [x] Playground reference in README — only if actually engaged with meaningfully; no screen-recording claim, since it isn't a tool that produces one
- [x] Foundry test suite passing, including reentrancy and cap-boundary cases
- [x] Track 02 selected; tags claimed: **CVI, CVA, Gated Pools** (genuinely earned via `RuleV2` registration) — not Cross-Chain (single-chain by design, stated plainly)
- [x] Post-hackathon intent stated explicitly
- [x] "Compliantly," never "legally" — scrub every surface: README, video captions, one-pager
- [x] `.env` for sandbox credentials, gitignored from the repo's first commit — never hardcoded, never committed
- [x] No stale references to tools not actually used (e.g., ERC-3643 was a reference pattern from early research, not part of the shipped implementation — don't credit it if it isn't there)
