import { JsonRpcProvider, Wallet, Contract, type Log } from "ethers";
import type { CleanverseConfig } from "../cleanverse/client.js";
import { queryApass } from "../cleanverse/client.js";
import { LEGATE_ESCROW_ABI, AGENT_MANDATE_ABI } from "../chain/contracts.js";

/**
 * Active revocation monitor — Scene 3 (PRD.md §6). Not the only line of defense (the chain
 * independently re-checks complianceVerify() at settlement regardless of this poller, per
 * CVIRegistryMirror.sol's own doc comment) — this exists so a revocation reaches funds
 * ALREADY sitting in escrow proactively, the moment it's detected, rather than waiting for
 * someone to attempt a doomed settlement.
 *
 * Maintains an in-memory index of "who has an open position" (an escrowed payment as sender
 * or recipient; an active mandate as principal) built from real on-chain events — there is no
 * on-chain enumeration of open payments/mandates, so this is necessarily off-chain
 * bookkeeping. On each poll tick, checks each such wallet's REAL A-Pass status via Cleanverse's
 * REST API and calls the real on-chain reportRevocation()/reportReactivation() on a detected
 * transition — never on every tick, only on a genuine state change.
 */

const CVI_REGISTRY_MIRROR_ABI = [
  "function reportRevocation(address wallet, bytes32[] openPaymentIds, address[] mandateAgents) external",
  "function reportReactivation(address wallet) external",
  "function isRevoked(address wallet) external view returns (bool)",
];

export interface RevocationPollerConfig {
  cleanverse: CleanverseConfig;
  chain: string;
  rpcUrl: string;
  pollerPrivateKey: string;
  cviRegistryMirrorAddress: string;
  legateEscrowAddress: string;
  agentMandateAddress: string;
  /** How often to re-check every watched wallet's real A-Pass status. Real REST calls cost
   *  real quota, so this is deliberately not sub-second — a few seconds is enough to make
   *  Scene 3's "proactive freeze" visibly fast without hammering the sandbox. */
  pollIntervalMs?: number;
}

export class RevocationPoller {
  private readonly provider: JsonRpcProvider;
  private readonly mirror: Contract;
  private readonly escrow: Contract;
  private readonly mandate: Contract;
  private readonly config: RevocationPollerConfig;

  /** wallet (lowercase) -> set of open paymentIds where this wallet is sender or recipient. */
  private openPaymentsByWallet = new Map<string, Set<string>>();
  /** principal wallet (lowercase) -> set of agent addresses with an active mandate from them. */
  private activeMandatesByPrincipal = new Map<string, Set<string>>();
  /** wallet (lowercase) -> last real A-Pass status observed (1=active, 2=frozen), or
   *  undefined if never checked. Used to only call the chain on a genuine transition. */
  private lastKnownStatus = new Map<string, 1 | 2>();

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(config: RevocationPollerConfig) {
    this.config = config;
    this.provider = new JsonRpcProvider(config.rpcUrl);
    const signer = new Wallet(config.pollerPrivateKey, this.provider);
    this.mirror = new Contract(config.cviRegistryMirrorAddress, CVI_REGISTRY_MIRROR_ABI, signer);
    this.escrow = new Contract(config.legateEscrowAddress, LEGATE_ESCROW_ABI, this.provider);
    this.mandate = new Contract(config.agentMandateAddress, AGENT_MANDATE_ABI, this.provider);
  }

  /** Scans real historical events to build the initial index, then subscribes to new ones so
   *  the index stays live. Real on-chain data, not synthesized. */
  async start(): Promise<void> {
    await this.buildIndex();
    this.subscribeToLiveEvents();
    const intervalMs = this.config.pollIntervalMs ?? 5000;
    this.intervalHandle = setInterval(() => {
      this.pollOnce().catch((err) => console.error("[poller] tick failed:", err));
    }, intervalMs);
    console.log(`[poller] started, watching ${this.openPaymentsByWallet.size} wallet(s) with open positions, polling every ${intervalMs}ms`);
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.provider.removeAllListeners();
  }

  /** Scans real historical events to (re)build the open-position index without starting the
   *  interval timer or live subscriptions — exposed so a test can drive index-building and
   *  poll ticks explicitly and deterministically, instead of racing a background timer. */
  async buildIndex(): Promise<void> {
    // PaymentEscrowed marks a position open; a payment leaves the watch list once it's
    // observed Settled. (Frozen/Refunded payments are already terminal — freezeByMirror()
    // returning false for an already-non-Escrowed payment makes a second freeze attempt a
    // harmless no-op, so leaving a frozen payment's wallets watched a little longer costs
    // nothing beyond one avoidable REST call, which is an acceptable tradeoff against the
    // complexity of tracking every terminal state precisely here.)
    const [escrowed, settledLogs] = await Promise.all([
      this.escrow.queryFilter(this.escrow.filters.PaymentEscrowed()),
      this.escrow.queryFilter(this.escrow.filters.PaymentSettled()),
    ]);
    const settledIds = new Set(settledLogs.map((l) => this.decodeArgs(l).paymentId as string));

    for (const log of escrowed) {
      const args = this.decodeArgs(log);
      const paymentId = args.paymentId as string;
      if (settledIds.has(paymentId)) continue;
      this.addOpenPayment(args.sender as string, paymentId);
      this.addOpenPayment(args.recipient as string, paymentId);
    }

    const mandateCreated = await this.mandate.queryFilter(this.mandate.filters.MandateCreated());
    const mandateRevoked = new Set(
      (await this.mandate.queryFilter(this.mandate.filters.MandateRevokedEvt())).map((l) => (this.decodeArgs(l).agent as string).toLowerCase()),
    );
    const mandateSuspended = new Set(
      (await this.mandate.queryFilter(this.mandate.filters.MandateSuspended())).map((l) => (this.decodeArgs(l).agent as string).toLowerCase()),
    );
    for (const log of mandateCreated) {
      const args = this.decodeArgs(log);
      const agent = (args.agent as string).toLowerCase();
      if (mandateRevoked.has(agent) || mandateSuspended.has(agent)) continue;
      this.addActiveMandate(args.principal as string, args.agent as string);
    }
  }

  private decodeArgs(log: Log): Record<string, unknown> {
    const parsed = (log as unknown as { args?: Record<string, unknown> }).args;
    return parsed ?? {};
  }

  private subscribeToLiveEvents(): void {
    this.escrow.on(this.escrow.filters.PaymentEscrowed(), (paymentId: string, sender: string, recipient: string) => {
      this.addOpenPayment(sender, paymentId);
      this.addOpenPayment(recipient, paymentId);
    });
    this.escrow.on(this.escrow.filters.PaymentSettled(), (paymentId: string) => {
      this.removeOpenPaymentEverywhere(paymentId);
    });
    this.mandate.on(this.mandate.filters.MandateCreated(), (agent: string, principal: string) => {
      this.addActiveMandate(principal, agent);
    });
    this.mandate.on(this.mandate.filters.MandateRevokedEvt(), (agent: string, principal: string) => {
      this.removeActiveMandate(principal, agent);
    });
    this.mandate.on(this.mandate.filters.MandateSuspended(), (agent: string) => {
      this.removeActiveMandateByAgent(agent);
    });
  }

  private addOpenPayment(wallet: string, paymentId: string): void {
    const key = wallet.toLowerCase();
    if (!this.openPaymentsByWallet.has(key)) this.openPaymentsByWallet.set(key, new Set());
    this.openPaymentsByWallet.get(key)!.add(paymentId);
  }

  private removeOpenPaymentEverywhere(paymentId: string): void {
    for (const set of this.openPaymentsByWallet.values()) set.delete(paymentId);
  }

  private addActiveMandate(principal: string, agent: string): void {
    const key = principal.toLowerCase();
    if (!this.activeMandatesByPrincipal.has(key)) this.activeMandatesByPrincipal.set(key, new Set());
    this.activeMandatesByPrincipal.get(key)!.add(agent);
  }

  private removeActiveMandate(principal: string, agent: string): void {
    this.activeMandatesByPrincipal.get(principal.toLowerCase())?.delete(agent);
  }

  private removeActiveMandateByAgent(agent: string): void {
    for (const set of this.activeMandatesByPrincipal.values()) set.delete(agent);
  }

  private watchedWallets(): Set<string> {
    const wallets = new Set<string>();
    for (const w of this.openPaymentsByWallet.keys()) wallets.add(w);
    for (const w of this.activeMandatesByPrincipal.keys()) wallets.add(w);
    return wallets;
  }

  /** One real check cycle: every watched wallet's real A-Pass status is checked via
   *  Cleanverse's REST API; a detected active->frozen or frozen->active transition triggers
   *  the matching real on-chain call. Exposed publicly so a test can drive exactly one tick
   *  deterministically instead of racing a timer. */
  async pollOnce(): Promise<void> {
    for (const wallet of this.watchedWallets()) {
      const apass = await queryApass(this.config.cleanverse, this.config.chain, wallet);
      if (!apass) continue; // no A-Pass on file — nothing this poller can act on
      const previous = this.lastKnownStatus.get(wallet);
      this.lastKnownStatus.set(wallet, apass.status);

      if (previous === undefined) continue; // first observation — establish baseline, don't act
      if (previous === 1 && apass.status === 2) {
        await this.handleRevocation(wallet);
      } else if (previous === 2 && apass.status === 1) {
        await this.handleReactivation(wallet);
      }
    }
  }

  private async handleRevocation(wallet: string): Promise<void> {
    const openPaymentIds = [...(this.openPaymentsByWallet.get(wallet) ?? [])];
    const mandateAgents = [...(this.activeMandatesByPrincipal.get(wallet) ?? [])];
    console.log(`[poller] REVOCATION detected for ${wallet}: freezing ${openPaymentIds.length} payment(s), suspending ${mandateAgents.length} mandate(s)`);
    const tx = await this.mirror.reportRevocation(wallet, openPaymentIds, mandateAgents);
    await tx.wait();
  }

  private async handleReactivation(wallet: string): Promise<void> {
    console.log(`[poller] REACTIVATION detected for ${wallet}`);
    const tx = await this.mirror.reportReactivation(wallet);
    await tx.wait();
  }
}
