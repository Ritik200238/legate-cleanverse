#!/usr/bin/env bash
# End-to-end test: deploys the real Legate contracts to a local Anvil chain, wires up real
# compliance/mandate state, starts the real x402 backend against that deployment, and hits
# the real HTTP endpoints — proving the whole stack (Express -> ethers.js -> real Solidity
# bytecode) works together, not just that each piece compiles in isolation.
#
# Requires: foundry (anvil, cast, forge) on PATH, node/npm deps installed in ../backend.
# Run from the backend/ directory: bash test/e2e-x402-local.sh
set -euo pipefail

CONTRACTS_DIR="../contracts"
RPC="http://127.0.0.1:8545"

echo "=== killing any existing anvil ==="
taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
sleep 1

echo "=== starting fresh anvil ==="
anvil > /tmp/legate-e2e-anvil.log 2>&1 &
sleep 2
CHAIN_ID=$(cast chain-id --rpc-url $RPC)
[ "$CHAIN_ID" = "31337" ] || { echo "anvil did not start correctly"; exit 1; }

# Anvil's well-known default accounts. VERIFIED against anvil's own startup log, not
# hand-typed from memory — a hand-typed key was found to have a transcription error during
# this project's development (see DECISIONS.md), which is exactly why this script re-derives
# them from the live anvil log rather than hardcoding.
# Header(1) + underline(2) + blank(3) + "(0) 0x.."(4) + "(1) 0x.."(5) + "(2) 0x.."(6) + "(3) 0x.."(7)
DEPLOYER_KEY=$(grep -A 11 "Private Keys" /tmp/legate-e2e-anvil.log | sed -n '4p' | awk '{print $2}')
PRINCIPAL_KEY=$(grep -A 11 "Private Keys" /tmp/legate-e2e-anvil.log | sed -n '5p' | awk '{print $2}')
RECIPIENT_KEY=$(grep -A 11 "Private Keys" /tmp/legate-e2e-anvil.log | sed -n '6p' | awk '{print $2}')
AGENT_KEY=$(grep -A 11 "Private Keys" /tmp/legate-e2e-anvil.log | sed -n '7p' | awk '{print $2}')
PRINCIPAL=$(cast wallet address --private-key "$PRINCIPAL_KEY")
AGENT=$(cast wallet address --private-key "$AGENT_KEY")
RECIPIENT=$(cast wallet address --private-key "$RECIPIENT_KEY")

# Sanity-check every derived key before using it — the whole point of this rewrite was that
# hand-parsed/hand-typed keys are error-prone; verify programmatically instead of trusting it.
for pair in "DEPLOYER:$DEPLOYER_KEY" "PRINCIPAL:$PRINCIPAL_KEY" "AGENT:$AGENT_KEY" "RECIPIENT:$RECIPIENT_KEY"; do
  name="${pair%%:*}"; key="${pair##*:}"
  [[ "$key" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "FATAL: $name key '$key' is not a valid 32-byte hex private key"; exit 1; }
done

echo "=== deploying contracts ==="
cd "$CONTRACTS_DIR"
DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" forge script script/DeployLocal.s.sol:DeployLocal --rpc-url $RPC --broadcast > /tmp/legate-e2e-deploy.log 2>&1
ESCROW=$(grep "escrow:" /tmp/legate-e2e-deploy.log | awk '{print $2}')
VALIDATOR=$(grep "validator:" /tmp/legate-e2e-deploy.log | awk '{print $2}')
MANDATE=$(grep "agentMandate:" /tmp/legate-e2e-deploy.log | awk '{print $2}')
ATOKEN=$(grep "aToken:" /tmp/legate-e2e-deploy.log | awk '{print $2}')
ANCHOR=$(grep "travelRuleAnchor:" /tmp/legate-e2e-deploy.log | awk '{print $2}')
echo "escrow=$ESCROW validator=$VALIDATOR mandate=$MANDATE aToken=$ATOKEN anchor=$ANCHOR"

echo "=== wiring up compliance + mandate state ==="
cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$PRINCIPAL" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$RECIPIENT" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$ATOKEN" "mint(address,uint256)" "$PRINCIPAL" 100000000000 --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
cast send "$ATOKEN" "approve(address,uint256)" "$ESCROW" 100000000000 --rpc-url $RPC --private-key "$PRINCIPAL_KEY" >/dev/null
EXPIRY=$(( $(date +%s) + 2592000 ))
cast send "$MANDATE" "createMandate(address,uint256,uint256,uint256,uint64)" "$AGENT" 500000000 2000000000 5000000000 "$EXPIRY" --rpc-url $RPC --private-key "$PRINCIPAL_KEY" >/dev/null

echo "=== starting backend ==="
cd - >/dev/null
sleep 1
npx tsc -p tsconfig.json
MONAD_RPC_URL=$RPC AGENT_MANDATE_ADDRESS="$MANDATE" RELAYER_PRIVATE_KEY="$AGENT_KEY" LEGATE_ATOKEN_ADDRESS="$ATOKEN" \
LEGATE_ESCROW_ADDRESS="$ESCROW" TRAVEL_RULE_ANCHOR_ADDRESS="$ANCHOR" CLEANVERSE_API_ID="${CLEANVERSE_API_ID:-APP20260614112550LIDZXM}" \
  node dist/src/index.js > /tmp/legate-e2e-backend.log 2>&1 &
BACKEND_PID=$!
sleep 2

echo ""
echo "=== TEST 1: GET returns 402 with compliance requirements ==="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:4021/pay/t1?recipient=$RECIPIENT&amount=100000000")
[ "$STATUS" = "402" ] && echo "PASS (status $STATUS)" || { echo "FAIL (status $STATUS)"; exit 1; }

echo "=== TEST 2: compliant payment within caps settles for real ==="
RESULT=$(curl -s -X POST "http://127.0.0.1:4021/pay/t2" -H "Content-Type: application/json" \
  -d "{\"agentAddress\":\"$AGENT\",\"recipient\":\"$RECIPIENT\",\"amount\":\"100000000\"}")
echo "$RESULT" | grep -q '"status":"settled"' && echo "PASS: $RESULT" || { echo "FAIL: $RESULT"; exit 1; }

echo "=== TEST 3: exceeding per-tx cap is refused with the real contract reason ==="
RESULT=$(curl -s -X POST "http://127.0.0.1:4021/pay/t3" -H "Content-Type: application/json" \
  -d "{\"agentAddress\":\"$AGENT\",\"recipient\":\"$RECIPIENT\",\"amount\":\"600000000\"}")
echo "$RESULT" | grep -q 'MANDATE_CAP_EXCEEDED' && echo "PASS: $RESULT" || { echo "FAIL: $RESULT"; exit 1; }

echo "=== TEST 4: non-compliant recipient is refused with the real contract reason ==="
NONCOMPLIANT=$(cast wallet new --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].address))")
RESULT=$(curl -s -X POST "http://127.0.0.1:4021/pay/t4" -H "Content-Type: application/json" \
  -d "{\"agentAddress\":\"$AGENT\",\"recipient\":\"$NONCOMPLIANT\",\"amount\":\"100000000\"}")
echo "$RESULT" | grep -q 'RECIPIENT_NOT_COMPLIANT' && echo "PASS: $RESULT" || { echo "FAIL: $RESULT"; exit 1; }

echo ""
echo "=== TEST 5: sender self-service reclaim of an unclaimed payment (real chain + real backend ABI) ==="
# The Foundry suite already proves reclaimExpired()'s logic against the bytecode. What it
# cannot prove is that the *backend's* hand-written ABI string still matches that bytecode —
# a silently-stale getPayment() tuple would decode garbage without erroring. This leg exercises
# the real HTTP read path, so a drifted ABI fails here loudly.
RECEIPT=$(cast send "$ESCROW" "initiate(address,uint256)" "$RECIPIENT" 250000000 --rpc-url $RPC --private-key "$PRINCIPAL_KEY" --json)
PAYMENT_ID=$(ESCROW_ADDR="$ESCROW" node -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const logs=JSON.parse(d).logs.filter(l=>l.address.toLowerCase()===process.env.ESCROW_ADDR.toLowerCase());
    if(logs.length!==1){console.error('expected exactly one escrow log, got '+logs.length);process.exit(1);}
    console.log(logs[0].topics[1]);
  })" <<< "$RECEIPT")
[[ "$PAYMENT_ID" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "FAIL: could not extract paymentId (got '$PAYMENT_ID')"; exit 1; }

# 5a: the backend decodes the new claimDeadline field, and it's genuinely CLAIM_WINDOW ahead.
PAYMENT_JSON=$(curl -s "http://127.0.0.1:4021/api/payment/$PAYMENT_ID")
# awk $1: cast annotates large integers with a scientific-notation hint ("2592000 [2.592e6]").
CLAIM_WINDOW=$(cast call "$ESCROW" "CLAIM_WINDOW()(uint64)" --rpc-url $RPC | awk '{print $1}')
echo "$PAYMENT_JSON" | CW="$CLAIM_WINDOW" node -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const p=JSON.parse(d);
    if(p.state!=='Escrowed'){console.error('FAIL: expected Escrowed, got '+p.state);process.exit(1);}
    if(!p.claimDeadline){console.error('FAIL: backend did not return claimDeadline — ABI is stale');process.exit(1);}
    const gap=p.claimDeadline-p.createdAt, want=Number(process.env.CW.trim());
    if(gap!==want){console.error('FAIL: claimDeadline-createdAt was '+gap+', expected CLAIM_WINDOW='+want);process.exit(1);}
    console.log('PASS 5a: backend decodes claimDeadline = createdAt + '+want+'s');
  })" || exit 1

# 5b: before the window closes, the sender's own reclaim is refused by the contract.
SEL_WINDOW=$(cast sig "ClaimWindowNotExpired(uint64)")
ERR=$(cast call "$ESCROW" "reclaimExpired(bytes32)" "$PAYMENT_ID" --from "$PRINCIPAL" --rpc-url $RPC 2>&1 || true)
echo "$ERR" | grep -qi "${SEL_WINDOW#0x}" && echo "PASS 5b: refused pre-window with ClaimWindowNotExpired" || { echo "FAIL 5b: $ERR"; exit 1; }

# 5c: even after the window, a non-sender cannot reclaim someone else's funds.
cast rpc evm_increaseTime $((CLAIM_WINDOW + 1)) --rpc-url $RPC >/dev/null
cast rpc evm_mine --rpc-url $RPC >/dev/null
SEL_SENDER=$(cast sig "NotPaymentSender()")
ERR=$(cast call "$ESCROW" "reclaimExpired(bytes32)" "$PAYMENT_ID" --from "$RECIPIENT" --rpc-url $RPC 2>&1 || true)
echo "$ERR" | grep -qi "${SEL_SENDER#0x}" && echo "PASS 5c: non-sender refused with NotPaymentSender" || { echo "FAIL 5c: $ERR"; exit 1; }

# 5d: the sender reclaims for real, in full, with no admin involved anywhere in this leg.
BAL_BEFORE=$(cast call "$ATOKEN" "balanceOf(address)(uint256)" "$PRINCIPAL" --rpc-url $RPC | awk '{print $1}')
cast send "$ESCROW" "reclaimExpired(bytes32)" "$PAYMENT_ID" --rpc-url $RPC --private-key "$PRINCIPAL_KEY" >/dev/null
BAL_AFTER=$(cast call "$ATOKEN" "balanceOf(address)(uint256)" "$PRINCIPAL" --rpc-url $RPC | awk '{print $1}')
[ "$((BAL_AFTER - BAL_BEFORE))" = "250000000" ] || { echo "FAIL 5d: sender got back $((BAL_AFTER - BAL_BEFORE)), expected the full 250000000"; exit 1; }
curl -s "http://127.0.0.1:4021/api/payment/$PAYMENT_ID" | grep -q '"state":"Refunded"' \
  && echo "PASS 5d: full amount returned, backend reports Refunded" || { echo "FAIL 5d: backend did not report Refunded"; exit 1; }

echo ""
echo "=== ALL E2E TESTS PASSED ==="
kill $BACKEND_PID >/dev/null 2>&1 || true
taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
