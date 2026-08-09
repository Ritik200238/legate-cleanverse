import { Router, type Request, type Response } from "express";
import { JsonRpcProvider, Wallet, type Interface } from "ethers";
import { getAgentMandateContract, mapRevertToRefusalReason } from "../chain/contracts.js";

/**
 * x402 compliance middleware — PRD.md §5.3. Standard x402 flow (HTTP 402 Payment Required),
 * completed with a compliance extension. The actual enforcement is the on-chain
 * AgentMandate.execute() call — this middleware is a thin HTTP wrapper around that real
 * transaction, not a second gate of its own. If the on-chain call reverts, the refusal
 * reason IS the contract's typed revert, mapped to a stable string code — never invented.
 */

export interface X402Config {
  rpcUrl: string;
  agentMandateAddress: string;
  /** The relayer/agent-facing signer this backend uses to submit transactions on behalf of
   *  whichever agent wallet is calling — in production each agent would sign its own tx from
   *  its own wallet via a connected client; this relayer pattern is documented here as a
   *  build-time simplification, not hidden. */
  relayerPrivateKey: string;
}

interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string; // A-Token address
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description: string;
  // Legate's compliance extension to the standard x402 payment-requirements object:
  compliance: {
    principalCviProof: "required";
    mandateRef: "required";
  };
}

export function createX402Router(config: X402Config): Router {
  const router = Router();
  const provider = new JsonRpcProvider(config.rpcUrl);
  const relayer = new Wallet(config.relayerPrivateKey, provider);
  const mandateContract = getAgentMandateContract(config.agentMandateAddress, relayer);
  const mandateInterface: Interface = mandateContract.interface;

  /**
   * GET /pay/:invoiceId — returns 402 with payment + compliance requirements if unpaid.
   * A real invoice store would look this up; for the four demo scenes, invoices are
   * synthesized from query params (amount, recipient) since there's no separate invoicing
   * product being built here — the payment itself is the deliverable.
   */
  router.get("/pay/:invoiceId", (req: Request, res: Response) => {
    const { recipient, amount } = req.query;
    if (typeof recipient !== "string" || typeof amount !== "string") {
      res.status(400).json({ error: "recipient and amount query params are required" });
      return;
    }

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "monad-testnet",
      asset: process.env.LEGATE_ATOKEN_ADDRESS ?? "",
      maxAmountRequired: amount,
      payTo: recipient,
      resource: req.originalUrl,
      description: `Legate compliant payment — invoice ${req.params.invoiceId}`,
      compliance: {
        principalCviProof: "required",
        mandateRef: "required",
      },
    };

    res.status(402).json(requirements);
  });

  /**
   * POST /pay/:invoiceId — agent submits payment authorization. Runs the real on-chain
   * AgentMandate.execute() call (the agent's mandate must already exist — see MCP server's
   * check_mandate tool). Success: 200 + receipt. Failure: 403 + structured refusal reason
   * taken directly from the contract's typed revert.
   */
  router.post("/pay/:invoiceId", async (req: Request, res: Response) => {
    const { agentAddress, recipient, amount } = req.body as { agentAddress?: string; recipient?: string; amount?: string };
    if (!agentAddress || !recipient || !amount) {
      res.status(400).json({ error: "agentAddress, recipient, and amount are required" });
      return;
    }
    // This build uses a single, fixed relayer identity as msg.sender for every execute()
    // call (a disclosed build-time simplification — see X402Config.relayerPrivateKey's
    // comment). Real, previously-missing bug: agentAddress was validated as required but
    // never actually checked against who signs the transaction, silently ignoring whatever
    // identity the caller claimed — a caller supplying a different agent's address got no
    // error and no indication their claimed identity had no effect. Rejecting a mismatch
    // here keeps that limitation honest instead of silent; see DECISIONS.md.
    if (agentAddress.toLowerCase() !== relayer.address.toLowerCase()) {
      res.status(400).json({
        error: "Unsupported agent identity",
        detail: `This deployment's x402 endpoint only executes as its single configured relayer identity (${relayer.address}), a disclosed build-time simplification — it cannot sign on behalf of a different agentAddress (${agentAddress}).`,
      });
      return;
    }

    try {
      const tx = await mandateContract.execute(recipient, BigInt(amount));
      const receipt = await tx.wait();

      res.status(200).json({
        status: "settled",
        txHash: receipt.hash,
        receiptUrl: `/receipt/${receipt.hash}`,
      });
    } catch (err: unknown) {
      const decoded = decodeRevertReason(err, mandateInterface);
      res.status(403).json({
        error: "Compliance Refused",
        reason: mapRevertToRefusalReason(decoded),
        detail: `The on-chain compliance gate refused this payment: ${decoded ?? "unknown reason"}`,
      });
    }
  });

  return router;
}

/** Extracts the custom-error name from an ethers.js contract-call revert, if present. */
function decodeRevertReason(err: unknown, iface: Interface): string | undefined {
  const anyErr = err as { data?: string; error?: { data?: string } };
  const data = anyErr?.data ?? anyErr?.error?.data;
  if (!data) return undefined;
  try {
    const parsed = iface.parseError(data);
    return parsed?.name;
  } catch {
    return undefined;
  }
}
