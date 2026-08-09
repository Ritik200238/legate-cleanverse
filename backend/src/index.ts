import express from "express";
import cors from "cors";
import { createX402Router } from "./routes/x402.js";
import { createApiRouter } from "./routes/api.js";
import { RevocationPoller } from "./poller/revocation-poller.js";

const app = express();
app.use(cors());
app.use(express.json());

const rpcUrl = process.env.MONAD_RPC_URL ?? "http://127.0.0.1:8545";
const agentMandateAddress = process.env.AGENT_MANDATE_ADDRESS;
const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
const legateEscrowAddress = process.env.LEGATE_ESCROW_ADDRESS ?? process.env.LEGATE_POOL_ADDRESS;
const travelRuleAnchorAddress = process.env.TRAVEL_RULE_ANCHOR_ADDRESS;
const cleanverseBaseUrl = process.env.CLEANVERSE_BASE_URL ?? "https://uatapi.cleanverse.com/api/cooperate";
const cleanverseApiId = process.env.CLEANVERSE_API_ID;
const chain = process.env.LEGATE_CHAIN ?? "monad";

if (!agentMandateAddress || !relayerPrivateKey) {
  console.error("AGENT_MANDATE_ADDRESS and RELAYER_PRIVATE_KEY must be set");
  process.exit(1);
}
if (!legateEscrowAddress || !travelRuleAnchorAddress || !cleanverseApiId) {
  console.error("LEGATE_ESCROW_ADDRESS, TRAVEL_RULE_ANCHOR_ADDRESS, and CLEANVERSE_API_ID must be set");
  process.exit(1);
}

app.use(createX402Router({ rpcUrl, agentMandateAddress, relayerPrivateKey }));
app.use(
  "/api",
  createApiRouter({
    cleanverse: { baseUrl: cleanverseBaseUrl, apiId: cleanverseApiId, apiKeyBase64: process.env.CLEANVERSE_API_KEY },
    chain,
    rpcUrl,
    pool: legateEscrowAddress,
    legateEscrowAddress,
    agentMandateAddress,
    travelRuleAnchorAddress,
    anchorPrivateKey: process.env.ANCHOR_PRIVATE_KEY,
    adminApiKey: process.env.ADMIN_API_KEY,
  }),
);

// The revocation poller (Scene 3, PRD.md §6) is optional — it needs its own POLLER_ROLE key,
// distinct from every other signer here, and shouldn't block the rest of the backend from
// starting if it isn't configured yet (e.g. before CVI_REGISTRY_MIRROR_ADDRESS is wired up
// for a given deployment).
const cviRegistryMirrorAddress = process.env.CVI_REGISTRY_MIRROR_ADDRESS;
const pollerPrivateKey = process.env.POLLER_PRIVATE_KEY;
if (cviRegistryMirrorAddress && pollerPrivateKey) {
  const poller = new RevocationPoller({
    cleanverse: { baseUrl: cleanverseBaseUrl, apiId: cleanverseApiId, apiKeyBase64: process.env.CLEANVERSE_API_KEY },
    chain,
    rpcUrl,
    pollerPrivateKey,
    cviRegistryMirrorAddress,
    legateEscrowAddress,
    agentMandateAddress,
  });
  poller.start().catch((err) => console.error("[poller] failed to start:", err));
} else {
  console.log("[poller] not configured (CVI_REGISTRY_MIRROR_ADDRESS / POLLER_PRIVATE_KEY unset) — Scene 3's proactive freeze relies on the passive on-chain safety net only.");
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rpcUrl, agentMandateAddress, legateEscrowAddress });
});

// Vercel's Node runtime imports this module to get a request handler; it owns the HTTP
// server itself, so calling app.listen() there would bind a port nothing ever connects to
// and does nothing useful. Everywhere else (local dev, a real long-running host) still needs
// the explicit listen.
if (!process.env.VERCEL) {
  const port = process.env.PORT ?? 4021;
  app.listen(port, () => {
    console.log(`Legate backend listening on :${port}`);
  });
}

export default app;
