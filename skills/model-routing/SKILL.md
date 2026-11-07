---
name: model-routing
description: "Use when deciding which model and effort should run a task across Claude (Haiku 5.5, Sonnet 5.5, Opus 5.5) via headless sub-accounts, Codex (GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra), Antigravity/Gemini (Argon, Flash), or Grok (grok-4.7), when delegating a work order to a sub-account, when a cross-vendor review is needed, when a classifier (Jev / TypeSafe System One) should pick the lane for you, or when a pool is close to its 5h/weekly limit."
---

# Model Routing

## Overview

Every task runs on the **cheapest rung whose verifier can still prove correctness**. The coordinator (Opus Xhigh on the main Ultra account) specifies, routes, and verifies; workers type.

**Route first with Jev**, a System One classifier from TypeSafe. It returns a typed judgment with probabilities; a deterministic function on top picks the lane, applies risk/ambiguity bumps, respects the privacy rule, and asks the pool ledger whether the primary pool still has budget. Measured 2026-11-07 (`jev-1.14.0`): 0.2–0.6 s per HTTP round trip, ~1.2K input tokens per brief ≈ $0.00005 at $0.042/Mtok (<https://docs.typesafe.ai/models.md>).

**Run the scripts; don't hand-route.** `route.ts <brief>` prints the lane, `dispatch.sh` launches it, `review-panel.sh` runs the review panel, `scripts/pool-ledger.ts` keeps the books (see "Files").

**Reviews are panels, not one reviewer.** Default: 2× Terra high + Argon high in parallel (read-only), then a Terra high judge that makes the findings debate, verifies each against the code and labels it CONFIRMED / PLAUSIBLE / REJECTED. Sol high is the escalation rung, only for disputed findings or findings that need a test run. See "Review panel".

Facts checked 2026-11-06; CLI flags re-verified 2026-11-07 against `--help` (agy has since updated itself to 1.5.3; the panel's Argon command ran clean on it, the rest of `reference-agy-cli.md` is from 1.5.2). Re-check `claude --help`, `codex exec --help`, `agy --help`/`agy models`, `grok --help` when a CLI version changes, and the plan tables when a vendor announces new limits.

## Example account layout

The skill assumes one **main** Claude account, N **team seats**, and one subscription each for Codex, Google and Grok. A typical layout (plan facts checked nov 2026; inspect your own config files without reading any token):

| Config dir | Account (ledger name) | Plan | 5h window | Weekly | Role here |
|---|---|---|---|---|---|
| `~/.claude.json` (default, no `CLAUDE_CONFIG_DIR`) | `main` | **Ultra** (ex-Max 20×), $200/mo | **none** (verified) | 10× Pro weekly | Coordinator / planning / judge |
| `~/.claude-seat-a/` | `seat-a` | Team Premium seat, $100/mo | 5× Pro / 5h | 5× Pro / week | Worker pool A |
| `~/.claude-seat-b/` | `seat-b` | Team Premium seat (same team) | 5× Pro / 5h | 5× Pro / week | Worker pool B |
| `~/.claude-seat-c/` | `seat-c` | Team Premium seat (same team) | 5× Pro / 5h | 5× Pro / week | Worker pool C |
| `~/.claude-seat-d/` | `seat-d` | Team Premium seat (same team) | 5× Pro / 5h | 5× Pro / week | Worker pool D |

Two facts shape the routing:

1. **An Ultra plan belongs on the main account.** Its config shows `planDisplayName: "Ultra"`, `organizationRateLimitTier: default_claude_max_20x`. Ultra has **no 5-hour limit** on verified accounts (Anthropic pricing, nov 2026) — ideal for long planning/judge runs, where a 5h cap would force a split mid-reasoning.

2. **Team seats are seats on one Team org, not independent subscriptions.** Their config shows `organizationType: claude_team`, the same `organizationName` on every seat, and `userRateLimitTier: default_claude_max_5x`. Seats within the same Anthropic Team subscription are *all paid by the owner for team work* — rotating load across them is the normal use case of a team subscription, not a Consumer Terms edge case. (The 'Consumer Terms forbid pooling' concern applies to multiple independent personal subscriptions, not to seats on one Team org.)

Codex: an OpenAI **Pro** tier ($100/mo option), under `~/.codex` (`CODEX_HOME=~/.codex`). Pro plans have **no 5-hour limit** (OpenAI Codex pricing, nov 2026); only the weekly cap applies.

Google: **Google AI Pro** (49.99 EUR in EU / $19.99 US — regional bundle; includes Gemini CLI + Antigravity). Quota is **1,500 requests per user per day** across Gemini Code Assist / Antigravity (geminicli.com docs, nov 2026), not a 5h window.

Grok: **X Subscription** (replaces SuperGrok since 12 oct 2026). One weekly pool shared Grok + Cursor; xAI publishes no fixed count, only a percentage bar.

### Configure your seats

Seat names are not hard-coded. `scripts/config.ts` resolves them, highest precedence first:

1. `MODEL_ROUTING_SEATS=seat-a,seat-b` (comma list; overrides `seats` from the file).
2. `~/.config/model-routing/config.json` (or the path in `$MODEL_ROUTING_CONFIG`):
   ```json
   { "seats": ["seat-a", "seat-b", "seat-c", "seat-d"], "mainAccount": "main", "seatConfigDirPattern": "~/.claude-{seat}" }
   ```
3. Defaults: seats `seat-a`…`seat-d`, main account `main`, seat dir `~/.claude-{seat}`.

`route.ts` rotates team lanes over these seats, `dispatch.sh` refuses a seat that is not configured or whose config dir is missing, and `pool-ledger.ts status` lists them. `node --experimental-strip-types scripts/config.ts` prints the resolved config. Keep the file outside the repo; seat names are personal data.

## Lane catalogue

Build ladder, cheapest-that-passes order. "USD/task" is Artificial Analysis Intelligence Index v5 (27 oct 2026); treat as order-of-magnitude for subscription workloads — the ledger (see below) is authoritative.

| Work class | Vendor | Model | Effort | USD/task (AA v5) | Pool | CLI command (headless) |
|---|---|---|---|---|---|---|
| Bulk, extraction, triage | Claude | haiku 5.5 | medium | ~$0.05 | team seat | `CLAUDE_CONFIG_DIR=~/.claude-<seat> command claude -p --model haiku --effort medium` |
| Mechanical edit frozen | Claude | haiku 5.5 | max | ~$0.21 | team seat | `… --model haiku --effort max` |
| Code feature 1–2 files frozen | Claude | sonnet 5.5 | high | ~$0.88 | team seat | `… --model sonnet --effort high` |
| Refactor multi-file | Claude | opus 5.5 | medium | ~$1.34 | team seat | `… --model opus --effort medium` |
| Diagnosis hard, diff review | Claude | opus 5.5 | high | ~$1.82 | team seat | `… --model opus --effort high` |
| Spec / plan / final judge | Claude | opus 5.5 | xhigh | ~$3.46 | **Ultra (main)** | `env -u CLAUDE_CONFIG_DIR command claude -p --model opus --effort xhigh` |
| **Review panel: reviewer ×2** | Codex | gpt-6.1-terra | high | ($1/$5 MTok); measured ~$0.02–0.03, ~28 s per reviewer | Codex Pro | `codex exec -m gpt-6.1-terra -c model_reasoning_effort=high --sandbox read-only -C <repo> --json - < <brief>` |
| **Review panel: third-vendor reviewer** | Antigravity | gemini-4-argon-high | high (in the id) | — (~81 s measured) | Google AI Pro | `cd <repo> && agy -p "$(cat <brief>)" --model gemini-4-argon-high --mode plan --settings '<allow list>' --output-format json --print-timeout 30m </dev/null` |
| **Review panel: judge** | Codex | gpt-6.1-terra | high | ($1/$5 MTok); measured ~$0.02, ~35 s | Codex Pro | same as the reviewer, with the judge brief that `review-panel.sh` writes |
| **Escalation: prove a disputed finding** (may run tests) | Codex | gpt-6.1-sol | high | ($2/$10 MTok) | Codex Pro | `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high --sandbox workspace-write -C <worktree> --json - < <brief>` |
| Panel when Codex built: reviewer + judge (+ escalation) | Claude | opus 5.5 | high | ~$1.82 | team seat | `… --model opus --effort high --permission-mode dontAsk --allowedTools Read Grep Glob 'Bash(git diff:*)' …` (escalation: `bypassPermissions` + deny Edit/Write/commit) |
| Overflow: single diff review | Codex | gpt-6.1-sol | high | ($2/$10 MTok) | Codex Pro | `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high --sandbox read-only -C <repo> --json - < <brief>` (only when an Opus review lane has no seat) |
| Overflow: spec attack | Codex | gpt-6.1-sol | xhigh | ($2/$10 MTok) | Codex Pro | `… -c model_reasoning_effort=xhigh --sandbox read-only -C <repo> --json - < <brief>` |
| Overflow: design debate | Codex | gpt-6-astra | xhigh | ($10/$50 MTok) | Codex Pro | `codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh --sandbox read-only -C <repo> --json - < <brief>` |
| Overflow: build | Codex | gpt-6.1-sol | medium | ($2/$10 MTok) | Codex Pro | `codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium --dangerously-bypass-approvals-and-sandbox -C <worktree> --json - < <brief>` |
| Overflow: bulk / scripted computer use | Codex | gpt-6.1-terra | xhigh | ($1/$5 MTok) | Codex Pro | `codex exec -m gpt-6.1-terra -c model_reasoning_effort=xhigh --sandbox read-only -C <repo> --json - < <brief>` |
| Google overflow build | Antigravity | gemini-4-argon-medium | medium (in the id) | — | Google AI Pro | `cd <worktree> && agy -p "$(cat <brief>)" --model gemini-4-argon-medium --mode accept-edits --settings '<allow list>' --output-format json --print-timeout 45m </dev/null` |
| Google bulk | Antigravity | gemini-3.8-flash-medium | medium (in the id) | — | Google AI Pro | `cd <dir> && agy -p "$(cat <brief>)" --model gemini-3.8-flash-medium --mode plan --output-format json --print-timeout 10m </dev/null` |
| Last-line overflow build | Grok | grok-4.7 (CLI default, not pinned) | high | ($2/$6 MTok) | X Subscription | `command grok --no-auto-update --cwd <repo> --session-id <uuid> --no-memory --verbatim --reasoning-effort high --max-turns N --always-approve --output-format json --prompt-file <brief>` |

`route.ts` emits these commands fully quoted; the agy commands also get a preamble listing the allowed shell commands (gotchas 2–3 in `reference-agy-cli.md`). Panel members read their brief from `$REVIEW_BRIEF`; `review-panel.sh` writes one brief per role and runs them.

### CLI flags (verified with `--help` on 2026-11-07)

- **claude 2.1.319**: `-p`, `--model haiku|sonnet|opus|<full id>`, `--effort low|medium|high|xhigh|max`, `--output-format text|json|stream-json`, `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--allowedTools`/`--disallowedTools <tools...>`, `--no-session-persistence`, `--max-budget-usd`. `--max-turns` is accepted but no longer listed in `--help`. Seat = `CLAUDE_CONFIG_DIR=~/.claude-<seat>`; main Ultra = `env -u CLAUDE_CONFIG_DIR` (sessions often run with a seat dir exported).
- **codex exec 0.167.0**: `-m <model>` (`gpt-6.1-terra` accepted: `codex exec -m gpt-6.1-terra -c model_reasoning_effort=high --sandbox read-only "say ok"` → "ok", exit 0, 7.9 s wall, 2026-11-07), `-c model_reasoning_effort=<low|medium|high|xhigh|max|ultra>` (levels from `~/.codex/models_cache.json` for sol/terra/astra), `-s/--sandbox read-only|workspace-write|danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `-C/--cd <dir>`, `--json` (JSONL events; tokens on `turn.completed.usage{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`; **no cost, duration or rate-limit field**, so `review-panel.sh` times each call itself and estimates cost from list prices), `-o <file>` (last message), `--output-schema <file>`, `--ephemeral`, `--skip-git-repo-check`. Prompt: argument, or stdin with `-`. **`-p` is `--profile`, not prompt.**
- **agy 1.5.2** (full reference: `reference-agy-cli.md`): prompt is `-p "<text>"` — there is **no `-f`**, and `-p -` sends a literal "-". `--model <id>` with the effort suffix (`gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`), or a base id plus `--effort low|medium|high` (never both; `xhigh`/`max` are listed in `--help` but rejected). `--mode plan|accept-edits|auto`, `--output-format text|json|stream-json` (JSON: `status`, `response`, `usage{input_tokens,output_tokens,...}`, `denied_actions`; no cost field), `--print-timeout <dur>` (always set it), `--settings '<json>'`, `--add-dir <dir>`.
  - Headless plan mode soft-denies anything not allowed, and the first denial ends the run with an empty answer. Reads **inside cwd** need no rule. For another tree use `--add-dir <dir>` or `read_file(<dir>)`; **not `read_file(<dir>/**)`** (it denies the directory's direct children). The model lists and greps with shell commands, so a review needs `command(...)` rules, e.g. `--settings '{"permissions":{"allow":["command(git diff)","command(git log)","command(rg)","command(ls)","command(sed -n)"]}}'`. `list_dir(...)`/`grep_search(...)` rules had no observable effect in 1.5.2.
  - Exit 0 is not success: also require `status=="SUCCESS"`, empty `denied_actions`, no `finished_reason`, non-empty `response`. Quota: `agy -p /usage --output-format json` (free).
- **grok 1.0.78**: `--cwd <dir>` (**there is no `-C`**: `error: unexpected argument '-C'`), `-s/--session-id <uuid>`, `--reasoning-effort/--effort`, `--max-turns`, `--always-approve` or `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`, `--output-format plain|json|streaming-json|streaming-messages-json`, `--prompt-file`, `--verbatim`, `-p/--single <prompt>`. `--no-auto-update` and `--no-memory` are accepted but hidden from `--help`. Session cost afterwards: `grok usage <session-id>`.

**Skip these** (dominated on AA v5): Sonnet low/medium/xhigh, Opus low, Sol max, Grok 4.5/4.6. Never `max` by default on any model; Sonnet max is the *only* defensible max use (Terminal-Bench 4.0 ceiling for agentic terminal work that Opus high failed).

## Task classes → lane + reviewer

Jev decides *class*; the deterministic function below picks the lane, bumps on risk/ambiguity/context, and attaches a review panel whose members all come from **vendors other than the builder's**. Other classes get a panel only when Jev's `cross_vendor_review_recommended` p > 0.5.

| Class | Default lane | Rung-up | Reviewer (other vendor) |
|---|---|---|---|
| `bulk_extraction` | Haiku max (team seat) | Terra xhigh (Codex) | script count (no model) |
| `mechanical_edit` | Haiku max (team seat) | Sonnet high (team seat) | coordinator diff |
| `feature_frozen` | Sonnet high (team seat) | Opus medium (team seat) | **Review panel** (always attached) |
| `refactor_multifile` | Opus medium (team seat) | Opus high (team seat) | **Review panel** (always attached) |
| `debug_hard` | Opus high (team seat) | Sonnet max (team seat) | **Review panel** (always attached) |
| `planning_spec` | **Opus xhigh (main Ultra)** | debate with Astra/Argon | Sol xhigh spec-gate + Argon high; the coordinator judges |
| `review_frozen` | **Review panel**: 2× Terra high + Argon high → Terra high judge | Escalation: Sol high (tests) for disputed / needs-test findings | n/a (is the review) |
| `research_recent` | Astra xhigh (Codex) | Argon high (agy) | coordinator checks citations |
| `chat_qa` | Haiku medium (team seat) | Haiku max (team seat) | coordinator |

**Invariants**:
- The coordinator (main Ultra) never dispatches planning/review to a sub-account; those require xhigh and no 5h limit.
- Reviews are cross-vendor panels. Claude (or Grok) built → 2× Terra high + Argon high, Terra high judge, Sol high escalation. **Codex built → Opus high + Argon high, Opus high judge, Opus high escalation.** agy built → 2× Terra high + Opus high, Terra judge. Never same-vendor approval; a member whose pool is cold is replaced by a same-rung member from another non-builder vendor, else left out (the judge falls back to the coordinator).
- Escalation: one failure → fresh run on same rung with a sharper brief (not `--resume`; chained resumes drop directives). Second failure → **one** rung up. Third → coordinator takes over.
- Never `max` by default. The useful ceiling is `xhigh`. Exception: Sonnet max for agentic terminal ceiling.
- Never silently downgrade planning or review quality when a pool is exhausted. Move to another vendor at the same rung; if no vendor is available, wait or hand to coordinator. Downgrading is allowed only inside *build/bulk* work classes.

## Jev loop

`route.ts <brief>` → one `POST https://api.typesafe.ai/v1/systemone` (`model: jev-latest`, `state: {brief}`) asks these independent questions in parallel (full wording and Choice criteria in `route.ts`):

```
kind:           Choice[bulk_extraction | mechanical_edit | feature_frozen |
                       refactor_multifile | debug_hard | planning_spec |
                       review_frozen | research_recent | chat_qa]
risk:           Noul("changes infrastructure, security, a schema migration, or
                      production code without a clear reproduction?")
ctx_size:       Score[tiny <1K | small 1–10K | mid 10–50K | large 50–200K | xl >200K]
needs_recent_facts:                Noul("needs public facts that changed in the last 60 days?")
cross_vendor_review_recommended:   Noul("does the change deserve a reviewer from another vendor?")
estimated_steps:                   Score[1 | 2-5 | 6-20 | >20]
touches_secrets:                   Noul("might involve secrets, .env, tokens, credentials?")
```

Reading the answers (docs.typesafe.ai/primitives.md, /confidence.md): a Choice returns `choice`, `confidence`, `probabilities`; a Score returns `score`, `confidence`, per-level `probabilities` (`ctx_size.top` = the most likely level); a Noul returns only `noul` = p(yes), used as `.p` below. `needs_recent_facts` and `estimated_steps` are asked speculatively and reported, not used by `pickLane()`.

Deterministic decision on the judgment:

```ts
function pickLane(j: JevJudgment, pools: PoolStatus): Lane {
  // 1. Secrets guard — never route a brief with secrets to a worker
  if (j.touches_secrets.p > 0.5) return LANES.coordinator_only; // 0.2 flagged briefs that only forbid printing secrets

  // 2. Base lane from kind
  let lane = LANE_BY_KIND[j.kind.top];

  // 3. Risk bump. An unsure risk answer (|2p−1| < 0.4) counts as high risk; it never discards kind.
  if (j.risk.p > 0.6 || riskUnsure) lane = oneRungUp(lane);

  // 4. Ambiguity bump (Choice confidence low)
  if (j.kind.confidence < 0.55) lane = oneRungUp(lane);

  // 5. Context guard: Haiku is cliff > 100K
  if (j.ctx_size.top === "large" && lane === LANES.haiku_max) lane = LANES.sonnet_high;
  if (j.ctx_size.top === "xl" && lane !== LANES.opus_xhigh)   lane = LANES.opus_high;

  // 6. Pool capacity guard (see "Capacity budget" below)
  lane = pools.chooseAccountFor(lane) ?? overflowSibling(lane, pools);

  // 7. Review panel: the lane itself for review_frozen; for builds when the class is
  //    panel-reviewed (feature/refactor/debug/planning) or Jev recommends cross-vendor review
  lane.panel = lane === LANES.review_panel ? pickPanel(builder)
    : PANEL_BY_DEFAULT[kind] || j.cross_vendor_review_recommended.p > 0.5 ? pickPanel(lane.vendor) : null;

  return lane;
}
```

How `route.ts` implements the open points:
- `oneRungUp(lane)` uses the class's "Rung-up" column for the first bump from the class default, then a generic ladder (haiku medium → haiku max → sonnet high → opus medium → opus high). Build lanes stop at opus high: Ultra is not for builds, and the next step is a coordinator takeover after failures.
- Step 5 on a review lane with `xl` context goes to Opus high **read-only** (`opus_high_review`), not to a build lane.
- `chooseAccountFor`: team lanes → `next_seat()`; Ultra → `main`; Codex → `codex`; agy → `google`; Grok → `grok`; each unless the ledger marks it cooling. `overflowSibling`: builds → Sol medium → Argon medium → Grok; bulk → Terra/Flash; reviews → the other review vendor; planning → Astra xhigh, else queue (`coordinator_only`). Never a silent downgrade of planning or review.
- `pickPanel(builder)` (was `pickReviewer`): see the invariants above; planning gets Sol xhigh + Argon high with the coordinator as judge. Review lanes get no second panel. Member commands read their brief from `$REVIEW_BRIEF`; the lane JSON's `review_command` runs the whole panel (`review-panel.sh "$REVIEW_BRIEF" <repo> "$RUN_ID-review" --builder <vendor>`). For `review_frozen` briefs pass `route.ts --builder <vendor>` when you know who wrote the diff.

Fallback: only if the Jev API times out (>2s), errors, or returns `kind` confidence below 0.4 does `route.ts` fall back to `scripts/router-fallback.ts` (regex keyword classifier). **Low confidence in `risk` alone keeps Jev's kind** and applies the risk bump as if risk were high. Noul has no `confidence` field, so `risk` confidence is `|2p − 1|` (docs.typesafe.ai/confidence.md): a `risk` p between 0.3 and 0.7 is "unsure". (Before 2026-11-07 an unsure risk sent the whole decision to the fallback: a brief that Jev called `refactor_multifile` at 0.94 was routed to `review_frozen` because it mentioned "review". Regression tests: `tests/route.test.ts`.) The fallback maps one clear keyword class to its default lane (risk keywords bump build lanes one rung) and otherwise uses the conservative default `opus_medium`; it **always** attaches a review panel. Every run is logged to `router-log.jsonl` next to the ledger (brief hash, source, Jev kind, fallback kind, `disagree`, Jev error); the coordinator reviews lines with `"disagree": true` or a `jev_error`.

Privacy: Jev receives the brief *you wrote* (Goal, Scope, Constraints, Non-goals, Proof). No file contents, no secrets, no PII, no `.env`. If the brief itself cannot be shared, run `route.ts <brief> --touches-secrets`; it returns `coordinator_only` without calling Jev. `route.ts` also refuses to send a brief that contains a secret-looking value (private key, `sk-…`, `AKIA…`, `ghp_…`, `xox…-`, `AIza…`, `api_key=…`). The API key lives in `~/.config/typesafe/key` (bare key or `TYPESAFE_API_KEY=…`; `$TYPESAFE_KEY_FILE` overrides the path), outside any repo, never in `.env`; `route.ts` never prints it and redacts it from error text.

## Review panel

**Default for every diff review** (`review_frozen`, and the review attached to feature / refactor / debug builds):

1. **Reviewers, in parallel, read-only**: 2× `codex gpt-6.1-terra` high + 1× `agy gemini-4-argon-high` (third vendor for diversity; the verified plan-mode command and allow list from `reference-agy-cli.md` §1A).
2. **Judge**: `codex gpt-6.1-terra` high, read-only. Gets every report, merges duplicates, makes the findings debate (strongest case for and against), verifies each against the code, and labels it **CONFIRMED** (verified in the code), **PLAUSIBLE** (needs running code or tests), or **REJECTED**. It marks `Escalate: dispute | needs-test | no`.
3. **Escalation rung: Sol high**, only for findings marked `dispute` or `needs-test`, and only with `--escalate`. Sol is the only member that may run tests (`--sandbox workspace-write`, brief forbids source edits; a linked worktree is required unless `--allow-main-checkout`). `review-panel.sh` compares `git status` before and after.

Cross-vendor: if **Codex built** the diff, the panel is Opus high + Argon high, judge Opus high, escalation Opus high (may run tests, Edit/Write/commit denied). agy built → 2× Terra + Opus high. See the invariants above.

```bash
S=~/.claude/skills/model-routing
$S/review-panel.sh review-brief.md "$WT" T51-review --builder claude   # --dry-run first; --escalate to run Sol
cat "$WT/.coord/model-routing/runs/T51-review/final.md"                   # verdicts + per-call secs/tokens/est_usd
```

It writes `<ledger dir>/runs/<run-id>/{panel.json, reviewer-brief.md, r<N>.{out,err,md,json}, judge-brief.md, judge.*, escalations.md, final.md, summary.json}` and one `start` + one `done` row **per call** in the pool ledger (run ids `<run-id>.r1…rN`, `.judge`, `.escalation`). The `done` note carries `secs=` (wall time) and `est_usd=`; the judge row adds `confirmed= plausible= rejected= escalate=`. `est_usd` is the vendor cost when printed (Claude), else a **list-price estimate** for Codex (`LIST_PRICE` in `scripts/lanes.ts`; cached input assumed at 10%, unverified). agy prints neither cost nor price → empty. Exit 2 = no reviewer produced a report, 3 = no judge verdicts (final.md then holds the raw reports for the coordinator).

**Evidence (why a panel):**

| Source | What was observed | Status |
|---|---|---|
| Tweet by Jinjing Liang (X, 2026-11-06) | Same PR, same prompt: GPT-6.1 Sol high 93 s / $0.37 vs 2× GPT-6.1 Terra high 17 s / $0.18. The Terra pair caught 2 bugs Sol missed; Sol's only edge was running tests to prove bugs. Setup: 2 Terra reviewers in parallel + a third Terra that has them debate and settles the final findings. | **Anecdote**: one PR, someone else's setup and prices. To be validated by our ledger. |
| a production project (2026-11-07), review round 2 | Codex Sol high and Argon high reviewed the same diff independently: they overlapped on 3 findings and each found bugs the other missed (Sol 4, Argon 6). | Our data, n = 1. Supports vendor diversity in the panel. |
| Smoke run, this skill (2026-11-07) | Scratch repo, 12-line diff with 4 planted bugs: all three reviewers found all 4; the judge confirmed 5 (4 + one real `NaN` pageSize gap), 0 rejected. Terra reviewers 27.5 / 28.5 s (est $0.031 / $0.016), Argon 81 s, judge 34.7 s (est $0.020); panel wall 116 s, est $0.066 + Argon quota. | Plumbing check only: a trivial diff cannot show diversity gains. Argon was the slowest member. |

**Re-evaluate after 10 panels using the ledger** (findings confirmed per $ and per minute, Sol vs panel): `pool-ledger.ts report` groups cost by model; the per-panel `summary.json` and the judge row's counts give confirmed findings, `secs=` gives minutes. Run a Sol-high single review on a few of the same briefs for the comparison. If the panel does not beat Sol on confirmed findings per $ and per minute, change `PANEL_BY_BUILDER` / `LANE_BY_KIND.review_frozen` back.

## Capacity budget (pools × models × window)

Realistic daily capacity for the example account layout above, assuming one person works ~10h/day and stays within official limits:

**Main Ultra ($200)**
- **No 5h limit** on verified accounts; weekly = 10× Pro's weekly.
- Pro weekly is unpublished but documented at "10–45 prompts per 5h" for Pro. Treating 1 Pro-week ≈ 2× Pro-day ≈ 7×(20–40 prompts) ≈ 140–280 prompts/week → Ultra weekly ≈ 1,400–2,800 prompts/week.
- At Opus xhigh (judge/plan): a judge run is ~2–4 turns. Ultra fits **~350–700 planning/judge runs per week**, far more than any one human can consume. The Ultra account is the coordinator; don't send builds there (waste of its no-cap advantage).

**Each Team Premium seat ($100)** — four in the example layout, same org
- 5× Pro per 5h; 5× Pro per week.
- Treat as **~50–225 prompts per 5h window** per seat.
- A ~10h workday = ~2 Opus-worth 5h windows + ~2 Haiku/Sonnet-worth windows per seat → **4 seats × 2 Opus windows × 100 Opus runs = ~800 Opus-medium or ~400 Opus-high runs per day**, *provided the ledger rotates seats before any one hits its window cap*.
- Haiku max cheap-model usage: a seat can easily do **200+ Haiku max runs per 5h window**. With 4 seats, > 1,500 Haiku runs/day realistic.

**Codex Pro ($100)**
- **No 5h limit**; weekly cap only.
- No published weekly number. Treat as infinite for review cadence (one panel = 3 Terra calls per merged diff, ~200K tokens) and generous for overflow builds. `codex exec --json` prints no `rate_limits` field (checked 2026-11-07); a usage-limit error becomes a `limit` row and a cooling mark in the ledger.

**Google AI Pro (49.99 EUR)**
- **1,500 requests/user/day** shared Antigravity + Gemini Code Assist.
- A review run is 1 request; a build run is many (plan + edits + reads + tests). Realistic: **~200 Argon review runs per day** or **~30 Argon medium builds per day** before cap.

**X Subscription (Grok)**
- Weekly pool, unpublished. Reserve as *last-line* overflow; don't plan capacity.

### An example workday, mapped to pools (illustrative)

Assume one day has these shapes:
- 3 planning/spec runs (Opus xhigh)
- 2 design debates (Opus xhigh + Astra xhigh in parallel)
- 6 real refactors (Opus medium)
- 4 hard debug/diff reviews (Opus high)
- 10 feature-frozen implementations (Sonnet high)
- 25 mechanical edits / bulk / extraction (Haiku max)
- 12 diff reviews (review panel: 2 Terra + 1 Argon + 1 Terra judge each)

Pool check:
- Ultra: 3 + 2 = **5 xhigh runs**. 5 × ~3 turns = 15 Opus-xhigh prompts. Easily inside Ultra's no-cap budget.
- 4 Team seats: 6 + 4 + 10 + 25 = **45 worker runs**. Spread evenly, each seat absorbs **~11 runs across its 5h windows**. Well below the 50–225 prompts/5h per seat.
- Codex Pro: 2 (Astra debate) + 12 × 3 (panel Terra calls) = 38 runs, no cap issue; add one Sol run per escalation.
- Google: 12 Argon panel reviews ≈ 12 requests/day of 1,500; watch the Argon weekly bucket in `agy -p /usage` (85% left after the smoke run).

That shape runs comfortably; a day **3× the above** would start to pressure one or two Team seats and would trigger rotation.

## Rotation rule (local ledger)

**File**: `.coord/model-routing/pool-ledger.tsv` (per-project, git-ignored), tab-separated, written by `scripts/pool-ledger.ts` (and by `dispatch.sh` through it):

```
ts            account   vendor   model   effort   run_id    tokens_in   tokens_out   cost_usd   verdict   note
```

- `account`: the configured team seats (e.g. `seat-a`…`seat-d`, see "Configure your seats"), `main` (Ultra; `mainAccount` in the config), `codex`, `google` (agy), `grok`. Non-Claude runs are logged the same way.
- `verdict`: `start` (launched), `done` / `error` / `limit` (from the run's output), `pass` / `fail` (the coordinator's judgment, a later row), `cooling` (account mark, `note` = `until=<ISO>`).
- Cost is filled only when the vendor reports it: Claude `total_cost_usd`, Grok if its JSON has a cost. Codex and agy rows carry tokens only.
- Older rows of the form `ts account vendor model effort run_id start|done [cost]` (an earlier per-project dispatcher) are read as-is.

```bash
L=scripts/pool-ledger.ts   # run with node --experimental-strip-types, or bun
$L next-seat                                   # LRU team seat that is not cooling and has < 20 starts in 5h
$L status                                      # per account: last_use, runs_5h, cost_5h, open, cooling_until
$L report [--days 7] [--json]                  # by account / vendor / vendor/model/effort: runs, cost, verdicts
$L verdict --run-id T43 --verdict pass|fail    # after you read the diff and ran the proof
$L cool --account seat-b --until 2026-11-07T14:00:00Z   # manual cooling mark
$L start|done ...                              # what dispatch.sh calls; `done --output <file>` parses tokens/cost/limits
```

A `done` with `limit` (usage-limit text, 429, `RESOURCE_EXHAUSTED`) appends a `cooling` row until the reported reset, else +5h (Claude) or +24h (Codex/Google/Grok). Window headroom is a heuristic: the ledger has no prompt counts, so a seat counts as full after `MODEL_ROUTING_MAX_RUNS_5H` (default 20) starts in the trailing 5h.

**Rule set**:
1. **Prefer the main Ultra for planning/judge only.** Never dispatch builds there — it wastes the no-cap value.
2. **Within the configured team seats, round-robin by least-recently-used, biased by remaining window.** The ledger keeps `last_use` and `last_window_start` per seat; `next_seat()` picks the one with the oldest `last_use` whose window has at least 30% headroom (using observed response `rate_limits` when available, else heuristic from prompt count in the window).
3. **Before dispatch, call `pools.canFit(lane, estimated_cost)`.** If the chosen seat would end the window above 80% utilization on this run, pick the next seat.
4. **On usage-limit response from Anthropic/OpenAI/Google**: mark the seat `coolingUntil = resetsAt`, increment skip count, move to the next seat/vendor in the escalation list. **Do not retry on the same pool.**
5. **Never rotate at the expense of planning/review quality.** If all Opus xhigh pools are cold (unlikely — Ultra has no 5h cap), queue the planning run; do not demote to Sonnet.
6. **Codex Pro and Google AI Pro are the overflow heads** for builds and reviews when the Team pool is tight. Grok is the *last* overflow.
7. **Audit nightly.** Dump the day's ledger grouped by account/model/effort, verdict rate, cost. The owner reviews it once/week; the router re-calibrates its `LANE_BY_KIND` defaults if a class consistently fails one rung.

## Headless dispatch

```bash
S=~/.claude/skills/model-routing
node --experimental-strip-types $S/route.ts brief.md --repo "$WT" > lane.json   # or: bun $S/route.ts ...
jq '{lane,account,reviewer:.reviewer.lane,reasons}' lane.json                     # read it before launching
$S/dispatch.sh lane.json --run-id T51            # --dry-run first if unsure
$S/scripts/watchdog-integration.sh "$REPO"       # run states (no .coord/watchdog.sh exists yet)
```

`dispatch.sh` refuses `coordinator_only` lanes, cooling accounts, unknown vendor/account pairs, and build lanes outside a linked git worktree (`--allow-main-checkout` overrides). It writes a `start` row, runs the lane under `nohup` in the background, and when the lane exits writes `<ledger dir>/runs/<run_id>/{out,err,exit}` plus a `done` row with tokens, cost and `error`/`limit`. For agy it also saves `/usage` before and after. A `review_panel` lane (vendor `panel`) runs `review-panel.sh` in the background instead; that script logs every call itself and leaves `final.md` in the same run dir. `dispatch.sh` does not create worktrees and does not run the review of a build: write the review brief, then run the lane's `review_command` with `REVIEW_BRIEF=<file> RUN_ID=<id>`.

Manual Claude worker (what `route.ts` emits for a team-seat build lane):

```bash
# Worker
ACC=seat-b                                  # routed by ledger
ORDER=$(mktemp -t order.XXXXXX)
cat >"$ORDER" <<'EOF'
Work only in <abs worktree>.
Goal:        <observable outcome>
Scope:       <paths>
Constraints: <don't touch X>
Non-goals:   <excluded>
Proof:       run <exact command>
Output:      <shape>
Escape:      if constraint blocks honest fix, stop and report.
EOF
cd <worktree> && CLAUDE_CONFIG_DIR="$HOME/.claude-$ACC" command claude -p \
  --model <lane.model> --effort <lane.effort> \
  --output-format json --permission-mode bypassPermissions \
  --disallowedTools 'Bash(git push:*)' 'Bash(gh:*)' 'Bash(git worktree:*)' 'Bash(pkill:*)' 'Bash(killall:*)' \
  --no-session-persistence --max-turns 120 \
  <"$ORDER" >/tmp/worker-$ACC-$$.json 2>/tmp/worker-$ACC-$$.log
```

`acceptEdits` only auto-approves file edits; in `-p` nothing can answer a Bash prompt, so the worker cannot run its proof. Build lanes therefore use `bypassPermissions` with a deny list, in a worktree only (as a production project's own dispatcher does). Review/plan lanes use `--permission-mode dontAsk --allowedTools Read Grep Glob 'Bash(git diff:*)' …`. Haiku lanes cap `--max-turns` at 30.

Verify:
- `jq '{is_error,num_turns,result:.result[-6000:],cost:.total_cost_usd,models:.modelUsage|keys,rate:.rate_limit_info}' /tmp/worker-$ACC-$$.json`
- Read `git diff` yourself, run the proof yourself.
- Append cost/verdict to `pool-ledger.tsv`.

Never `--permission-mode plan` with Haiku: silently runs Sonnet (~20× cost; verified 2026-10-14). Always check `modelUsage`.

## Files

Zero npm dependencies. TypeScript runs with `node --experimental-strip-types` (Node ≥ 22.6; tested on 26.13) or `bun` (tested 1.4.4); `package.json` only sets `"type": "module"`. `dispatch.sh` needs `jq`.

```
~/.claude/skills/model-routing/
├── SKILL.md                         # this file
├── package.json                     # {"type": "module"}, no dependencies
├── route.ts                         # <brief> → Jev → pickLane() → lane JSON on stdout
├── dispatch.sh                      # lane JSON → background headless run + ledger start/done rows
├── review-panel.sh                  # <brief> <repo> <run-id> → reviewers ∥ → judge → final.md, ledger row per call
├── reference-agy-cli.md             # verified agy 1.5.2 reference (flags, permissions, JSON, exit codes)
├── reference-third-party-skills.md  # survey of routing ideas in pstack / tstack / mattpocock skills
└── scripts/
    ├── config.ts                    # team seats, main account, seat config dir (env / ~/.config/model-routing/config.json)
    ├── lanes.ts                     # lane catalogue, rung-up/overflow/reviewer rules, command builders
    ├── router-fallback.ts           # regex classifier (Jev timeout/error/unsure kind), secret-value guard
    ├── panel.ts                     # review-panel.sh helpers: pick members, summarize a call, count verdicts
    ├── pool-ledger.ts               # ledger append/read, next-seat, cooling, status, report, output parsing
    └── watchdog-integration.sh      # execs <repo>/.coord/watchdog.sh if present, else lists run states
tests/                               # node --experimental-strip-types --test tests/  (or bun test tests/), offline
├── config.test.ts                   # seat config: env override, config file, defaults, validation
├── route.test.ts                    # unsure-risk regression, panel shapes, cross-vendor and cold-pool cases
├── panel.test.ts                    # verdict counting, Codex/agy output parsing, cost estimate
└── fixtures/                        # review-panel-brief.md (+ its live Jev answer), feature-brief.md
```

`route.ts` output: `{vendor, model, effort, account, reviewers, judge, escalation, review_command, command, reasons}` plus `lane`, `mode`, `source` (`jev` | `fallback` | `manual`), `repo`, `brief`, `ledger`, `session_id` (Grok only) and `judgment` (Jev probabilities, model, latency). `reviewers`/`judge`/`escalation` are the panel members (`{lane, vendor, model, effort, account, command}`); for a `review_panel` lane `command` runs the panel, for a build lane `review_command` does. Options: `--repo DIR`, `--ledger PATH`, `--log PATH | --no-log`, `--touches-secrets`, `--no-jev`, `--timeout-ms N`, `--builder claude|codex|agy|grok`.

## Common mistakes

| Mistake | Fix |
|---|---|
| Dispatching Opus to a sub-seat for planning | Use main Ultra; no 5h cap, keeps cache |
| Rotating seats mid-session without ledger | `pools.chooseAccountFor(lane)` once per dispatch |
| Ignoring `rate_limit_info` in worker JSON | Treat as authoritative; update ledger window headroom |
| Letting Codex build a diff and also review it | Codex built → panel is Opus high + Argon high, Opus high judge — never same-vendor |
| One Sol-high reviewer as the default diff review | `review-panel.sh`: 2× Terra high + Argon high → Terra judge. Sol high is the escalation rung only |
| Letting panel reviewers or the judge run tests | Read-only. Only the escalation lane (Sol high / Opus high prove) runs tests, with `--escalate`, in a worktree |
| Trusting raw reviewer findings | Act on the judge's CONFIRMED list; PLAUSIBLE needs escalation or your own proof; REJECTED is dropped |
| Expecting a cost from `codex exec --json` | It prints tokens only; `est_usd` in the ledger note is a list-price estimate |
| Falling back to keywords when only Jev's `risk` is unsure | Keep Jev's kind, treat risk as high (`route.ts` does this since 2026-11-07) |
| Downgrading planning when pool is tight | Queue instead; planning quality is load-bearing |
| Plan lane launched read-only (`dontAsk` + read allow list) | Plan writes its spec/docs into the repo: build permissions (deny push/gh/worktree). Only review/judge lanes are read-only. (plan lanes write)
| `max` on anything besides Sonnet Terminal-Bench ceiling | Stop at `xhigh` |
| Putting secrets in the Jev brief | `route.ts --touches-secrets`; coordinator handles |
| Skill files missing (`route.ts`, `dispatch.sh`, `scripts/*`) | Install them (restore the skill directory); don't hand-route |
| `agy -p -f <brief>` | There is no `-f`: `agy -p "$(cat <brief>)" ... </dev/null` |
| `read_file(<repo>/**)` in agy settings | Reads inside cwd need no rule; `<dir>/**` denies direct children. Use `read_file(<dir>)` or `--add-dir` |
| `grok -C <repo>` | `grok --cwd <repo>` (`-C` is rejected) |
| `codex exec -p <prompt>` | `-p` is `--profile`; pass the prompt as an argument or `-` + stdin |
| `--permission-mode acceptEdits` for a headless build | Bash is denied in `-p`; use `bypassPermissions` + deny list in a worktree |
| Treating agy exit 0 as success | Also check `status`, `denied_actions`, `finished_reason`, non-empty `response` |

## Sources

- Anthropic pricing: <https://claude.com/pricing> (Ultra $200, no 5h cap on verified; Max $100, 5× Pro; Team Premium $100/seat, 5× standard-seat). Checked 2026-11-06.
- OpenAI Codex pricing: <https://developers.openai.com/codex/pricing> → <https://learn.chatgpt.com/docs/pricing> ("Pro plans currently have no five-hour limit", $100/$200/$500 tiers). Checked 2026-11-06.
- Google AI Pro + Antigravity: <https://geminicli.com/docs/resources/quota-and-pricing/> ("Google AI Pro and AI Ultra... 1,500 and 2,000 requests per user per day"). Checked 2026-11-06.
- xAI Grok: X Subscription replaced SuperGrok 2026-10-12; one weekly pool across Grok+Cursor; no published counts.
- Artificial Analysis Intelligence Index v5.0.1 (27 oct 2026): <https://artificialanalysis.ai/models/claude-opus-5-5> (Opus 5.5 at max: 59 pts @ $10.04/task).
- CLI versions verified 2026-11-07: `claude` 2.1.319, `codex-cli` 0.167.0, `agy` 1.5.2, `grok` 1.0.78 (`gemini` 0.29.5 on 2026-11-06, not re-checked).
- Review panel evidence: tweet by Jinjing Liang on X, 2026-11-06 (anecdote, not reproduced; no link recorded); round-2 reviews in a production project, 2026-11-07 (our ledger); smoke panel run 2026-11-07 (scratch repo, deleted).
- TypeSafe / Jev: <https://docs.typesafe.ai/primitives.md>, <https://docs.typesafe.ai/confidence.md>, <https://docs.typesafe.ai/concepts/system-one.md>, <https://docs.typesafe.ai/api/system-one.md>, <https://docs.typesafe.ai/models.md>. Read 2026-11-07.
