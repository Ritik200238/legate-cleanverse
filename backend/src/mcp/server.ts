#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcProvider, Wallet, type Interface } from "ethers";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { CleanverseConfig } from "../cleanverse/client.js";
import { queryApass, validatorVerify, downloadTravelRule, CleanverseApiError } from "../cleanverse/client.js";
import { previewCompliance } from "../policy-engine/pipeline.js";
import { getAgentMandateContract, getLegateEscrowContract, mapRevertToRefusalReason } from "../chain/contracts.js";

/**
 * Legate MCP server — PRD.md §5.4. Six tools, thin wrappers over the real Cleanverse client
 * and the real on-chain AgentMandate contract. Any MCP-speaking agent (Claude, or any other
 * client) can drive compliant payments through this server — and the refusals come from the
 * real on-chain contract, not the model or this server's own say-so. That is the whole
 * thesis of the agent-payment half of Legate: compliance holds even if the calling agent is
 * dumb, malicious, or jailbroken, because the enforcement point is the chain, not the tool.
 */

interface McpConfig {
  cleanverse: CleanverseConfig;
  chain: string;
  pool: string; // registered validator pool address (LegateEscrow)
  rpcUrl: string;
  agentMandateAddress: string;
  /** Same address as `pool` in practice (LegateEscrow is the registered validator pool) —
   *  kept as a separate field since the two contracts are read through different ABIs. */
  legateEscrowAddress: string;
  /** Each MCP server instance acts on behalf of one specific agent wallet — that wallet's
   *  key signs the on-chain execute() call, so mandates[msg.sender] resolves correctly. */
  agentPrivateKey: string;
}

const inMemoryDecisionLog: Array<{
  paymentId?: string;
  recipient: string;
  amount: string;
  allowed: boolean;
  reason?: string;
  timestamp: number;
}> = [];

export function buildLegateMcpServer(config: McpConfig): Server {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const agentWallet = new Wallet(config.agentPrivateKey, provider);
  const mandateContract = getAgentMandateContract(config.agentMandateAddress, agentWallet);
  const mandateInterface: Interface = mandateContract.interface;
  const escrowContract = getLegateEscrowContract(config.legateEscrowAddress, provider);

  const server = new Server({ name: "legate", version: "0.1.0" }, { capabilities: { tools: {} } });

  const tools = [
    {
      name: "verify_recipient",
      description: "Check a wallet's real Cleanverse A-Pass status, tier, and whether it can currently receive a compliant payment.",
      inputSchema: {
        type: "object",
        properties: { address: { type: "string", description: "EVM address to check" } },
        required: ["address"],
      },
    },
    {
      name: "get_quote",
      description:
        "Get Legate's real on-chain protocol fee for a payment plus a compliance preview (does not execute anything on-chain). Agent payments settle in aUSDC end-to-end on Monad — no fiat conversion is involved, so this does not return an FX rate (Cleanverse's Fiat Ramp does not currently settle on Monad; see DECISIONS.md).",
      inputSchema: {
        type: "object",
        properties: {
          recipient: { type: "string" },
          amountBaseUnits: { type: "string", description: "Amount in A-Token base units (aUSDC has 18 decimals on Monad — verify with the token's own decimals(), do not assume)" },
        },
        required: ["recipient", "amountBaseUnits"],
      },
    },
    {
      name: "send_payment",
      description:
        "Execute a compliant payment through this agent's mandate. Runs the real on-chain AgentMandate.execute() call — refusals (cap exceeded, recipient not compliant, mandate expired/revoked) come from the real contract, not this tool.",
      inputSchema: {
        type: "object",
        properties: {
          recipient: { type: "string" },
          amountBaseUnits: { type: "string" },
          memo: { type: "string" },
        },
        required: ["recipient", "amountBaseUnits"],
      },
    },
    {
      name: "check_mandate",
      description: "Read this agent's current mandate: caps, amount spent today, amount remaining, expiry, active status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_audit_report",
      description: "Retrieve the real Cleanverse Travel Rule / Transaction compliance report for a settled payment, given its on-chain transaction hash.",
      inputSchema: {
        type: "object",
        properties: { txHash: { type: "string" }, walletAddress: { type: "string" } },
        required: ["txHash", "walletAddress"],
      },
    },
    {
      name: "list_transactions",
      description: "List this session's payment attempts (allowed and refused) with their compliance outcome — the local decision log, not a full chain history.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "verify_recipient": {
          const { address } = z.object({ address: z.string() }).parse(args);
          const apass = await queryApass(config.cleanverse, config.chain, address);
          if (!apass) {
            return textResult({ address, hasApass: false, canReceive: false });
          }
          // validator/verify throws code 12027 ("on-chain read failed") if the pool isn't in
          // a verifiable state (not yet registered, or paused) — a real, expected condition
          // pre-registration, not a bug to hide behind the generic error handler.
          try {
            const valid = await validatorVerify(config.cleanverse, config.chain, config.pool, address);
            return textResult({
              address,
              hasApass: true,
              tier: apass.tier,
              group: apass.group,
              status: apass.status === 1 ? "active" : "frozen",
              canReceive: valid.valid,
            });
          } catch (err) {
            if (err instanceof CleanverseApiError && err.code === "12027") {
              return textResult({
                address,
                hasApass: true,
                tier: apass.tier,
                group: apass.group,
                status: apass.status === 1 ? "active" : "frozen",
                canReceive: null,
                note: "Legate's pool is not yet in a verifiable state on the real Cleanverse validator (not registered yet, or paused) — A-Pass status is real, but on-chain compliance for this pool cannot be previewed right now.",
              });
            }
            throw err;
          }
        }

        case "get_quote": {
          const { recipient, amountBaseUnits } = z
            .object({ recipient: z.string(), amountBaseUnits: z.string() })
            .parse(args);
          const [preview, feeBps] = await Promise.all([
            previewCompliance(config.cleanverse, {
              chain: config.chain,
              pool: config.pool,
              sender: agentWallet.address,
              recipient,
            }),
            escrowContract.feeBps() as Promise<bigint>,
          ]);
          const amount = BigInt(amountBaseUnits);
          const feeBaseUnits = (amount * feeBps) / 10_000n;
          return textResult({
            recipient,
            amountBaseUnits,
            feeBps: feeBps.toString(),
            feeBaseUnits: feeBaseUnits.toString(),
            netToRecipientBaseUnits: (amount - feeBaseUnits).toString(),
            compliancePreview: preview,
          });
        }

        case "send_payment": {
          const { recipient, amountBaseUnits, memo } = z
            .object({ recipient: z.string(), amountBaseUnits: z.string(), memo: z.string().optional() })
            .parse(args);

          try {
            const tx = await mandateContract.execute(recipient, BigInt(amountBaseUnits));
            const receipt = await tx.wait();
            inMemoryDecisionLog.push({
              paymentId: receipt.hash,
              recipient,
              amount: amountBaseUnits,
              allowed: true,
              timestamp: Date.now(),
            });
            return textResult({
              status: "settled",
              txHash: receipt.hash,
              receiptUrl: `/receipt/${receipt.hash}`,
              memo,
            });
          } catch (err) {
            const decoded = decodeRevertReason(err, mandateInterface);
            const reason = mapRevertToRefusalReason(decoded);
            inMemoryDecisionLog.push({ recipient, amount: amountBaseUnits, allowed: false, reason, timestamp: Date.now() });
            return textResult({
              status: "refused",
              reason,
              detail: `Refused by the on-chain compliance gate: ${decoded ?? "unknown reason"}. This is not the agent's decision — the contract enforced it.`,
            });
          }
        }

        case "check_mandate": {
          const m = await mandateContract.getMandate(agentWallet.address);
          return textResult({
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
        }

        case "get_audit_report": {
          const { txHash, walletAddress } = z.object({ txHash: z.string(), walletAddress: z.string() }).parse(args);
          const report = await downloadTravelRule(config.cleanverse, {
            txHash,
            chain: config.chain,
            address: walletAddress,
          });
          return textResult({ txHash, report });
        }

        case "list_transactions": {
          return textResult({ transactions: inMemoryDecisionLog });
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return textResult({ error: err instanceof Error ? err.message : String(err) }, true);
    }
  });

  return server;
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

/** Same decode logic as src/routes/x402.ts's decodeRevertReason — extracts the real Solidity
 *  custom-error name from an ethers.js contract-call revert via ABI decoding, never a string
 *  guess. Duplicated (not imported) because the x402 router doesn't export it; kept identical
 *  on purpose so both call sites report the same reason for the same on-chain revert. */
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

// Allow running this file directly as a stdio MCP server for real agent clients (e.g. Claude
// Desktop, or `send_payment`-driven demos) once contracts are deployed and env vars are set.
async function main() {
  const config: McpConfig = {
    cleanverse: {
      baseUrl: process.env.CLEANVERSE_BASE_URL ?? "https://uatapi.cleanverse.com/api/cooperate",
      apiId: process.env.CLEANVERSE_API_ID ?? "",
      apiKeyBase64: process.env.CLEANVERSE_API_KEY,
    },
    chain: process.env.LEGATE_CHAIN ?? "monad",
    // Real, previously-missing bug: this fallback was one-directional (only
    // legateEscrowAddress below fell back to the other var) — every other real config
    // surface in this project (index.ts, register-validator.ts, web/.env.local) uses only
    // LEGATE_ESCROW_ADDRESS, so a standalone MCP server run following that established
    // convention silently got pool="" and sent contract_address:"" to Cleanverse on every
    // compliance call. See DECISIONS.md.
    pool: process.env.LEGATE_POOL_ADDRESS ?? process.env.LEGATE_ESCROW_ADDRESS ?? "",
    rpcUrl: process.env.MONAD_RPC_URL ?? "http://127.0.0.1:8545",
    agentMandateAddress: process.env.AGENT_MANDATE_ADDRESS ?? "",
    legateEscrowAddress: process.env.LEGATE_ESCROW_ADDRESS ?? process.env.LEGATE_POOL_ADDRESS ?? "",
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY ?? "",
  };

  const server = buildLegateMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Cross-platform entry-point check: file://${process.argv[1]} breaks on Windows because
// process.argv[1] uses backslashes and lacks the extra leading slash file: URLs need —
// pathToFileURL() normalizes both platforms correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Legate MCP server failed to start:", err);
    process.exit(1);
  });
}
