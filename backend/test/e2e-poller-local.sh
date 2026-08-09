#!/usr/bin/env bash
# End-to-end test for the revocation poller (Scene 3, PRD.md §6): deploys the real contracts
# to a fresh local Anvil chain, registers a genuinely new real A-Pass for a fresh test wallet
# via Cleanverse's real generate_apass endpoint, escrows a real on-chain payment for that
# wallet, freezes the real A-Pass via the real update_status endpoint, and proves the poller
# detects the transition and calls the real on-chain reportRevocation() — reaching funds
# already sitting in escrow, not just asserted to. See DECISIONS.md.
#
# Requires: foundry (anvil, cast, forge) on PATH, node/npm deps installed in ../backend, a
# real Cleanverse UAT sandbox api-id/api-key.
# Run from the backend/ directory: bash test/e2e-poller-local.sh
set -euo pipefail

CONTRACTS_DIR="../contracts"
RPC="http://127.0.0.1:8545"
CLEANVERSE_API_ID="${CLEANVERSE_API_ID:-APP20260614112550LIDZXM}"

echo "=== killing any existing anvil ==="
taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
sleep 1

echo "=== starting fresh anvil ==="
anvil > /tmp/legate-poller-e2e-anvil.log 2>&1 &
sleep 2
CHAIN_ID=$(cast chain-id --rpc-url $RPC)
[ "$CHAIN_ID" = "31337" ] || { echo "anvil did not start correctly"; exit 1; }

DEPLOYER_KEY=$(grep -A 11 "Private Keys" /tmp/legate-poller-e2e-anvil.log | sed -n '4p' | awk '{print $2}')
POLLER_KEY=$(grep -A 11 "Private Keys" /tmp/legate-poller-e2e-anvil.log | sed -n '6p' | awk '{print $2}')
for pair in "DEPLOYER:$DEPLOYER_KEY" "POLLER:$POLLER_KEY"; do
  name="${pair%%:*}"; key="${pair##*:}"
  [[ "$key" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "FATAL: $name key '$key' is not a valid 32-byte hex private key"; exit 1; }
done
POLLER_ADDRESS=$(cast wallet address --private-key "$POLLER_KEY")

echo "=== generating a fresh real test sender wallet (never reused/hand-typed) ==="
SENDER_KEY=$(cast wallet new --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].private_key))")
[[ "$SENDER_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "FATAL: generated sender key is malformed"; exit 1; }
SENDER_ADDRESS=$(cast wallet address --private-key "$SENDER_KEY")
RECIPIENT_ADDRESS="0x000000000000000000000000000000000000dEaD" # the one wallet confirmed to have a real A-Pass
echo "sender=$SENDER_ADDRESS poller=$POLLER_ADDRESS"

echo "=== fund sender with native gas (anvil auto-funds well-known accounts only) ==="
cast send "$SENDER_ADDRESS" --value 1ether --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null

echo "=== deploying contracts (with POLLER_ADDRESS granted POLLER_ROLE) ==="
cd "$CONTRACTS_DIR"
DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" POLLER_ADDRESS="$POLLER_ADDRESS" \
  forge script script/DeployLocal.s.sol:DeployLocal --rpc-url $RPC --broadcast > /tmp/legate-poller-e2e-deploy.log 2>&1
ESCROW=$(grep "escrow:" /tmp/legate-poller-e2e-deploy.log | awk '{print $2}')
VALIDATOR=$(grep "validator:" /tmp/legate-poller-e2e-deploy.log | awk '{print $2}')
MANDATE=$(grep "agentMandate:" /tmp/legate-poller-e2e-deploy.log | awk '{print $2}')
ATOKEN=$(grep "aToken:" /tmp/legate-poller-e2e-deploy.log | awk '{print $2}')
MIRROR=$(grep "registryMirror:" /tmp/legate-poller-e2e-deploy.log | awk '{print $2}')
echo "escrow=$ESCROW validator=$VALIDATOR mandate=$MANDATE aToken=$ATOKEN mirror=$MIRROR"

echo "=== wiring compliance + funding the sender ==="
cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$SENDER_ADDRESS" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$RECIPIENT_ADDRESS" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$ATOKEN" "mint(address,uint256)" "$SENDER_ADDRESS" 100000000000 --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$ATOKEN" "approve(address,uint256)" "$ESCROW" 100000000000 --rpc-url $RPC --private-key "$SENDER_KEY" >/dev/null

echo "=== sender escrows a real payment (this is the position the poller must protect) ==="
INITIATE_OUTPUT=$(cast send "$ESCROW" "initiate(address,uint256)" "$RECIPIENT_ADDRESS" 100000000 --rpc-url $RPC --private-key "$SENDER_KEY" --json)
PAYMENT_ID=$(node -e "
const logs = JSON.parse(process.argv[1]).logs;
const escrowLog = logs.find(l => l.address.toLowerCase() === process.argv[2].toLowerCase());
console.log(escrowLog.topics[1]);
" "$INITIATE_OUTPUT" "$ESCROW")
echo "paymentId=$PAYMENT_ID"

echo "=== building backend (contracts + poller + test harness) ==="
cd - >/dev/null
npx tsc -p tsconfig.json

echo ""
echo "=== running the real poller e2e client ==="
CLEANVERSE_BASE_URL="https://uatapi.cleanverse.com/api/cooperate" \
CLEANVERSE_API_ID="$CLEANVERSE_API_ID" \
LEGATE_CHAIN="monad" \
MONAD_RPC_URL="$RPC" \
LEGATE_ESCROW_ADDRESS="$ESCROW" \
CVI_REGISTRY_MIRROR_ADDRESS="$MIRROR" \
AGENT_MANDATE_ADDRESS="$MANDATE" \
POLLER_PRIVATE_KEY="$POLLER_KEY" \
SENDER_PRIVATE_KEY="$SENDER_KEY" \
RECIPIENT_ADDRESS="$RECIPIENT_ADDRESS" \
PAYMENT_ID="$PAYMENT_ID" \
  node dist/test/poller-e2e-client.js

echo ""
echo "=== POLLER E2E SCRIPT COMPLETE ==="
taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
