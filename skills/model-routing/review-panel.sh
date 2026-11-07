#!/usr/bin/env bash
# review-panel.sh <brief> <repo> <run-id> [options] — run a review panel and write final.md.
#
# Reviewers run in parallel, read-only (default: 2x codex gpt-6.1-terra high + agy gemini-4-argon-high).
# Then a judge (default: codex gpt-6.1-terra high, read-only) gets every finding, makes them debate,
# dedupes, verifies each against the code, and labels it CONFIRMED / PLAUSIBLE / REJECTED.
# Members avoid the builder's vendor: --builder codex → Opus high + Argon high, Opus high judge.
# The escalation lane (default Sol high; may run tests) runs only with --escalate, and only on
# findings the judge marks "Escalate: dispute" or "Escalate: needs-test".
#
# Options:
#   --builder V            vendor that wrote the diff: claude|codex|agy|grok (default: unknown → default panel)
#   --ledger PATH          pool ledger (default: $POOL_LEDGER, else <repo>/.coord/model-routing/pool-ledger.tsv)
#   --lane FILE            take .reviewers/.judge/.escalation from a route.ts lane JSON instead of picking now
#   --timeout SECS         wall limit per call (default 1500)
#   --escalate             run the escalation lane on escalated findings
#   --allow-main-checkout  allow --escalate outside a linked git worktree (it may run tests that write)
#   --dry-run              print the panel and the run dir; run nothing, write nothing
#
# Files: <ledger dir>/runs/<run-id>/
#   panel.json  reviewer-brief.md  r<N>.{out,err,md,json}  judge-brief.md  judge.{out,err,md,json}
#   escalations.md  escalation-brief.md  escalation.{out,err,md,json}  final.md  summary.json
# Ledger: a start and a done row per call, run ids <run-id>.r1 .. .rN, <run-id>.judge, <run-id>.escalation.
#   The done note carries panel=<run-id> role=<role> secs=<wall seconds> est_usd=<estimate>; the judge row
#   also carries confirmed= plausible= rejected= escalate=. est_usd: vendor cost if printed (Claude),
#   else list price from scripts/lanes.ts LIST_PRICE (Codex; cached-input factor is an assumption);
#   agy prints no cost and has no list price here → empty.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER_TS="$SKILL_DIR/scripts/pool-ledger.ts"
PANEL_TS="$SKILL_DIR/scripts/panel.ts"

die() { echo "review-panel: $*" >&2; exit 1; }
log() { echo "review-panel: $*" >&2; }

if command -v node >/dev/null 2>&1 && node --experimental-strip-types -e '' >/dev/null 2>&1; then
  TS=(node --experimental-strip-types)
elif command -v bun >/dev/null 2>&1; then
  TS=(bun)
else
  die "need node >= 22.6 or bun"
fi
command -v jq >/dev/null 2>&1 || die "need jq"

[ $# -ge 3 ] || die "usage: review-panel.sh <brief> <repo> <run-id> [--builder V] [--ledger PATH] [--lane FILE] [--timeout SECS] [--escalate] [--allow-main-checkout] [--dry-run]"
BRIEF=$1 REPO=$2 RUN_ID=$3
shift 3
BUILDER="" LEDGER=${POOL_LEDGER:-} LANE_FILE="" TIMEOUT=1500 ESCALATE=0 ALLOW_MAIN=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --builder) BUILDER=${2:?}; shift 2 ;;
    --ledger) LEDGER=${2:?}; shift 2 ;;
    --lane) LANE_FILE=${2:?}; shift 2 ;;
    --timeout) TIMEOUT=${2:?}; shift 2 ;;
    --escalate) ESCALATE=1; shift ;;
    --allow-main-checkout) ALLOW_MAIN=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done
case "$BUILDER" in "" | none | claude | codex | agy | grok) ;; *) die "--builder must be claude|codex|agy|grok" ;; esac
case "$RUN_ID" in *[!A-Za-z0-9._-]* | "") die "run-id may only use A-Z a-z 0-9 . _ -" ;; esac
[ -f "$BRIEF" ] || die "brief missing: $BRIEF"
[ -d "$REPO" ] || die "repo dir missing: $REPO"
BRIEF=$(cd "$(dirname "$BRIEF")" && pwd)/$(basename "$BRIEF")
REPO=$(cd "$REPO" && pwd)
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "repo is not a git checkout: $REPO (codex needs one)"

LEDGER=${LEDGER:-$REPO/.coord/model-routing/pool-ledger.tsv}
RUN_DIR="$(dirname "$LEDGER")/runs/$RUN_ID"

# ---- panel ------------------------------------------------------------------------------
if [ -n "$LANE_FILE" ]; then
  PANEL=$(jq '{builder: null, reviewers: (.reviewers // []), judge: .judge, escalation: .escalation, reasons: ["from lane file"]}' "$LANE_FILE")
else
  PANEL=$("${TS[@]}" "$PANEL_TS" pick --repo "$REPO" --ledger "$LEDGER" ${BUILDER:+--builder "$BUILDER"})
fi
N=$(jq '[.reviewers[] | select(.command != null)] | length' <<<"$PANEL")
[ "$N" -ge 1 ] || die "no reviewer could be placed: $(jq -c .reasons <<<"$PANEL")"

if [ "$DRY" -eq 1 ]; then
  jq --arg run_dir "$RUN_DIR" --arg ledger "$LEDGER" '{dry_run: true, run_dir: $run_dir, ledger: $ledger,
    reviewers: [.reviewers[] | {lane, account}], judge: (.judge | if . then {lane, account} else null end),
    escalation: (.escalation | if . then {lane, account} else null end), reasons}' <<<"$PANEL"
  exit 0
fi

{ [ -e "$RUN_DIR/final.md" ] || [ -e "$RUN_DIR/summary.json" ]; } && die "run dir already has a panel result: $RUN_DIR (pick another run-id)"
mkdir -p "$RUN_DIR"
printf '%s\n' "$PANEL" >"$RUN_DIR/panel.json"

now() { perl -MTime::HiRes=time -e 'printf "%.1f", time'; }

run_timeout() {
  local t=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=30 "$t" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after=30 "$t" "$@"
  else
    perl -e 'alarm shift; exec @ARGV' "$t" "$@" # best effort: grandchildren may outlive it
  fi
}

# run_call <role> <member-json> <brief-file>: ledger start, run, summarize, ledger done, <role>.json.
run_call() {
  local role=$1 member=$2 brief=$3
  local p="$RUN_DIR/$role" lane vendor model effort account cmd t0 t1 secs rc sum ok est detail note extra=""
  lane=$(jq -r .lane <<<"$member")
  vendor=$(jq -r .vendor <<<"$member")
  model=$(jq -r .model <<<"$member")
  effort=$(jq -r .effort <<<"$member")
  account=$(jq -r .account <<<"$member")
  cmd=$(jq -r .command <<<"$member")
  "${TS[@]}" "$LEDGER_TS" --ledger "$LEDGER" start --account "$account" --vendor "$vendor" --model "$model" \
    --effort "$effort" --run-id "$RUN_ID.$role" --note "panel=$RUN_ID role=$role lane=$lane" >/dev/null
  t0=$(now)
  set +e
  REVIEW_BRIEF="$brief" run_timeout "$TIMEOUT" bash -c "$cmd" >"$p.out" 2>"$p.err" </dev/null
  rc=$?
  set -e
  t1=$(now)
  secs=$(perl -e 'printf "%.1f", $ARGV[1] - $ARGV[0]' "$t0" "$t1")
  [ "$rc" -ne 124 ] || echo "review-panel: timeout after ${TIMEOUT}s" >>"$p.err"
  sum=$("${TS[@]}" "$PANEL_TS" summarize --vendor "$vendor" --model "$model" --output "$p.out" --stderr "$p.err" --exit "$rc")
  jq -r .text <<<"$sum" >"$p.md"
  ok=$(jq -r .ok <<<"$sum")
  est=$(jq -r '.est_usd // empty' <<<"$sum")
  detail=$(jq -r .detail <<<"$sum")
  if [ "$role" = judge ] && [ "$ok" = true ]; then
    extra=$("${TS[@]}" "$PANEL_TS" verdicts --file "$p.md" --escalations "$RUN_DIR/escalations.md")
    printf '%s\n' "$extra" >"$RUN_DIR/verdicts.json"
    extra=$(jq -r '"confirmed=\(.confirmed) plausible=\(.plausible) rejected=\(.rejected) escalate=\(.escalate)"' <<<"$extra")
  fi
  note="panel=$RUN_ID role=$role secs=$secs${est:+ est_usd=$est}${extra:+ $extra}"
  "${TS[@]}" "$LEDGER_TS" --ledger "$LEDGER" done --account "$account" --vendor "$vendor" --model "$model" \
    --effort "$effort" --run-id "$RUN_ID.$role" --output "$p.out" --stderr "$p.err" --exit "$rc" --note "$note" >/dev/null
  jq -n --arg role "$role" --arg lane "$lane" --arg vendor "$vendor" --arg model "$model" --arg effort "$effort" \
    --arg account "$account" --argjson secs "$secs" --argjson rc "$rc" --argjson sum "$sum" \
    '{role: $role, lane: $lane, vendor: $vendor, model: $model, effort: $effort, account: $account, secs: $secs,
      exit: $rc, ok: $sum.ok, detail: $sum.detail, tokens_in: $sum.tokens_in, cached_in: $sum.cached_in,
      tokens_out: $sum.tokens_out, est_usd: $sum.est_usd}' >"$p.json"
  log "$role $lane@$account: ok=$ok secs=$secs${est:+ est_usd=$est}${detail:+ ($detail)}"
}

label() { printf "\\$(printf '%03o' $((65 + $1)))"; } # 0 → A

# ---- 1. reviewers, in parallel -----------------------------------------------------------
{
  cat <<'EOF'
You are one reviewer on an independent review panel. Reviewers from other model vendors review the
same work in parallel, and a judge will compare all findings and verify each one against the code.
Work read-only: do not edit or create files, do not build, do not run tests, do not commit.

Find real defects: bugs, regressions, security problems, broken edge cases, behaviour that contradicts
the brief. Skip style nits. Read the code behind each claim before you report it.

Report each finding as:
### <short title>
- Severity: high | medium | low
- Location: <path>:<line>
- Problem: <what is wrong, and when it happens>
- Evidence: <the code you read that shows it>
- How to confirm: <an input or test that would show it>

If you find nothing, answer exactly: NO FINDINGS.

--- REVIEW BRIEF ---
EOF
  cat "$BRIEF"
} >"$RUN_DIR/reviewer-brief.md"

PANEL_T0=$(now)
PIDS=""
i=0
while [ "$i" -lt "$N" ]; do
  member=$(jq -c "[.reviewers[] | select(.command != null)][$i]" <<<"$PANEL")
  run_call "r$((i + 1))" "$member" "$RUN_DIR/reviewer-brief.md" &
  PIDS="$PIDS $!"
  i=$((i + 1))
done
for pid in $PIDS; do wait "$pid" || true; done

# ---- 2. judge -------------------------------------------------------------------------------
OKS=0
REPORTS=""
i=0
while [ "$i" -lt "$N" ]; do
  r="r$((i + 1))"
  L=$(label "$i")
  meta="$RUN_DIR/$r.json"
  if [ -f "$meta" ] && [ "$(jq -r .ok "$meta")" = true ]; then
    OKS=$((OKS + 1))
    REPORTS="$REPORTS
--- REVIEWER $L ($(jq -r '"\(.model) \(.effort), \(.vendor)"' "$meta")) ---
$(cat "$RUN_DIR/$r.md")
"
  else
    REPORTS="$REPORTS
--- REVIEWER $L: no report ($( [ -f "$meta" ] && jq -r '.detail // "failed"' "$meta" || echo "did not finish")) ---
"
  fi
  i=$((i + 1))
done

JUDGE=$(jq -c '.judge // empty' <<<"$PANEL")
JUDGE_OK=false
if [ "$OKS" -eq 0 ]; then
  log "no reviewer produced a report; judge skipped"
elif [ -z "$JUDGE" ] || [ "$(jq -r .command <<<"$JUDGE")" = null ]; then
  log "no judge lane placed; the coordinator must judge the raw findings"
else
  {
    cat <<EOF
You are the judge of a code review panel. $N reviewers reviewed the same work independently; their
reports are below, labelled A, B, C. Work read-only: read the code and git history yourself; do not
edit or create files, do not build, do not run tests, do not commit.

1. Collect every finding from all reports. Merge duplicates (same root cause) into one finding and
   note which reviewers found it.
2. Debate each finding: give the strongest argument that it is real and the strongest argument that
   it is not, using what the other reports say.
3. Verify each finding against the code in this repository: read the cited lines and their callers.
4. Give each finding exactly one verdict:
   CONFIRMED  you verified in the code that the defect exists.
   PLAUSIBLE  likely real, but proof needs running code or tests, or the evidence is incomplete.
   REJECTED   the code shows it is not a defect, or the claim is wrong.
5. Escalate: "dispute" when reviewers contradict each other and the code does not settle it;
   "needs-test" when only running code or tests can prove it; otherwise "no".
Report a defect that every reviewer missed only if you verified it, with "Found by: judge".

Output exactly this format and nothing else:
## F<n>: <short title>
Verdict: CONFIRMED | PLAUSIBLE | REJECTED
Severity: high | medium | low
Location: <path>:<line>
Found by: <letters, or judge>
Evidence: <what you read in the code>
Debate: <for vs against, one or two lines>
Escalate: no | dispute | needs-test

End with one line: COUNTS confirmed=<n> plausible=<n> rejected=<n> escalate=<n>

--- REVIEW BRIEF ---
EOF
    cat "$BRIEF"
    printf '%s\n' "$REPORTS"
  } >"$RUN_DIR/judge-brief.md"
  run_call judge "$JUDGE" "$RUN_DIR/judge-brief.md"
  JUDGE_OK=$(jq -r .ok "$RUN_DIR/judge.json")
fi

# ---- 3. escalation (opt-in) -----------------------------------------------------------------
ESC=$(jq -c '.escalation // empty' <<<"$PANEL")
ESC_N=0
[ ! -f "$RUN_DIR/verdicts.json" ] || ESC_N=$(jq -r .escalate "$RUN_DIR/verdicts.json")
ESC_STATE="not needed"
if [ "$ESC_N" -gt 0 ]; then
  ESC_STATE="$ESC_N finding(s) escalated; not run (pass --escalate)"
  if [ "$ESCALATE" -eq 1 ]; then
    GIT_DIR_=$(git -C "$REPO" rev-parse --absolute-git-dir)
    COMMON_DIR=$(cd "$REPO" && git rev-parse --path-format=absolute --git-common-dir)
    if [ -z "$ESC" ] || [ "$(jq -r .command <<<"$ESC")" = null ]; then
      ESC_STATE="$ESC_N finding(s) escalated; no escalation lane placed"
    elif [ "$GIT_DIR_" = "$COMMON_DIR" ] && [ "$ALLOW_MAIN" -eq 0 ]; then
      ESC_STATE="$ESC_N finding(s) escalated; refused: repo is not a linked worktree (pass --allow-main-checkout)"
    else
      {
        cat <<'EOF'
You are the escalation reviewer of a code review panel. The judge could not settle the findings below
by reading the code. Prove or refute each one by running the project's tests or a minimal reproduction.
You may run tests and read-only commands. Do not edit, create or delete tracked files and do not commit.
If you need a scratch test, put it under $TMPDIR and delete it afterwards.

For each finding output:
## F<n>: <short title>
Result: PROVEN | REFUTED | INCONCLUSIVE
Command: <exact command you ran>
Output: <the relevant lines>

--- FINDINGS TO PROVE ---
EOF
        cat "$RUN_DIR/escalations.md"
        echo
        echo "--- ORIGINAL REVIEW BRIEF ---"
        cat "$BRIEF"
      } >"$RUN_DIR/escalation-brief.md"
      BEFORE=$(git -C "$REPO" status --porcelain)
      run_call escalation "$ESC" "$RUN_DIR/escalation-brief.md"
      AFTER=$(git -C "$REPO" status --porcelain)
      ESC_STATE="ran $(jq -r .lane "$RUN_DIR/escalation.json")"
      [ "$BEFORE" = "$AFTER" ] || ESC_STATE="$ESC_STATE; WARNING: git status changed during escalation, inspect $REPO"
    fi
  fi
fi
PANEL_T1=$(now)
WALL=$(perl -e 'printf "%.1f", $ARGV[1] - $ARGV[0]' "$PANEL_T0" "$PANEL_T1")

# ---- 4. final.md + summary.json ---------------------------------------------------------------
CALL_FILES=()
for f in "$RUN_DIR"/r[0-9]*.json "$RUN_DIR/judge.json" "$RUN_DIR/escalation.json"; do
  [ ! -f "$f" ] || CALL_FILES+=("$f")
done
if [ ${#CALL_FILES[@]} -gt 0 ]; then CALLS=$(jq -s . "${CALL_FILES[@]}"); else CALLS='[]'; fi
COUNTS=$( [ -f "$RUN_DIR/verdicts.json" ] && cat "$RUN_DIR/verdicts.json" || echo null)
jq -n --arg run_id "$RUN_ID" --arg builder "${BUILDER:-}" --arg repo "$REPO" --arg brief "$BRIEF" --arg ledger "$LEDGER" \
  --argjson wall "$WALL" --argjson calls "$CALLS" --argjson counts "$COUNTS" --arg escalation "$ESC_STATE" \
  --arg final "$RUN_DIR/final.md" \
  '{run_id: $run_id, builder: (if $builder == "" then null else $builder end), repo: $repo, brief: $brief,
    ledger: $ledger, wall_secs: $wall, est_usd_total: ([$calls[].est_usd // 0] | add // 0 | . * 100000 | round / 100000),
    verdicts: $counts, escalation: $escalation, calls: $calls, final: $final}' >"$RUN_DIR/summary.json"

{
  echo "# Review panel $RUN_ID"
  echo
  echo "Repo: \`$REPO\`  Brief: \`$BRIEF\`  Builder: ${BUILDER:-unknown}"
  echo "Wall time: ${WALL}s (reviewers in parallel, then judge).  Estimated cost: \$$(jq -r .est_usd_total "$RUN_DIR/summary.json") (see notes)."
  echo
  echo "| role | lane | account | ok | secs | tokens in (cached) / out | est_usd |"
  echo "|---|---|---|---|---|---|---|"
  jq -r '.[] | "| \(.role) | \(.lane) | \(.account) | \(.ok) | \(.secs) | \(.tokens_in // "-") (\(.cached_in // "-")) / \(.tokens_out // "-") | \(.est_usd // "-") |"' <<<"$CALLS"
  echo
  if [ "$COUNTS" != null ]; then
    echo "Verdicts: $(jq -r '"\(.confirmed) confirmed, \(.plausible) plausible, \(.rejected) rejected, \(.escalate) escalated"' <<<"$COUNTS").  Escalation: $ESC_STATE."
  fi
  echo
  if [ "$JUDGE_OK" = true ]; then
    echo "## Judge findings"
    echo
    cat "$RUN_DIR/judge.md"
  else
    echo "## No judge verdicts"
    echo
    echo "The judge did not run or failed ($( [ -f "$RUN_DIR/judge.json" ] && jq -r .detail "$RUN_DIR/judge.json" || echo "not placed")). The coordinator must judge the raw reports:"
    printf '%s\n' "$REPORTS"
  fi
  if [ -f "$RUN_DIR/escalation.md" ]; then
    echo
    echo "## Escalation ($(jq -r '"\(.model) \(.effort)"' "$RUN_DIR/escalation.json"))"
    echo
    cat "$RUN_DIR/escalation.md"
  fi
  echo
  echo "---"
  echo "Raw reports: \`$RUN_DIR/r*.md\`. est_usd: Claude = vendor-reported; Codex = list price (lanes.ts LIST_PRICE, cached input at 10%, an assumption); agy = none."
} >"$RUN_DIR/final.md"

jq -c '{run_id, wall_secs, est_usd_total, verdicts, escalation, final}' "$RUN_DIR/summary.json"
[ "$OKS" -gt 0 ] || exit 2
[ "$JUDGE_OK" = true ] || exit 3
