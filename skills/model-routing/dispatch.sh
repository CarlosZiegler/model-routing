#!/usr/bin/env bash
# dispatch.sh — launch the lane chosen by route.ts, headless and in the background,
# and record it in the pool ledger (start row now, done row with tokens/cost when it exits).
# A review_panel lane (vendor "panel") runs review-panel.sh instead, which writes one start/done
# row per panel call itself (reviewers, judge, escalation) and final.md in the same run dir.
#
# Usage:
#   route.ts brief.md --repo "$WT" > lane.json && dispatch.sh lane.json [options]
#   route.ts brief.md --repo "$WT" | dispatch.sh - [options]
# Options:
#   --run-id ID             ledger run id (default: <brief name>-<HHMMSS>)
#   --ledger PATH           pool ledger (default: lane.ledger, else <repo>/.coord/model-routing/pool-ledger.tsv)
#   --allow-main-checkout   allow a build lane outside a linked git worktree
#   --dry-run               print what would run; write nothing, launch nothing
#
# Files: <ledger dir>/runs/<run_id>/{lane.json,out,err,exit,pid,ledger.log} (+ agy usage-before/after.json;
#   panel lanes add final.md, summary.json and per-call r<N>/judge files).
# Refuses coordinator_only lanes, cooling accounts and unknown vendor/account pairs.
# It never runs the review of a build lane: after the build, write the review brief and run the
# lane's .review_command with REVIEW_BRIEF=<brief> RUN_ID=<run_id> (review-panel.sh, see SKILL.md).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER_TS="$SKILL_DIR/scripts/pool-ledger.ts"

die() { echo "dispatch: $*" >&2; exit 1; }

if command -v node >/dev/null 2>&1 && node --experimental-strip-types -e '' >/dev/null 2>&1; then
  TS=(node --experimental-strip-types)
elif command -v bun >/dev/null 2>&1; then
  TS=(bun)
else
  die "need node >= 22.6 or bun"
fi
command -v jq >/dev/null 2>&1 || die "need jq"

LANE_SRC=${1:-}
[ -n "$LANE_SRC" ] || die "usage: dispatch.sh <lane.json|-> [--run-id ID] [--ledger PATH] [--allow-main-checkout] [--dry-run]"
shift
RUN_ID="" LEDGER="" DRY=0 ALLOW_MAIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID=${2:?}; shift 2 ;;
    --ledger) LEDGER=${2:?}; shift 2 ;;
    --allow-main-checkout) ALLOW_MAIN=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

if [ "$LANE_SRC" = "-" ]; then LANE_JSON=$(cat); else LANE_JSON=$(cat "$LANE_SRC"); fi
jq -e . >/dev/null <<<"$LANE_JSON" || die "lane input is not JSON"
field() { jq -r "$1 // empty" <<<"$LANE_JSON"; }

VENDOR=$(field .vendor)
MODEL=$(field .model)
EFFORT=$(field .effort)
ACCOUNT=$(field .account)
LANE=$(field .lane)
MODE=$(field .mode)
SOURCE=$(field .source)
REPO=$(field .repo)
BRIEF=$(field .brief)
CMD=$(field .command)
SESSION=$(field .session_id)
REVIEWERS=$(jq -r '[.reviewers[]?.lane] | join(",")' <<<"$LANE_JSON")
JUDGE=$(field .judge.lane)

# ---- guards -------------------------------------------------------------------------
[ -n "$CMD" ] || die "lane '$LANE' (account '$ACCOUNT') is coordinator-only: nothing dispatched"
# Seats and the main account come from scripts/config.ts (MODEL_ROUTING_SEATS or
# ~/.config/model-routing/config.json); see "Configure your accounts" in README.md.
CONFIG_JSON=$("${TS[@]}" "$SKILL_DIR/scripts/config.ts") || die "cannot load account config"
MAIN_ACCOUNT=$(jq -r .mainAccount <<<"$CONFIG_JSON")
SEAT_DIR=$(jq -r --arg a "$ACCOUNT" '.seatConfigDirs[$a] // empty' <<<"$CONFIG_JSON")
if [ "$VENDOR" = claude ] && [ "$ACCOUNT" = "$MAIN_ACCOUNT" ]; then
  :
elif [ "$VENDOR" = claude ] && [ -n "$SEAT_DIR" ]; then
  [ -d "$SEAT_DIR" ] || die "seat config dir $SEAT_DIR missing"
else
  case "$VENDOR:$ACCOUNT" in
    codex:codex | agy:google | grok:grok | panel:panel) ;;
    *) die "unexpected vendor/account pair: $VENDOR/$ACCOUNT (configured seats: $(jq -r '.seats | join(",")' <<<"$CONFIG_JSON"))" ;;
  esac
fi
case "$VENDOR" in
  panel) CLI=bash ;; # review-panel.sh checks each member's CLI through its command
  *) CLI=$VENDOR ;;
esac
command -v "$CLI" >/dev/null 2>&1 || die "$CLI CLI not on PATH"
[ -d "$REPO" ] || die "repo dir missing: $REPO"
[ -f "$BRIEF" ] || die "brief missing: $BRIEF"

if [ "$MODE" = "build" ] && [ "$ALLOW_MAIN" -eq 0 ]; then
  GIT_DIR_=$(git -C "$REPO" rev-parse --absolute-git-dir 2>/dev/null || true)
  COMMON_DIR=$(cd "$REPO" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -z "$GIT_DIR_" ] || [ "$GIT_DIR_" = "$COMMON_DIR" ]; then
    die "build lane '$LANE' runs with permissions bypassed; point route.ts --repo at a linked git worktree (or pass --allow-main-checkout)"
  fi
fi

LEDGER=${LEDGER:-$(field .ledger)}
LEDGER=${LEDGER:-$REPO/.coord/model-routing/pool-ledger.tsv}
if [ -z "$RUN_ID" ]; then
  base=$(basename "$BRIEF")
  RUN_ID="${base%.*}-$(date +%H%M%S)"
fi
RUN_DIR="$(dirname "$LEDGER")/runs/$RUN_ID"
[ ! -e "$RUN_DIR" ] || die "run dir exists: $RUN_DIR (pick another --run-id)"
NOTE="route=${SOURCE:-?} lane=$LANE${SESSION:+ session=$SESSION}${REVIEWERS:+ reviewers=$REVIEWERS}${JUDGE:+ judge=$JUDGE}"

if [ -f "$LEDGER" ] && [ "$VENDOR" != panel ]; then
  COOLING=$("${TS[@]}" "$LEDGER_TS" --ledger "$LEDGER" status --json |
    jq -r --arg a "$ACCOUNT" '.[] | select(.account == $a) | .cooling_until // empty')
  [ -z "$COOLING" ] || die "account $ACCOUNT is cooling until $COOLING; re-run route.ts"
fi

if [ "$DRY" -eq 1 ]; then
  jq -n --arg run_id "$RUN_ID" --arg run_dir "$RUN_DIR" --arg ledger "$LEDGER" --arg note "$NOTE" \
    --arg cmd "$CMD" --arg vendor "$VENDOR" --arg model "$MODEL" --arg effort "$EFFORT" --arg account "$ACCOUNT" \
    '{dry_run: true, run_id: $run_id, vendor: $vendor, model: $model, effort: $effort, account: $account,
      ledger: $ledger, ledger_note: $note, run_dir: $run_dir, command: $cmd}'
  exit 0
fi

# ---- launch ---------------------------------------------------------------------------
mkdir -p "$RUN_DIR"
printf '%s\n' "$LANE_JSON" >"$RUN_DIR/lane.json"

if [ "$VENDOR" = panel ]; then
  # The command is review-panel.sh '<brief>' '<repo>' "${RUN_ID:?}" [--builder V]; it logs each call itself.
  RUN_ID="$RUN_ID" POOL_LEDGER="$LEDGER" nohup bash -c '
    run_dir=$1 cmd=$2
    bash -c "$cmd" >"$run_dir/out" 2>"$run_dir/err" </dev/null
    echo "$?" >"$run_dir/exit"
  ' dispatch-panel "$RUN_DIR" "$CMD" >/dev/null 2>&1 &
  PID=$!
  echo "$PID" >"$RUN_DIR/pid"
  jq -n --arg run_id "$RUN_ID" --argjson pid "$PID" --arg run_dir "$RUN_DIR" --arg ledger "$LEDGER" \
    --arg reviewers "$REVIEWERS" --arg judge "$JUDGE" \
    '{run_id: $run_id, pid: $pid, vendor: "panel", run_dir: $run_dir, final: ($run_dir + "/final.md"),
      summary: ($run_dir + "/summary.json"), err: ($run_dir + "/err"), ledger: $ledger,
      reviewers: ($reviewers | split(",")), judge: (if $judge == "" then null else $judge end)}'
  exit 0
fi

"${TS[@]}" "$LEDGER_TS" --ledger "$LEDGER" start --account "$ACCOUNT" --vendor "$VENDOR" \
  --model "$MODEL" --effort "$EFFORT" --run-id "$RUN_ID" --note "$NOTE" >"$RUN_DIR/ledger.log"

# The child runs the lane, then appends the done row (tokens, cost, error/limit → cooling).
nohup bash -c '
  cmd=$1 run_dir=$2 vendor=$3; shift 3
  if [ "$vendor" = agy ]; then agy -p /usage --output-format json >"$run_dir/usage-before.json" 2>/dev/null </dev/null || true; fi
  bash -c "$cmd" >"$run_dir/out" 2>"$run_dir/err" </dev/null
  rc=$?
  echo "$rc" >"$run_dir/exit"
  if [ "$vendor" = agy ]; then agy -p /usage --output-format json >"$run_dir/usage-after.json" 2>/dev/null </dev/null || true; fi
  "$@" --exit "$rc" >>"$run_dir/ledger.log" 2>&1
' dispatch-run "$CMD" "$RUN_DIR" "$VENDOR" \
  "${TS[@]}" "$LEDGER_TS" --ledger "$LEDGER" done --account "$ACCOUNT" --vendor "$VENDOR" \
  --model "$MODEL" --effort "$EFFORT" --run-id "$RUN_ID" --output "$RUN_DIR/out" --stderr "$RUN_DIR/err" \
  >/dev/null 2>&1 &
PID=$!
echo "$PID" >"$RUN_DIR/pid"

jq -n --arg run_id "$RUN_ID" --argjson pid "$PID" --arg run_dir "$RUN_DIR" --arg ledger "$LEDGER" \
  --arg vendor "$VENDOR" --arg model "$MODEL" --arg effort "$EFFORT" --arg account "$ACCOUNT" \
  --arg reviewers "$REVIEWERS" --arg judge "$JUDGE" --arg review_command "$(field .review_command)" \
  '{run_id: $run_id, pid: $pid, vendor: $vendor, model: $model, effort: $effort, account: $account,
    run_dir: $run_dir, out: ($run_dir + "/out"), err: ($run_dir + "/err"), ledger: $ledger,
    review_panel: (if $reviewers == "" then null else {reviewers: ($reviewers | split(",")),
      judge: (if $judge == "" then null else $judge end), command: $review_command} end)}'
