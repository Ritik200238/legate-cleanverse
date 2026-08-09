import { Router, type Request, type Response } from "express";
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes, type Interface } from "ethers";
import type { CleanverseConfig } from "../cleanverse/client.js";
import {
  queryApass,
  validatorVerify,
  downloadTravelRule,
  queryRampQuote,
  queryRampPaymentMethods,
  createRampWidgetUrl,
  CleanverseApiError,
} from "../cleanverse/client.js";
import { previewCompliance } from "../policy-engine/pipeline.js";
import {
  getAgentMandateContract,
  getLegateEscrowContract,
  getTravelRuleAnchorContract,
  mapRevertToRefusalReason,
} from "../chain/contracts.js";

/**
 * Read-oriented REST API for the web app's five views (PRD.md §5.5). State-changing payment
 * actions (approve, initiate, settle) are signed and submitted directly from the user's own
 * wallet in the browser — this backend never custodies funds or relays human transactions.
 * Its job here is exactly the same "gas-free preview + real off-chain data" role described in
 * §3: recipient/quote previews, on-chain payment/mandate reads, and the one genuinely
 * backend-only action (anchoring a Travel Rule report hash — TravelRuleAnchor.anchor() is
 * ANCHOR_ROLE-gated by design, never a user action).
 */

export interface ApiConfig {
  cleanverse: CleanverseConfig;
  chain: string;
  rpcUrl: string;
  pool: string; // LegateEscrow address, also the registered validator pool
  legateEscrowAddress: string;
  agentMandateAddress: string;
  travelRuleAnchorAddress: string;
  /** Signs the one backend-initiated on-chain action: anchoring a Travel Rule report hash.
   *  Must hold ANCHOR_ROLE on TravelRuleAnchor. */
  anchorPrivateKey?: string;
  /** Shared secret required (via the X-Admin-Key header) to call the anchor-travel-rule
   *  route. Real, previously-missing gap: that route spends real gas, a real Cleanverse API
   *  quota, and signs a real on-chain tx from a dedicated wallet — every paymentId is public
   *  (emitted in PaymentEscrowed/PaymentSettled), so without this it was callable by anyone
   *  who discovered one, unauthenticated. See DECISIONS.md. */
  adminApiKey?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PAYMENT_ID_RE = /^0x[0-9a-fA-F]{64}$/;

export function createApiRouter(config: ApiConfig): Router {
  const router = Router();
  const provider = new JsonRpcProvider(config.rpcUrl);
  const escrowContract = getLegateEscrowContract(config.legateEscrowAddress, provider);
  const mandateContract = getAgentMandateContract(config.agentMandateAddress, provider);
  const anchorContract = getTravelRuleAnchorContract(config.travelRuleAnchorAddress, provider);
  const escrowInterface: Interface = escrowContract.interface;

  // --- Recipient / quote previews (Send, Claim, Auditor) ---

  router.get("/recipient/:address", async (req: Request, res: Response) => {
    const { address } = req.params;
    if (!ADDRESS_RE.test(address)) {
      res.status(400).json({ error: "address must be a 20-byte hex string" });
      return;
    }
    try {
      const apass = await queryApass(config.cleanverse, config.chain, address);
      if (!apass) {
        res.json({ address, hasApass: false, canReceive: false });
        return;
      }
      try {
        const valid = await validatorVerify(config.cleanverse, config.chain, config.pool, address);
        res.json({
          address,
          hasApass: true,
          tier: apass.tier,
          group: apass.group,
          status: apass.status === 1 ? "active" : "frozen",
          canReceive: valid.valid,
        });
      } catch (err) {
        if (err instanceof CleanverseApiError && err.code === "12027") {
          res.json({
            address,
            hasApass: true,
            tier: apass.tier,
            group: apass.group,
            status: apass.status === 1 ? "active" : "frozen",
            canReceive: null,
            note: "Legate's pool is not yet in a verifiable state on the real Cleanverse validator (not registered yet, or paused).",
          });
          return;
        }
        throw err;
      }
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/quote", async (req: Request, res: Response) => {
    const { sender, recipient, amount } = req.query;
    if (typeof sender !== "string" || typeof recipient !== "string" || typeof amount !== "string") {
      res.status(400).json({ error: "sender, recipient, and amount query params are required" });
      return;
    }
    if (!ADDRESS_RE.test(sender) || !ADDRESS_RE.test(recipient)) {
      res.status(400).json({ error: "sender and recipient must be 20-byte hex addresses" });
      return;
    }
    if (!/^[0-9]+$/.test(amount)) {
      res.status(400).json({ error: "amount must be a non-negative integer string (base units)" });
      return;
    }
    try {
      const amt = BigInt(amount);
      const [preview, feeBps] = await Promise.all([
        previewCompliance(config.cleanverse, {
          chain: config.chain,
          pool: config.pool,
          sender,
          recipient,
          // The quote is the one place a user is told "this will work" before spending gas, so
          // it has to consult all three enforcement layers — Cleanverse's identity check plus
          // the corridor caps and any operator rules the chain is actually running. An
          // identity-only preview here would confidently green-light a payment the contract
          // then refuses.
          onChain: {
            rpcUrl: config.rpcUrl,
            escrowAddress: config.legateEscrowAddress,
            amountBaseUnits: amt,
          },
        }),
        escrowContract.feeBps() as Promise<bigint>,
      ]);
      const fee = (amt * feeBps) / 10_000n;
      res.json({
        sender,
        recipient,
        amountBaseUnits: amount,
        feeBps: feeBps.toString(),
        feeBaseUnits: fee.toString(),
        netToRecipientBaseUnits: (amt - fee).toString(),
        compliancePreview: preview,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Fiat Ramp (Send/Claim MYR<->USDC<->PHP legs — live-verified network: "base", see
  //     DECISIONS.md; Cleanverse's ramp does not currently settle on Monad despite the docs) ---

  router.get("/ramp/payment-methods", async (_req: Request, res: Response) => {
    try {
      const methods = await queryRampPaymentMethods(config.cleanverse);
      res.json({ methods });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/ramp/quote", async (req: Request, res: Response) => {
    const { fiatCurrency, cryptoCurrency, isBuyOrSell, paymentMethod, fiatAmount, cryptoAmount } = req.body as {
      fiatCurrency?: string;
      cryptoCurrency?: string;
      isBuyOrSell?: "BUY" | "SELL";
      paymentMethod?: string;
      fiatAmount?: number;
      cryptoAmount?: number;
    };
    if (!fiatCurrency || !cryptoCurrency || !isBuyOrSell || !paymentMethod) {
      res.status(400).json({ error: "fiatCurrency, cryptoCurrency, isBuyOrSell, and paymentMethod are required" });
      return;
    }
    try {
      const quote = await queryRampQuote(config.cleanverse, {
        fiatCurrency,
        cryptoCurrency,
        isBuyOrSell,
        network: "base", // live-verified working network — see DECISIONS.md Monad-ramp finding
        paymentMethod,
        fiatAmount,
        cryptoAmount,
      });
      res.json(quote);
    } catch (err) {
      if (err instanceof CleanverseApiError) {
        res.status(502).json({ error: err.message, code: err.code });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/ramp/widget", async (req: Request, res: Response) => {
    const { quoteToken, walletAddress, walletChain, email } = req.body as {
      quoteToken?: string;
      walletAddress?: string;
      walletChain?: string;
      email?: string;
    };
    if (!quoteToken || !walletAddress || !walletChain) {
      res.status(400).json({ error: "quoteToken, walletAddress, and walletChain are required" });
      return;
    }
    try {
      const widget = await createRampWidgetUrl(config.cleanverse, { quoteToken, walletAddress, walletChain, email });
      res.json(widget);
    } catch (err) {
      if (err instanceof CleanverseApiError) {
        res.status(502).json({ error: err.message, code: err.code });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- On-chain payment reads (Auditor, receipt permalink) ---

  router.get("/payment/:paymentId", async (req: Request, res: Response) => {
    const { paymentId } = req.params;
    if (!PAYMENT_ID_RE.test(paymentId)) {
      res.status(400).json({ error: "paymentId must be a 32-byte hex string" });
      return;
    }
    try {
      const payment = await escrowContract.getPayment(paymentId);
      if (payment.state === 0n || Number(payment.state) === 0) {
        res.status(404).json({ error: "No payment found for this paymentId" });
        return;
      }

      const stateNames = ["None", "Escrowed", "Settled", "Frozen", "Refunded"];

      let settlementTxHash: string | null = null;
      if (Number(payment.state) === 2) {
        // PaymentSettled is indexed by paymentId — the real, on-chain source of truth for
        // which tx settled this payment (LegateEscrow doesn't store this in the struct).
        const logs = await provider.getLogs({
          address: config.legateEscrowAddress,
          topics: [escrowInterface.getEvent("PaymentSettled")!.topicHash, paymentId],
          fromBlock: 0,
          toBlock: "latest",
        });
        settlementTxHash = logs.length > 0 ? logs[logs.length - 1].transactionHash : null;
      }

      const anchor = await anchorContract.getAnchor(paymentId);
      const hasAnchor = Number(anchor.anchoredAt) !== 0;

      res.json({
        paymentId,
        sender: payment.sender,
        recipient: payment.recipient,
        amountBaseUnits: payment.amount.toString(),
        state: stateNames[Number(payment.state)] ?? "Unknown",
        createdAt: Number(payment.createdAt),
        settledAt: Number(payment.settledAt) || null,
        // The point past which the SENDER can reclaim this payment themselves via
        // LegateEscrow.reclaimExpired() if the recipient never claimed it. Zero for payments
        // that were never escrowed in the first place (agent-mandate settlements land
        // directly in Settled). See LegateEscrow.CLAIM_WINDOW.
        claimDeadline: Number(payment.claimDeadline) || null,
        settlementTxHash,
        travelRuleAnchor: hasAnchor
          ? {
              reportHash: anchor.reportHash,
              settlementTxHash: anchor.settlementTxHash,
              anchoredAt: Number(anchor.anchoredAt),
            }
          : null,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Backend-only action: pulls Cleanverse's real Travel Rule report for a settled payment's
   *  tx, hashes it (never stores or forwards the report contents), and anchors the hash
   *  on-chain. Requires ANCHOR_ROLE — server holds that key, no user ever calls this. */
  router.post("/payment/:paymentId/anchor-travel-rule", async (req: Request, res: Response) => {
    const { paymentId } = req.params;
    if (!config.anchorPrivateKey) {
      res.status(501).json({ error: "Anchoring is not configured on this server (ANCHOR_PRIVATE_KEY not set)" });
      return;
    }
    if (!config.adminApiKey) {
      res.status(501).json({ error: "Anchoring is not configured on this server (ADMIN_API_KEY not set)" });
      return;
    }
    if (req.header("X-Admin-Key") !== config.adminApiKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!PAYMENT_ID_RE.test(paymentId)) {
      res.status(400).json({ error: "paymentId must be a 32-byte hex string" });
      return;
    }
    try {
      const payment = await escrowContract.getPayment(paymentId);
      if (Number(payment.state) !== 2) {
        res.status(409).json({ error: "Payment is not Settled — cannot anchor a report yet" });
        return;
      }
      const logs = await provider.getLogs({
        address: config.legateEscrowAddress,
        topics: [escrowInterface.getEvent("PaymentSettled")!.topicHash, paymentId],
        fromBlock: 0,
        toBlock: "latest",
      });
      if (logs.length === 0) {
        res.status(404).json({ error: "No PaymentSettled log found for this paymentId" });
        return;
      }
      const settlementTxHash = logs[logs.length - 1].transactionHash;

      const report = await downloadTravelRule(config.cleanverse, {
        txHash: settlementTxHash,
        chain: config.chain,
        address: payment.recipient,
      });
      const reportHash = keccak256(toUtf8Bytes(JSON.stringify({ downloadUrl: report.downloadUrl, fileName: report.fileName })));

      const signer = new Wallet(config.anchorPrivateKey, provider);
      const anchorWithSigner = getTravelRuleAnchorContract(config.travelRuleAnchorAddress, signer);
      const tx = await anchorWithSigner.anchor(paymentId, reportHash, settlementTxHash);
      const receipt = await tx.wait();

      res.json({
        paymentId,
        settlementTxHash,
        reportHash,
        anchorTxHash: receipt.hash,
        report,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Mandate reads (Agent Console) ---

  router.get("/mandate/:agentAddress", async (req: Request, res: Response) => {
    const { agentAddress } = req.params;
    if (!ADDRESS_RE.test(agentAddress)) {
      res.status(400).json({ error: "agentAddress must be a 20-byte hex string" });
      return;
    }
    try {
      const m = await mandateContract.getMandate(agentAddress);
      res.json({
        agentAddress,
        principal: m.principal,
        perTxCap: m.perTxCap.toString(),
        dailyCap: m.dailyCap.toString(),
        totalCap: m.totalCap.toString(),
        spentToday: m.spentToday.toString(),
        spentTotal: m.spentTotal.toString(),
        dailyRemaining: (m.dailyCap - m.spentToday).toString(),
        totalRemaining: (m.totalCap - m.spentTotal).toString(),
        expiry: Number(m.expiry),
        active: m.active,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Static contract/refusal-reason config the frontend needs to decode its own reverts ---

  router.get("/config", (_req: Request, res: Response) => {
    res.json({
      chain: config.chain,
      pool: config.pool,
      legateEscrowAddress: config.legateEscrowAddress,
      agentMandateAddress: config.agentMandateAddress,
      travelRuleAnchorAddress: config.travelRuleAnchorAddress,
    });
  });

  return router;
}

export { mapRevertToRefusalReason };
