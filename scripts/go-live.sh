#!/usr/bin/env bash
# Legate — the real Monad testnet deploy, collapsed to one command.
#
# Every step here was previously done by hand, one at a time, reading addresses off a
# console and retyping them into the next command. That's exactly the kind of place a typo
# costs the last hour before a deadline. This script automates only the part that's already
# been dry-run tested end to end against a forked chain (see DECISIONS.md, 2026-08-09): the
# contract deploy itself, plus pulling the real deployed addresses back out of Foundry's own
# broadcast record rather than a human re-typing them.
#
# It deliberately does NOT chase registration/backend-deploy/web-redeploy — those touch real
# external systems (Cleanverse's REST API, a fresh Vercel project) this script has never been
# run against for real, and chaining untested steps with `set -e` risks a confusing failure
# mid-sequence with no way to tell what already happened. Instead it prints the exact
# next commands, with the real addresses already substituted in, ready to paste.
#
# Required:
#   DEPLOYER_PRIVATE_KEY   the funded wallet's private key
# Optional:
#   A_TOKEN_ADDRESS        override if a fresh query_deposit_atoken_list check disagrees
#                          with the script's built-in default (it has flip-flopped once
#                          already — see DECISIONS.md before skipping this check)
#   POLLER_ADDRESS         grants POLLER_ROLE at deploy time if set
set -euo pipefail

: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY to the funded deployer key}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${MONAD_RPC_URL:-https://testnet-rpc.monad.xyz}"

echo "=== Step 0: confirming the deployer wallet actually has gas ==="
DEPLOYER_ADDRESS="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
BALANCE_WEI="$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")"
echo "Deployer: $DEPLOYER_ADDRESS"
echo "Balance:  $(cast --to-unit "$BALANCE_WEI" ether) MON"
if [ "$BALANCE_WEI" = "0" ]; then
  echo "Deployer has 0 MON — fund via faucet.monad.xyz first. Aborting." >&2
  exit 1
fi

echo ""
echo "=== Step 1: deploying the real stack to Monad testnet ==="
echo "(re-verify A_TOKEN_ADDRESS live via query_deposit_atoken_list before this if it's been"
echo " more than a few hours since the last check — see DECISIONS.md's flip-flop entry)"
cd "$ROOT/contracts"
DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  ${A_TOKEN_ADDRESS:+A_TOKEN_ADDRESS="$A_TOKEN_ADDRESS"} \
  ${POLLER_ADDRESS:+POLLER_ADDRESS="$POLLER_ADDRESS"} \
  forge script script/DeployMonadTestnet.s.sol:DeployMonadTestnet \
  --rpc-url "$RPC_URL" --broadcast -vvvv

echo ""
echo "=== Step 2: pulling the real deployed addresses out of Foundry's broadcast record ==="
BROADCAST_FILE="$ROOT/contracts/broadcast/DeployMonadTestnet.s.sol/10143/run-latest.json"
if [ ! -f "$BROADCAST_FILE" ]; then
  echo "No broadcast file at $BROADCAST_FILE — deploy above may have failed silently. Check output." >&2
  exit 1
fi

EXTRACT_JS="$ROOT/scripts/.extract-addresses.js"
cat > "$EXTRACT_JS" <<'JSEOF'
const fs = require("fs");
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const byName = {};
for (const tx of data.transactions) {
  if (tx.transactionType === "CREATE" && !byName[tx.contractName]) {
    byName[tx.contractName] = tx.contractAddress;
  }
}
console.log(JSON.stringify(byName));
JSEOF

ADDRESSES_JSON="$(node "$EXTRACT_JS" "$BROADCAST_FILE")"
rm -f "$EXTRACT_JS"

ESCROW="$(node -e 'console.log(JSON.parse(process.argv[1]).LegateEscrow)' "$ADDRESSES_JSON")"
GATE="$(node -e 'console.log(JSON.parse(process.argv[1]).ComplianceGate)' "$ADDRESSES_JSON")"
MANDATE="$(node -e 'console.log(JSON.parse(process.argv[1]).AgentMandate)' "$ADDRESSES_JSON")"
MIRROR="$(node -e 'console.log(JSON.parse(process.argv[1]).CVIRegistryMirror)' "$ADDRESSES_JSON")"
ANCHOR="$(node -e 'console.log(JSON.parse(process.argv[1]).TravelRuleAnchor)' "$ADDRESSES_JSON")"
RULE="$(node -e 'console.log(JSON.parse(process.argv[1]).StructuringRule)' "$ADDRESSES_JSON")"

echo "LegateEscrow:       $ESCROW"
echo "ComplianceGate:     $GATE"
echo "AgentMandate:       $MANDATE"
echo "CVIRegistryMirror:  $MIRROR"
echo "TravelRuleAnchor:   $ANCHOR"
echo "StructuringRule:    $RULE"

if [ -z "$ESCROW" ] || [ "$ESCROW" = "undefined" ]; then
  echo "Could not extract LegateEscrow's address from the broadcast file — inspect it by hand: $BROADCAST_FILE" >&2
  exit 1
fi

echo ""
echo "=== Deploy complete. Next commands — copy-paste, addresses already filled in. ==="
echo ""
echo "# Step 3: register the pool with Cleanverse's real validator (needs CLEANVERSE_API_KEY):"
echo "cd $ROOT/backend"
echo "DEPLOYER_PRIVATE_KEY=\"\$DEPLOYER_PRIVATE_KEY\" LEGATE_ESCROW_ADDRESS=$ESCROW CLEANVERSE_API_ID=\"\$CLEANVERSE_API_ID\" CLEANVERSE_API_KEY=\"\$CLEANVERSE_API_KEY\" npx tsx scripts/register-validator.ts"
echo ""
echo "# Step 4: deploy the backend to its own Vercel project (backend/vercel.json is ready):"
echo "cd $ROOT/backend && npx vercel link --project legate-cleanverse-backend --yes"
echo "npx vercel env add AGENT_MANDATE_ADDRESS production   # value: $MANDATE"
echo "npx vercel env add RELAYER_PRIVATE_KEY production      # value: \$DEPLOYER_PRIVATE_KEY (or a dedicated relayer key)"
echo "npx vercel env add LEGATE_ESCROW_ADDRESS production    # value: $ESCROW"
echo "npx vercel env add TRAVEL_RULE_ANCHOR_ADDRESS production # value: $ANCHOR"
echo "npx vercel env add CLEANVERSE_API_ID production         # value: \$CLEANVERSE_API_ID"
echo "npx vercel env add CLEANVERSE_API_KEY production        # value: \$CLEANVERSE_API_KEY"
echo "npx vercel env add ANCHOR_PRIVATE_KEY production         # value: a key holding ANCHOR_ROLE (deployer has it by default)"
echo "npx vercel deploy --prod --yes"
echo ""
echo "# Step 5: point the web app at the real backend and redeploy:"
echo "cd $ROOT/web && npx vercel env add NEXT_PUBLIC_API_BASE_URL production   # value: <the backend URL step 4 just printed>"
echo "npx vercel deploy --prod --yes"
echo ""
echo "# Step 6: fill the address blanks in SUBMISSION.md and SUBMISSION_EMAIL_DRAFT.md, then send."
