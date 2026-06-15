#!/usr/bin/env bash
# Kick off a stronger Adam Eivy LoRA training run, on demand.
#
# Why this script instead of the in-app "Train" button:
#   The app spawns the trainer as a child of portos-server, and pm2's TreeKill
#   SIGINTs the whole process tree on any server restart (memory ceiling, code
#   reload, another agent's restart) — which killed multi-hour runs repeatedly.
#   This launches the trainer STANDALONE (reparented to launchd, ppid 1) so it is
#   immune to every pm2/server restart. It also forces 4-bit QLoRA on the 9B base
#   (LORA_TRAIN_MAX_QUANT_BITS=4) — the bf16 9B path crawls + GPU-watchdog-panics
#   this M5 Max. See docs/research/2026-06-13-mflux-training-watchdog-panic.md.
#
# It creates a fresh run via the API (so the dataset is staged + the config built
# the normal way), cancels the API's pm2-child trainer, then relaunches that exact
# staged config standalone. On completion you finalize/register via the UI's
# "Use this" on a checkpoint, or re-run with --register.
#
# Usage:
#   ./scripts/train-adam-lora.sh                 # rank 64, 1800 steps, LR 1e-4, 9B
#   STEPS=2400 RANK=64 ./scripts/train-adam-lora.sh
#   ./scripts/train-adam-lora.sh --register <runId>   # register a finished standalone run's best checkpoint
#
# Tunables (env overrides):
set -euo pipefail
cd "$(dirname "$0")/.."

DATASET="${DATASET:-46aa3b3b-3c0e-4c97-824d-e29102d9fd5e}"   # Adam Eivy, 44 imgs, vision-captioned
BASE_MODEL="${BASE_MODEL:-flux2-klein-9b}"
STEPS="${STEPS:-1800}"
RANK="${RANK:-64}"
LR="${LR:-0.0001}"
RES="${RES:-768}"
SEED="${SEED:-7}"
CKPT_EVERY="${CKPT_EVERY:-300}"
SAMPLE_EVERY="${SAMPLE_EVERY:-300}"
NAME="${NAME:-Adam Eivy (9B 4bit r${RANK} ${STEPS}st)}"

PY=./data/python/venv/bin/python
API="https://127.0.0.1:5555"

# --- auth: Basic header from the keychain password (set once via:
#     security add-generic-password -a portos -s portos-auth -w 'YOUR_PASSWORD' )
PW="$(security find-generic-password -a portos -s portos-auth -w 2>/dev/null || true)"
if [[ -z "$PW" ]]; then
  echo "❌ No portos-auth password in keychain. Set it with:"
  echo "   security add-generic-password -a portos -s portos-auth -w 'YOUR_PASSWORD'"
  exit 1
fi
BASIC="$(printf ':%s' "$PW" | base64)"
auth=(-H "Authorization: Basic $BASIC")

# --- register mode: finalize a finished standalone run's best checkpoint
if [[ "${1:-}" == "--register" ]]; then
  RUNID="${2:?usage: --register <runId>}"
  echo "📦 Registering best checkpoint for run $RUNID via resume-finalize…"
  curl -sk -m 15 -X POST "$API/api/lora-training/runs/$RUNID/resume" "${auth[@]}" \
    | "$PY" -m json.tool
  echo "→ watch the UI; it finalizes from the newest checkpoint and registers the LoRA."
  exit 0
fi

echo "🏋️  Creating run: $BASE_MODEL · $STEPS steps · rank $RANK · LR $LR · ${RES}px · seed $SEED"
RESP="$(curl -sk -m 20 -X POST "$API/api/lora-training/runs" "${auth[@]}" \
  -H "Content-Type: application/json" \
  -d "$("$PY" - "$DATASET" "$BASE_MODEL" "$NAME" "$STEPS" "$RANK" "$LR" "$RES" "$SEED" "$CKPT_EVERY" "$SAMPLE_EVERY" <<'PYEOF'
import json, sys
ds, base, name, steps, rank, lr, res, seed, ck, sm = sys.argv[1:11]
print(json.dumps({
  "datasetId": ds, "baseModelId": base, "name": name,
  "params": {"steps": int(steps), "rank": int(rank), "learningRate": float(lr),
             "resolution": int(res), "seed": int(seed),
             "checkpointEvery": int(ck), "sampleEvery": int(sm)},
}))
PYEOF
)")"
RUNID="$(printf '%s' "$RESP" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["runId"])')"
echo "   runId: $RUNID"
RUN="data/training-runs/$RUNID"

# Wait for the server to stage config + dataset dir.
for i in $(seq 1 30); do [[ -f "$RUN/mflux-train.json" ]] && break; sleep 1; done
[[ -f "$RUN/mflux-train.json" ]] || { echo "❌ config never staged"; exit 1; }

# Cancel the API's pm2-child trainer; we relaunch the SAME config standalone.
curl -sk -m 10 -X POST "$API/api/lora-training/runs/$RUNID/cancel" "${auth[@]}" >/dev/null || true
sleep 4; pkill -f "train_mflux_lora.*$RUNID" 2>/dev/null || true
pkill -f "bin/mflux-train" 2>/dev/null || true; sleep 2

# Free unified memory (the periodic preview-gen spike has OOM-killed runs).
ollama ps 2>/dev/null | tail -n +2 | awk '{print $1}' | while read -r m; do [[ -n "$m" ]] && ollama stop "$m" 2>/dev/null || true; done

echo "🚀 Launching STANDALONE (immune to pm2 restarts)…"
PYTHONUNBUFFERED=1 LORA_TRAIN_MAX_QUANT_BITS=4 nohup "$PY" scripts/train_mflux_lora.py \
  --config "$RUN/mflux-train.json" --output-dir "$RUN" \
  --total-steps "$STEPS" --segment-steps "$CKPT_EVERY" --cooldown-sec 90 \
  > "$RUN/standalone.log" 2>&1 &
sleep 20
TP="$(pgrep -f "train_mflux_lora.*$RUNID" || true)"
echo "   trainer pid $TP (ppid $(ps -o ppid= -p "$TP" 2>/dev/null | tr -d ' ') — 1 = launchd = detached)"
echo
echo "✅ Running. Watch:  tail -f $RUN/standalone.log"
echo "   Samples land in $RUN/samples/ at each ${SAMPLE_EVERY}-step mark."
echo "   When done, register the best checkpoint:  ./scripts/train-adam-lora.sh --register $RUNID"
echo "   (or click 'Use this' under the best checkpoint in the Train LoRA UI)"
