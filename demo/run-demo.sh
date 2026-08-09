#!/usr/bin/env bash
# Legate — the four demo scenes from PRD.md §6, run end to end against real contracts.
#
# This is the acceptance spec made executable. Every scene below is a real transaction
# against real Solidity bytecode: every refusal you see is a contract reverting, decoded
# from its actual revert data. Nothing here prints a scripted "BLOCKED" string.
#
# MODES
#   local (default) — deploys the full stack to a fresh Anvil chain. Cleanverse's on-chain
#                     validator is stood in for by MockValidator, because their real
#                     validator lives on Monad and cannot be reached from a local chain.
#                     Everything else — the escrow, the caps, the mandate, the reverts — is
#                     the same bytecode that deploys to Monad. Clearly labelled on screen.
#   monad           — runs against an existing real Monad testnet deployment wired to
#                     Cleanverse's REAL IAPassComplianceValidator. Nothing is mocked. Needs
#                     LEGATE_ESCROW_ADDRESS / AGENT_MANDATE_ADDRESS / ATOKEN_ADDRESS and
#                     funded, A-Pass-registered wallets.
#
# Usage:
#   bash demo/run-demo.sh                 # local
#   MODE=monad bash demo/run-demo.sh      # real testnet
set -euo pipefail

MODE="${MODE:-local}"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
dim()   { printf "\033[2m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
rule()  { printf "\033[2m%s\033[0m\n" "────────────────────────────────────────────────────────────────"; }
scene() { echo ""; rule; bold "$1"; dim "$2"; rule; echo ""; }

# Every refusal in this demo must come from the chain. This asserts that a call reverts AND
# that it reverts with the exact custom error named — a generic revert would pass a naive
# "did it fail?" check while hiding a completely different bug.
expect_revert_with() {
  local label="$1" expected_sig="$2"; shift 2
  local selector output
  selector="$(cast sig "$expected_sig")"
  output="$("$@" 2>&1 || true)"
  if grep -qi "${selector#0x}" <<< "$output"; then
    green "  REFUSED ON-CHAIN — $expected_sig"
    dim   "  $label"
  else
    red "  FAILED: expected a revert with $expected_sig ($selector)"
    echo "$output" | head -5
    exit 1
  fi
}

if [ "$MODE" = "local" ]; then
  bold "Legate — four-scene demo (LOCAL MODE)"
  dim "Real contracts, real reverts, on a local Anvil chain."
  dim "Cleanverse's on-chain validator is mocked here ONLY because it lives on Monad and a"
  dim "local chain cannot reach it. Run with MODE=monad against a real deployment for the"
  dim "unmocked version. Everything else below is the exact bytecode that ships."
  echo ""

  taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
  sleep 1
  anvil > /tmp/legate-demo-anvil.log 2>&1 &
  sleep 2
  RPC="http://127.0.0.1:8545"
  [ "$(cast chain-id --rpc-url $RPC)" = "31337" ] || { red "anvil failed to start"; exit 1; }

  # Keys are read from anvil's own startup log rather than hardcoded — a hand-typed key with
  # a transcription error cost real debugging time earlier in this project (see DECISIONS.md).
  DEPLOYER_KEY=$(grep -A 11 "Private Keys" /tmp/legate-demo-anvil.log | sed -n '4p' | awk '{print $2}')
  SENDER_KEY=$(grep -A 11 "Private Keys" /tmp/legate-demo-anvil.log | sed -n '5p' | awk '{print $2}')
  RECIPIENT_KEY=$(grep -A 11 "Private Keys" /tmp/legate-demo-anvil.log | sed -n '6p' | awk '{print $2}')
  AGENT_KEY=$(grep -A 11 "Private Keys" /tmp/legate-demo-anvil.log | sed -n '7p' | awk '{print $2}')
  SENDER=$(cast wallet address --private-key "$SENDER_KEY")
  RECIPIENT=$(cast wallet address --private-key "$RECIPIENT_KEY")
  AGENT=$(cast wallet address --private-key "$AGENT_KEY")
  # Anvil account (8). Deliberately never passed to setCompliant below — Scene 2 needs this
  # wallet's non-compliance to be a genuine absence of state, not a flag toggled for effect.
  UNVERIFIED=$(cast wallet address --private-key "$(grep -A 11 "Private Keys" /tmp/legate-demo-anvil.log | sed -n '12p' | awk '{print $2}')")

  dim "Deploying the real stack to the local chain..."
  cd contracts
  DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url $RPC --broadcast > /tmp/legate-demo-deploy.log 2>&1
  ESCROW=$(grep "escrow:" /tmp/legate-demo-deploy.log | awk '{print $2}')
  VALIDATOR=$(grep "validator:" /tmp/legate-demo-deploy.log | awk '{print $2}')
  MANDATE=$(grep "agentMandate:" /tmp/legate-demo-deploy.log | awk '{print $2}')
  ATOKEN=$(grep "aToken:" /tmp/legate-demo-deploy.log | awk '{print $2}')
  cd "$ROOT"

  DECIMALS=$(cast call "$ATOKEN" "decimals()(uint8)" --rpc-url $RPC | awk '{print $1}')
  UNIT=$(node -e "console.log((10n**BigInt($DECIMALS)).toString())")
  amt() { node -e "console.log((BigInt('$1')*BigInt('$UNIT')).toString())"; }

  # Only the SENDER and RECIPIENT get A-Passes. UNVERIFIED deliberately gets none — Scene 2
  # depends on that being genuinely absent, not on a flag we flip in the narration.
  cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$SENDER" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
  cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$RECIPIENT" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
  cast send "$ATOKEN" "mint(address,uint256)" "$SENDER" "$(amt 1000000)" --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
  cast send "$ATOKEN" "approve(address,uint256)" "$ESCROW" "$(amt 1000000)" --rpc-url $RPC --private-key "$SENDER_KEY" >/dev/null
  green "Deployed. escrow=$ESCROW  aToken=$ATOKEN ($DECIMALS decimals)"
else
  bold "Legate — four-scene demo (MONAD TESTNET MODE)"
  dim "Real Monad testnet. Cleanverse's REAL on-chain validator. Nothing mocked."
  RPC="${MONAD_RPC_URL:-https://testnet-rpc.monad.xyz}"
  ESCROW="${LEGATE_ESCROW_ADDRESS:?set LEGATE_ESCROW_ADDRESS}"
  MANDATE="${AGENT_MANDATE_ADDRESS:?set AGENT_MANDATE_ADDRESS}"
  ATOKEN="${LEGATE_ATOKEN_ADDRESS:?set LEGATE_ATOKEN_ADDRESS}"
  SENDER_KEY="${SENDER_PRIVATE_KEY:?set SENDER_PRIVATE_KEY (wallet must hold a real A-Pass)}"
  RECIPIENT_KEY="${RECIPIENT_PRIVATE_KEY:?set RECIPIENT_PRIVATE_KEY (wallet must hold a real A-Pass)}"
  AGENT_KEY="${AGENT_PRIVATE_KEY:?set AGENT_PRIVATE_KEY}"
  UNVERIFIED="${UNVERIFIED_ADDRESS:?set UNVERIFIED_ADDRESS (a wallet with NO A-Pass)}"
  SENDER=$(cast wallet address --private-key "$SENDER_KEY")
  RECIPIENT=$(cast wallet address --private-key "$RECIPIENT_KEY")
  AGENT=$(cast wallet address --private-key "$AGENT_KEY")
  DECIMALS=$(cast call "$ATOKEN" "decimals()(uint8)" --rpc-url $RPC | awk '{print $1}')
  UNIT=$(node -e "console.log((10n**BigInt($DECIMALS)).toString())")
  amt() { node -e "console.log((BigInt('$1')*BigInt('$UNIT')).toString())"; }
  green "Targeting live deployment. escrow=$ESCROW  aToken=$ATOKEN ($DECIMALS decimals)"
fi

STATE_NAMES=(None Escrowed Settled Frozen Refunded)
payment_state() {
  local raw
  raw=$(cast call "$ESCROW" "getPayment(bytes32)((address,address,uint256,uint8,uint64,uint64,uint64))" "$1" --rpc-url $RPC)
  # Field 4 of the tuple is PaymentState. Parsed positionally from the decoded tuple rather
  # than grepped out of the raw string — an earlier version grepped and confidently printed
  # the wrong field, which in a demo is worse than printing nothing.
  local idx
  idx=$(sed 's/[()]//g' <<< "$raw" | awk -F', *' '{print $4}' | awk '{print $1}')
  echo "${STATE_NAMES[$idx]:-Unknown($idx)}"
}

payment_id_from() {
  ESCROW_ADDR="$ESCROW" node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      const l=JSON.parse(d).logs.filter(x=>x.address.toLowerCase()===process.env.ESCROW_ADDR.toLowerCase());
      if(l.length!==1){console.error('expected one escrow log, got '+l.length);process.exit(1);}
      console.log(l[0].topics[1]);
    })"
}

# ─────────────────────────────────────────────────────────────────────────────
scene "SCENE 1 — The happy path" \
  "Verified sender (MY) → verified recipient (PH). Escrow, then settle."

RECEIPT=$(cast send "$ESCROW" "initiate(address,uint256)" "$RECIPIENT" "$(amt 100)" --rpc-url $RPC --private-key "$SENDER_KEY" --json)
PID1=$(payment_id_from <<< "$RECEIPT")
green "  Escrowed 100 aUSDC — paymentId $PID1"
dim   "  Both parties cleared complianceVerify() on-chain before a single token moved."

BEFORE=$(cast call "$ATOKEN" "balanceOf(address)(uint256)" "$RECIPIENT" --rpc-url $RPC | awk '{print $1}')
cast send "$ESCROW" "settle(bytes32)" "$PID1" --rpc-url $RPC --private-key "$RECIPIENT_KEY" >/dev/null
AFTER=$(cast call "$ATOKEN" "balanceOf(address)(uint256)" "$RECIPIENT" --rpc-url $RPC | awk '{print $1}')
# Read the fee configuration rather than narrating an assumed 0.5% — this deployment may have
# no fee address set, in which case the contract deliberately charges nothing and the
# recipient receives 100%. Saying "net of fees" when no fee was taken is a small lie that
# a viewer can check against the numbers on screen.
FEE_ADDR=$(cast call "$ESCROW" "feeAddress()(address)" --rpc-url $RPC | awk '{print $1}')
FEE_BPS=$(cast call "$ESCROW" "feeBps()(uint256)" --rpc-url $RPC | awk '{print $1}')
RECEIVED=$(node -e "
  const d=BigInt('$AFTER')-BigInt('$BEFORE'), u=BigInt('$UNIT');
  console.log((Number(d*10000n/u)/10000).toString());")
if [ "$FEE_ADDR" = "0x0000000000000000000000000000000000000000" ]; then
  green "  Settled. Recipient received $RECEIVED aUSDC — the full amount."
  dim   "  No fee address is configured on this deployment, so the contract charges nothing."
  dim   "  (It does not deduct a fee it cannot forward — that bug existed once; see DECISIONS.md.)"
else
  green "  Settled. Recipient received $RECEIVED aUSDC, net of the $((FEE_BPS / 100))% settlement fee."
fi
dim   "  Receipt permalink: /receipt/$PID1"

# ─────────────────────────────────────────────────────────────────────────────
scene "SCENE 2 — Blocked before it exists, with a positive control" \
  "The refusal and the success are the same call, same block range, one variable changed."

dim "  A) Same sender, same amount — recipient has NO A-Pass:"
expect_revert_with "The validator refused. Not Legate's opinion — the contract's." \
  "RecipientNotCompliant(address)" \
  cast call "$ESCROW" "initiate(address,uint256)" "$UNVERIFIED" "$(amt 100)" --from "$SENDER" --rpc-url $RPC
echo ""
dim "  B) Positive control — identical call, verified recipient:"
RECEIPT=$(cast send "$ESCROW" "initiate(address,uint256)" "$RECIPIENT" "$(amt 100)" --rpc-url $RPC --private-key "$SENDER_KEY" --json)
PID2=$(payment_id_from <<< "$RECEIPT")
green "  ACCEPTED — paymentId $PID2"
dim   "  Only the recipient's compliance status differed. Nothing else."

# ─────────────────────────────────────────────────────────────────────────────
scene "SCENE 3 — Revocation with teeth" \
  "Revocation reaches funds already in flight, not just future transactions."

dim "  A payment is sitting in escrow, fully cleared at the time it was made:"
dim "  paymentId $PID2 — state: $(payment_state "$PID2")"
echo ""
if [ "$MODE" = "local" ]; then
  dim "  The recipient's A-Pass is now revoked (sanctions hit):"
  cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$RECIPIENT" false --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
else
  dim "  Revoke the recipient's A-Pass now via Cleanverse's real update_status endpoint,"
  dim "  then press Enter. (backend/src/cleanverse/client.ts :: updateStatus)"
  read -r _
fi
expect_revert_with "Funds stay escrowed and intact. Nobody had to notice in time." \
  "NotCompliantAtSettlement()" \
  cast call "$ESCROW" "settle(bytes32)" "$PID2" --from "$RECIPIENT" --rpc-url $RPC
dim "  Payment state after the refused settlement: $(payment_state "$PID2") — unchanged, funds intact."
echo ""
dim "  Note what did NOT have to happen: no poller had to fire, no admin had to react."
dim "  The on-chain re-check at settlement is the safety net. The poller (backend/src/poller)"
dim "  only makes the freeze proactive rather than lazy."

# ─────────────────────────────────────────────────────────────────────────────
scene "SCENE 4 — The agent payroll run" \
  "An AI agent spending under on-chain mandate caps it cannot talk its way past."

if [ "$MODE" = "local" ]; then
  cast send "$VALIDATOR" "setCompliant(address,address,bool)" "$ESCROW" "$RECIPIENT" true --rpc-url $RPC --private-key "$DEPLOYER_KEY" >/dev/null
fi
EXPIRY=$(( $(date +%s) + 2592000 ))
cast send "$MANDATE" "createMandate(address,uint256,uint256,uint256,uint64)" \
  "$AGENT" "$(amt 500)" "$(amt 2000)" "$(amt 5000)" "$EXPIRY" \
  --rpc-url $RPC --private-key "$SENDER_KEY" >/dev/null
green "  Mandate created: 500 per payment, 2,000 per day, 5,000 lifetime."
dim   "  These caps live in contract storage. The agent cannot argue with them."
echo ""

dim "  Contractor payments 1-3 (400 aUSDC each, within every cap):"
for i in 1 2 3; do
  cast send "$MANDATE" "execute(address,uint256)" "$RECIPIENT" "$(amt 400)" --rpc-url $RPC --private-key "$AGENT_KEY" >/dev/null
  green "    #$i settled"
done
echo ""
dim "  Payment 4 — 600 aUSDC, over the 500 per-payment cap:"
expect_revert_with "The agent asked. The contract said no." \
  "PerTxCapExceeded(uint256,uint256)" \
  cast call "$MANDATE" "execute(address,uint256)" "$RECIPIENT" "$(amt 600)" --from "$AGENT" --rpc-url $RPC
echo ""
dim "  Payment 5 — within caps, but the contractor has no A-Pass:"
expect_revert_with "Compliance is in the rail, not in the model." \
  "RecipientNotCompliant(address)" \
  cast call "$MANDATE" "execute(address,uint256)" "$UNVERIFIED" "$(amt 100)" --from "$AGENT" --rpc-url $RPC

# ─────────────────────────────────────────────────────────────────────────────
echo ""
rule
bold "All four scenes completed — every refusal above came from a real contract revert."
dim  "Decoded from real revert data, not printed from a script branch."
if [ "$MODE" = "local" ]; then
  echo ""
  dim "LOCAL MODE reminder: Cleanverse's on-chain validator was mocked (it lives on Monad)."
  dim "Everything else was the shipping bytecode. Re-run with MODE=monad against a funded,"
  dim "registered deployment for the fully unmocked version — see README.md."
  taskkill //F //IM anvil.exe >/dev/null 2>&1 || true
fi
rule
