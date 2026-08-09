#!/usr/bin/env node
import { Wallet } from "ethers";
import { validatorRegister, validatorIsPaused, CleanverseApiError } from "../src/cleanverse/client.js";
import type { CleanverseConfig } from "../src/cleanverse/client.js";

/**
 * One-time setup: registers the real, deployed LegateEscrow contract as a Cleanverse
 * validator pool on Monad testnet, then sets the corridor's initial compliance rule — via the
 * real REST API, not a hand-rolled on-chain call (see PRD.md §5.1, DECISIONS.md for why REST
 * is the correct path: Cleanverse's backend executes the on-chain register transaction itself
 * and returns tx_hash; we never construct the raw poolCountryBitmap ourselves).
 *
 * Deliberately does NOT call /validator/grant first. That endpoint verifies the owner
 * signature against a contract's on-chain Ownable.owner() for Factory-mode registration — it
 * is not the applicable path for a bare Ownable pool contract, confirmed live on Monad
 * testnet 2026-08-09 (grant returned "Invalid contract owner signature" on this exact
 * deployer/escrow pair; calling /validator/register directly with the same signature scheme
 * over chain+contract_address succeeded immediately, real tx_hash, pool live and unpaused).
 * See DECISIONS.md for the full trail.
 *
 * Prerequisites:
 *   1. LegateEscrow must already be deployed to real Monad testnet
 *      (contracts/script/DeployMonadTestnet.s.sol) — it must be Ownable (it is) since
 *      Cleanverse verifies the owner_signature against the pool's on-chain Ownable.owner().
 *   2. The deployer wallet needs zero MON for this step (it's a pure REST call, no gas) but
 *      DID need MON to deploy the contract in step 1.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... LEGATE_ESCROW_ADDRESS=0x... CLEANVERSE_API_ID=... \
 *     npx tsx scripts/register-validator.ts
 */

const CHAIN = "monad";

async function main() {
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const escrowAddress = process.env.LEGATE_ESCROW_ADDRESS;
  const apiId = process.env.CLEANVERSE_API_ID;
  const apiKeyBase64 = process.env.CLEANVERSE_API_KEY;
  const baseUrl = process.env.CLEANVERSE_BASE_URL ?? "https://uatapi.cleanverse.com/api/cooperate";

  if (!deployerKey || !escrowAddress || !apiId || !apiKeyBase64) {
    console.error("DEPLOYER_PRIVATE_KEY, LEGATE_ESCROW_ADDRESS, CLEANVERSE_API_ID, and CLEANVERSE_API_KEY must all be set");
    process.exit(1);
  }

  const wallet = new Wallet(deployerKey);
  const config: CleanverseConfig = { baseUrl, apiId, apiKeyBase64 };

  console.log(`Deployer: ${wallet.address}`);
  console.log(`Escrow (pool to register): ${escrowAddress}`);
  console.log("");

  // --- Register the pool + set its initial corridor rule, in the same call ---
  // EIP-191 personal_sign over lowercase chain+contract_address, no separator.
  const registerMessage = `${CHAIN}${escrowAddress}`.toLowerCase();
  const registerSignature = await wallet.signMessage(registerMessage);

  // Corridor rule — PRD.md §5.1, resolved 2026-08-08. Tier 30 = enhanced-KYC individual floor
  // for this corridor (Legate's own tier scheme; Cleanverse's docs define only the mechanical
  // 0-99 range, no fixed meaning).
  const rule = {
    allowed_group: "",
    allowed_sub_group: "",
    min_tier: 30,
    min_sub_tier: 0,
    is_black_list: false,
    countries: ["MY", "PH"],
  };

  console.log("");
  console.log("=== POST /validator/register ===");
  try {
    const registerResult = await validatorRegister(config, CHAIN, escrowAddress, rule, registerSignature);
    console.log("Registered. tx_hash:", registerResult.tx_hash);
  } catch (err) {
    if (err instanceof CleanverseApiError) {
      console.error(`FAILED [${err.code}]: ${err.message}`);
      console.error("Raw:", JSON.stringify(err.raw, null, 2));
    }
    throw err;
  }

  // --- Step 3: confirm the pool is now live and unpaused ---
  console.log("");
  console.log("=== Confirming pool state ===");
  const paused = await validatorIsPaused(config, CHAIN, escrowAddress);
  console.log(`Pool paused: ${paused}`);
  if (paused) {
    console.warn("WARNING: pool registered but reports as paused — check with Cleanverse before going live.");
  } else {
    console.log("Pool is live. complianceVerify() calls against this pool will now resolve for real.");
  }
}

main().catch((err) => {
  console.error("Registration failed:", err);
  process.exit(1);
});
