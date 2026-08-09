#!/usr/bin/env bash
# End-to-end test for the Legate MCP server: deploys the real contracts to a fresh local
# Anvil chain, wires real compliance/mandate state, then drives the ACTUAL MCP server as a
# real child process over real stdio JSON-RPC (test/mcp-e2e-client.ts, using the real
# @modelcontextprotocol/sdk Client) — proving the full agent-facing surface works end to end,
# the same rigor already applied to the x402 middleware in e2e-x402-local.sh.
#
# Requires: foundry (anvil, cast, forge) on PATH, node/npm deps installed in ../backend.
# Run from the backend/ directory: bash test/e2e-mcp-local.sh
set -euo pipefail

CONTRACTS_DIR="../contracts"
RPC="http://127.0.0.1:8545"
CLEANVERSE_API_ID="${CLEANVERSE_API_ID:-APP20260614112550LIDZXM}"
# The one address confirmed (cleanverse-client.live.test.ts) to carry a real, active A-Pass
# in the Cleanverse UAT sandbox — used here as the payment recipient so verify_recipient and
# get_quote exercise a genuine, real REST response, not a synthetic one.
REAL_APASS_RECIPIENT="0x000000000000000000000000000000000000dEaD"

echo "=== killing any existing anvil ==="
taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
sleep 1

echo "=== starting fresh anvil ==="
anvil > /tmp/legate-mcp-e2e-anvil.log 2>&1 &
sleep 2
CHAIN_ID=$(cast chain-id --rpc-url $RPC)
[ "$CHAIN_ID" = "31337" ] || { echo "anvil did not start correctly"; exit 1; }

# Derived live from anvil's own startup log, never hand-typed (see DECISIONS.md for why).
DEPLOYER_KEY=$(grep -A 11 "Private Keys" /tmp/legate-mcp-e2e-anvil.log | sed -n '4p' | awk '{print $2}')
PRINCIPAL_KEY=$(grep -A 11 "Private Keys" /tmp/legate-mcp-e2e-anvil.log | sed -n '5p' | awk '{print $2}')
AGENT_KEY=$(grep -A 11 "Private Keys" /tmp/legate-mcp-e2e-anvil.log | sed -n '7p' | awk '{print $2}')
PRINCIPAL=$(cast wallet address --private-key "$PRINCIPAL_KEY")
AGENT=$(cast wallet address --private-key "$AGENT_KEY")

for pair in "DEPLOYER:$DEPLOYER_KEY" "PRINCIPAL:$PRINCIPAL_KEY" "AGENT:$AGENT_KEY"; do
  name="${pair%%:*}"; key="${pair##*:}"
  [[ "$key" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "FATAL: $name key '$key' is not a valid 32-byte hex private key"; exit 1; }
done

echo "=== generating fresh, never-reused test addresses ==="
NONCOMPLIANT_ADDRESS=$(cast wallet new --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].address))")
UNREGISTERED_ADDRESS=$(cast wallet new --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].address))")
for pair in "NONCOMPLIANT:$NONCOMPLIANT_ADDRESS" "UNREGISTERED:$UNREGISTERED_ADDRESS"; do
  name="${pair%%:*}"; addr="${pair##*:}"
  [[ "$addr" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "FATAL: $name address '$addr' is not a valid 20-byte hex address"; exit 1; }
done
echo "nonCompliant=$NONCOMPLIANT_ADDRESS unregistered=$UNREGISTERED_ADDRESS recipient(real A-Pass)=$REAL_APASS_RECIPIENT"

echo "=== deploying contracts ==="
cd "$CONTRACTS_DIR"
DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" forge script script/DeployLocal.s.sol:DeployLocal --rpc-url $RPC --broadcast > /tmp/legate-mcp-e2e-deploy.log 2>&1
ESCROW=$(grep "escrow:" /tmp/legate-mcp-e2e-deploy.log | awk '{print $2}')
VALIDATOR=$(grep "validator:" /tmp/legate-mcp-e2e-deploy.log | awk '{print $2}')
MANDATE=$(grep "agentMandate:" /tmp/legate-mcp-e2e-deploy.log | awk '{print $2}')
ATOKEN=$(grep "aToken:" /tmp/legate-mcp-e2e-deploy.log | awk '{print $2}')
echo "escrow=$ESCROW validator=$VALIDATOR mandate=$MANDATE aToken=$ATOKEN"

echo "=== wiring up compliance + mandate state ==="
# Principal and the real-A-Pass recipient are compliant on the LOCAL mock validator.
# NONCOMPLIANT_ADDRESS is deliberately never marked compliant. UNREGISTERED_ADDRESS is never
# touched on-chain at all — it only exercises the REAL Cleanverse REST "no A-Pass" path.
cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$PRINCIPAL" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$REAL_APASS_RECIPIENT" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$ATOKEN" "mint(address,uint256)" "$PRINCIPAL" 100000000000 --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$ATOKEN" "approve(address,uint256)" "$ESCROW" 100000000000 --rpc-url $RPC --private-key "$PRINCIPAL_KEY" >/dev/null
EXPIRY=$(( $(date +%s) + 2592000 ))
# perTxCap=500 aUSDC-units, dailyCap=2000, totalCap=5000 — same shape as e2e-x402-local.sh so
# TEST 8 (600 > 500 perTxCap) exercises the real MANDATE_CAP_EXCEEDED revert.
cast send "$MANDATE" "createMandate(address,uint256,uint256,uint256,uint64)" "$AGENT" 500000000 2000000000 5000000000 "$EXPIRY" --rpc-url $RPC --private-key "$PRINCIPAL_KEY" >/dev/null

echo "=== building backend (contracts + MCP server + test harness) ==="
cd - >/dev/null
npx tsc -p tsconfig.json

echo ""
echo "=== running real MCP client against the real MCP server (stdio child process) ==="
CLEANVERSE_BASE_URL="https://uatapi.cleanverse.com/api/cooperate" \
CLEANVERSE_API_ID="$CLEANVERSE_API_ID" \
LEGATE_CHAIN="monad" \
LEGATE_POOL_ADDRESS="$ESCROW" \
LEGATE_ESCROW_ADDRESS="$ESCROW" \
MONAD_RPC_URL="$RPC" \
AGENT_MANDATE_ADDRESS="$MANDATE" \
AGENT_PRIVATE_KEY="$AGENT_KEY" \
RECIPIENT_ADDRESS="$REAL_APASS_RECIPIENT" \
NONCOMPLIANT_ADDRESS="$NONCOMPLIANT_ADDRESS" \
UNREGISTERED_ADDRESS="$UNREGISTERED_ADDRESS" \
node dist/test/mcp-e2e-client.js

echo ""
echo "=== MCP E2E SCRIPT COMPLETE ==="
taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
