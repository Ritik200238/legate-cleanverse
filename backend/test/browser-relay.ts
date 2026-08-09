import express from "express";
import cors from "cors";
import { JsonRpcProvider, Wallet } from "ethers";

/**
 * TEST-ONLY utility, not part of the shipped product. Browser automation tools in this
 * environment connect to a Chrome instance that cannot reach this sandbox's localhost
 * directly — so the real local Anvil RPC and a real wallet signer are exposed through this
 * relay (itself reached via a tunnel), letting the browser's injected window.ethereum shim
 * submit genuinely signed, genuinely broadcast transactions against the real local chain.
 * No application logic is mocked: this only stands in for the browser-extension wallet UI
 * (MetaMask) that isn't installed in the automated browser, using real anvil test private
 * keys that hold zero real value.
 *
 * Usage: TEST_PRIVATE_KEYS="0xkey1,0xkey2" RPC_URL=http://127.0.0.1:8545 PORT=8546 \
 *   npx tsx test/browser-relay.ts
 */

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT ?? 8546);
const keys = (process.env.TEST_PRIVATE_KEYS ?? "").split(",").filter(Boolean);
if (keys.length === 0) {
  console.error("TEST_PRIVATE_KEYS must be set (comma-separated 0x... private keys)");
  process.exit(1);
}

const provider = new JsonRpcProvider(RPC_URL);
const wallets = new Map<string, Wallet>();
for (const key of keys) {
  const wallet = new Wallet(key, provider);
  wallets.set(wallet.address.toLowerCase(), wallet);
}
const defaultAccount = [...wallets.values()][0].address;

const app = express();
app.use(cors());
app.use(express.json());

app.post("/", async (req, res) => {
  const { method, params, id } = req.body as { method: string; params?: unknown[]; id: number };
  try {
    let result: unknown;
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        result = [...wallets.keys()].length ? [defaultAccount] : [];
        break;
      case "eth_sendTransaction": {
        const tx = (params?.[0] ?? {}) as { from: string; to?: string; data?: string; value?: string; gas?: string };
        const wallet = wallets.get(tx.from.toLowerCase());
        if (!wallet) throw { code: 4001, message: `No test key configured for ${tx.from}` };
        const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined });
        result = sent.hash;
        break;
      }
      case "personal_sign": {
        const [message, address] = (params ?? []) as [string, string];
        const wallet = wallets.get(address.toLowerCase());
        if (!wallet) throw { code: 4001, message: `No test key configured for ${address}` };
        result = await wallet.signMessage(message);
        break;
      }
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        result = null;
        break;
      default:
        // Generic pass-through to the real chain for every other JSON-RPC method
        // (eth_call, eth_getLogs, eth_chainId, eth_blockNumber, eth_getTransactionReceipt...).
        result = await provider.send(method, params ?? []);
    }
    res.json({ jsonrpc: "2.0", id, result });
  } catch (err) {
    const e = err as { code?: number; message?: string; shortMessage?: string; data?: string };
    console.error(`[relay] ${method} failed:`, e.message ?? err);
    res.json({
      jsonrpc: "2.0",
      id,
      error: { code: e.code ?? -32000, message: e.shortMessage ?? e.message ?? String(err), data: e.data },
    });
  }
});

app.listen(PORT, () => {
  console.log(`Browser test relay listening on :${PORT}, proxying to ${RPC_URL}`);
  console.log(`Configured accounts: ${[...wallets.keys()].join(", ")}`);
});
