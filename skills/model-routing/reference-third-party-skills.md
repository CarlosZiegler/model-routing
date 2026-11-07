# Skill scan — routing ideas and upstream changes

Date: 2026-11-06. The "routing-relevant" criterion comes from this skill's original draft (`SKILL.draft.md`): choosing model/effort/vendor, delegation to sub-accounts/sub-agents, fan-out, awareness of cost and pool limits (5h/weekly), a second opinion from another vendor, headless-CLI delegation, and gating by a typed classifier.

## 1. pstack (cursor/plugins) — commit `2776ddd2`

Subdirectory `pstack/skills/`. `poteto-mode` is the hub; principles live in `principle-*` (not listed below, since they are engineering principles, not routing).

| Skill | Routing-relevant? | What to do / borrow |
|---|---|---|
| `poteto-mode` | **Yes (very)** | Defines the "role → model/effort/speed" matrix and the rule "match the model to the job" (move up/down one rung; `max` only for the hardest; `fast` only when CI is red or someone is blocked). Family hierarchy (`claude-*` vs `grok-*`) + per-family fallback when Task rejects a slug. `inherit-parent`/`auto` as sentinels. Copy: (a) the roles and defaults table; (b) the per-family fallback algorithm; (c) the rule "diverse panel stays diverse"; (d) the discipline "fresh subagents by default" (don't summarize chains). |
| `setup-pstack` | **Yes** | Writes `~/.cursor/rules/pstack-models.mdc` with a budget (`unlimited`/`large`/`medium`/`small`) that becomes the effort token (`max`/`xhigh`/`high`/`medium`) for every role. Copy: the persistent config-file format + idempotence + the check "slug must be in the detected list". Equivalent to what this skill needs for an initial pool ledger. |
| `arena` | **Yes** | Fan-out of N candidates in parallel, cross-judge from another model family, base-pick + graft. Copy: (a) mandatory family separation between runner and judge (the basis of this skill's cross-vendor review); (b) the rule "if the judge rejects a slug, try the next one in the pool, only then skip"; (c) one worktree per candidate. |
| `swarm` | **Yes** | Fan-out of N workers, race/partition/mixed, `generalPurpose` + `environment:cloud` + `run_in_background:true`. Copy the brief shape (goal, scope, verify, PASS/ISSUES/BLOCKED) + the drop-out rule (continue with N-1). |
| `interrogate` | **Yes** | Multi-model adversarial review (`interrogate reviewers` line). "Finding survives only when a run proves it." Copy: the rule "no findings is a valid result" + a mandatory diverse family among reviewers. |
| `architect` | Partial | Uses `arena` with `architect runners`. Sketch-first pattern. Copy: the "design it twice" pattern via arena before implementing works as a `planning_spec` gate. |
| `reflect` | Partial | Spawns 3 parallel reviewers over the current transcript, via distinct roles (`reflect judgment`, `reflect tooling`, `reflect divergent, synthesizer`), different models per lens. Copy: the separate-synthesizer pattern + routing "accepted → create-skill, backlog → tracker". |
| `figure-it-out` | Partial | Bespoke playbook for work with no playbook. Calls `architect`/`arena`. Useful as a template for the `planning_spec` lane. |
| `how` / `why` / `teach` | Partial | Run `how explorer`/`how explainer`/`why investigators`/`why synthesizer` in separate roles — a blueprint for deciding `research_recent` vs `chat_qa`. |
| `benchmark-checklist` | No (but useful) | Vets a perf measurement. Worth adding as a prerequisite before reporting cost per lane in the ledger. |
| `recall` | No | Rebuilds context; does not route. |
| `correct` / `no-comments` / `unslop` / `technical-writing` / `typescript-best-practices` / `bro` / `ketchup`(-video) / `in-your-own-words` / `sharpen` / `tdd` / `show-me-your-work` / `statechart` / `make-bot-ui` / `create-verification-skill` / `maintain-verification-skill` / `create-formal-verification-skill` / `maintain-formal-verification-skill` / `blast-radius` / `automate-me` / `poteto-help` | No | Engineering product; no model-routing logic. |
| `principle-guard-the-context-window` | Partial | Says "route bulk to subagents"; conceptually supports rotating work so the coordinator's context does not fill up. |
| `principle-never-block-on-the-human` / `principle-encode-lessons-in-structure` / other principles | No | Execution/writing principles. |

**Key takeaway from pstack**: the trio `setup-pstack` (persistent rule file) + `poteto-mode` (role→model matrix) + `arena/swarm/interrogate` (fan-out with a judge from another family) is exactly the skeleton of "lane catalogue + rotation + cross-vendor reviewer" in the draft, just without the pools/5h-limits layer. Worth copying the config-file shape and the per-family fallbacks, and adding on top: (i) `pool-ledger.tsv`, (ii) `pools.canFit()`, (iii) consuming `rate_limit_info` from the `claude -p` JSON.

## 2. tstack (t3dotgg/tstack) — commit `1085050f`

The repository exists. 9 skills, a "less is more" model focused on the PR flow.

| Skill | Routing-relevant? | What to do / borrow |
|---|---|---|
| `council` | **Yes** | Delegated trio "latest flagship from each provider" (Claude Opus, GPT Sol, Gemini Pro), high reasoning, review rounds until consensus, with a scoreboard in the PR description. Copy: (a) the idea of an explicit "round" with a notes ledger per delegate; (b) "if 3 providers are not reachable, report it — never substitute"; (c) the table in the PR body ("Council review \| Round 1 \| Round 2"); (d) the anti-scope-creep rule. Maps directly onto this skill's cross-vendor review when risk is high. |
| `sol-loop` | **Yes** | Review loop by GPT Sol for up to 3 rounds (5 for security/auth/concurrency), a findings ledger (`id, severity, outcome, usage`), stop early if only nits. Copy: (a) an explicit budget per task type; (b) the id/severity/verdict ledger — virtually the shape wanted for `pool-ledger.tsv`; (c) the rule "never cancel and leave another parallel reviewer" (one reviewer per round). |
| `full-send` | **Yes** | End-to-end autonomy with an explicit "merge gate", uses `sol-loop` + `babysit-pr` + `file-pr`. Copy: (a) a clear definition of the grant (merge, force-with-lease, test methods) — a "run until done" mode needs something similar; (b) the merge-gate checklist. |
| `takeover` | Partial | Takes over another agent's PR; "do not defend an implementation". Copy: the rule of preserving authorship, importing commits into a new branch. Useful for "coordinator takes over" on the 3rd failure. |
| `babysit-pr` | Partial | Watches a PR; uses T3's `watch_pull_request` watcher. Copy: the watcher pattern to avoid sleep/polling; analogous to Monitor for a running lane. |
| `modernize` | No | Rebase/refresh. Does not route. |
| `file-pr` | No | PR filing. |
| `leaving-pr-comments` | No | Convention. |
| `full-stop` | No | Stops everything. (Useful as a kill switch in autonomous flows.) |

**Key takeaway from tstack**: `council` + `sol-loop` are practically the canonical implementation of this skill's "cross-vendor review". Copy the **findings-ledger format** (`id, severity, outcome, usage if returned`) and the rule **"different delegates from 3 providers in parallel, report verdicts only"** straight into `pool-ledger.tsv`. `full-send` brings the **"merge gate"** concept as the condition for finishing a lane — useful as the shape of a `lane.done_predicate` in `route.ts`.

## 3. mattpocock/skills — commit `4ae2317d`

Buckets: `engineering/` (promoted, 20 skills), `productivity/` (promoted, 7), `misc/` (4), `in-progress/` (8, including gems), `deprecated/` (empty). The installed plugin ships only promoted skills.

### `engineering/`

| Skill | Routing? | What to borrow |
|---|---|---|
| `code-review` | **Yes** | Two parallel sub-agents ("Standards" vs "Spec"), fresh contexts, foreground, three-dot diff. Findings are not merged — the axes stay separate. Copy: (a) the pattern of **two sub-agents on independent axes so context is not polluted** (very close to pstack's `interrogate`, simplified); (b) the Fowler smell baseline; (c) the rule "repo CODING_STANDARDS override the baseline"; (d) an explicit "fresh context window" for sub-agents in harnesses that fork by default (Codex). |
| `implement-spec` | **Yes** | Tickets as a **task graph** with a **frontier**, implementer subagents in parallel worktrees, a merger subagent, an integration branch, `tdd` on each ticket, `code-review` at the end. Copy: (a) frontier scheduling with maximum concurrency; (b) communication only through **context pointers** (spec/tickets/notes/commits) — avoids duplicating them in the brief; (c) a separate worktree per implementer (maps directly onto `separate-before-serializing-shared-state`); (d) an optional `exploration subagent` that saves notes outside the repo for later implementers to reuse. |
| `wayfinder` | Partial | A map of "decision tickets" when the work does not fit in one session. Useful as a shape for long-running `planning_spec`. |
| `triage` | Partial | External issues and PRs go through a triage state machine; agent-ready briefs. Useful brief format. |
| `pr` | No (model-invoked) | PR body shape. |
| `diagnosing-bugs` | No | Debug loop. |
| `codebase-design` / `domain-modeling` / `grill-with-docs` / `improve-codebase-architecture` / `prototype` / `research` / `tdd` / `to-spec` / `to-tickets` / `implement` / `retro` / `setup-matt-pocock-skills` / `ask-matt` / `wizard` | No | Engineering / product / UX. `ask-matt` is a router over these skills (not over models). |

### `productivity/`

| Skill | Routing? | What to borrow |
|---|---|---|
| `grilling` | Partial | Round + frontier loop with "ask whole frontier, wait, recompute". Useful as a shape for the classifier collecting signals from the brief (equivalent to Jev's parallel questions). |
| `handoff` | Partial | Compacts a conversation for another agent to resume. Shape for the "coordinator → worker brief". |
| `grill-me` / `teach` / `to-questionnaire` / `wait-what` / `writing-for-agents` | No | Do not route. |

### `in-progress/` (unshipped gems)

| Skill | Routing? | What to borrow |
|---|---|---|
| `chief-of-staff` | **Yes** | Long-session coordinator that pursues a goal via background subagents, with "two tracks" (tactical + strategic), a **wiki** as dated/commit-pinned historical memory, retros in ~1/5 of subagent sessions. Copy: (a) "all work in subagents, protect context" + "active dialog with the user in parallel"; (b) the wiki as a historical ledger (analogous to `pool-ledger.tsv`, but qualitative); (c) ingest/query/lint as the three wiki operations; (d) the rule "never 'currently' without a date/commit". Maps directly onto the role of the main-account coordinator. |
| `loop-me` | Partial | Grilling to define workflows; the Trigger/Checkpoint/Brief vocabulary is useful to formalize the work-order format sent to workers. |
| `software-factory` | **Yes** | Formal vocabulary for designing a "software factory": **Task / Trigger / Run / Runner / Orchestrator / Ticket tracker / Git host / Observability platform** + "three brakes" (automated checks, automated review, human review) + the rule "start slow, throttle new triggers" + "fill every slot" (a table of three designs). Copy almost wholesale: it is the canonical language for describing a multi-vendor system like this one. Specifically: "Runner" = sub-account seat, "Orchestrator" = `route.ts` + ledger, "Task" = lane class. |
| `claude-handoff` | Partial | Launches `claude --bg --name ... -- "$(cat <summary>)"` with a "suggested skills" section. Copy: (a) `--bg` + `--name` to label the background agent; (b) redacting before sending as a prompt. |
| `writing-beats` / `writing-fragments` / `writing-shape` / `setup-ts-deep-modules` | No | Writing / TS. |

### `misc/`

All non-routing: `git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`.

**Key takeaway from mattpocock**: three heavy items. (1) `code-review` with two sub-agents on **independent axes** — a clean, cheap pattern compared to `interrogate`. (2) `implement-spec` with **frontier scheduling + context pointers** is what the draft was missing to orchestrate multiple workers without inflating the brief. (3) `chief-of-staff` + `software-factory` provide the **vocabulary and stance of the main-account coordinator** — worth adopting the terms (`Task`, `Run`, `Runner`, `Orchestrator`, `Observability`) in the final `SKILL.md` to align with an emerging community standard.

## 4. Upstream changes vs installed (on the survey machine)

| Collection | Installed | Upstream | New/changed | Useful here? |
|---|---|---|---|---|
| pstack | `~/.cursor/plugins/cache/cursor-public/pstack/ae5650fe…` (unknown version, internal hash outside the public history) | `2776ddd2` | Same skill list by name (nothing added or dropped). Content differences not measured (internal SHA not in the public git). | No new skill. Worth re-syncing the SKILL.md versions to pick up prompt refinements. |
| tstack | **Not installed locally** (neither in `~/.cursor` nor in `~/.claude`) | `1085050f` | 9 skills entirely new to this environment. | **High.** `council`, `sol-loop`, `full-send` fill two gaps in the draft (reviewer ledger, merge gate, controlled autonomy). Install manually or adapt. |
| mattpocock/skills (promoted plugin) | **1.3.1** in `~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/` | 1.3.2 (HEAD `4ae2317d`) | 1.3.2 brings: `ask-matt` now reads the real `SKILL.md` before recommending; `chief-of-staff` gets a dated/commit-pinned wiki (**relevant**); `code-review` now looks for standards files + runs sub-agents in the foreground (**relevant**); `diagnosing-bugs` Phase 5 with "diff forced mutation vs pristine"; `grilling` wording "yes = accept recommendation"; `handoff` names `$TMPDIR`; `implement` calls the Skill tool correctly; `setup-matt-pocock-skills` fixes templates and creates labels; `tdd` notes "what each seam catches/misses"; `wayfinder` without `ready-for-agent`, no PRs from research branches; `wizard` several template fixes. Important new direction (PR #1341): **"start each subagent with a fresh context window"** applied to `implement-spec`, `code-review`, `codebase-design`, `improve-codebase-architecture`, `wayfinder`, `research`, `grilling`, `chief-of-staff`. | **Medium-high.** The "fresh context window" refinement is exactly what worker dispatch should state (equivalent to `--no-session-persistence` on `claude -p`). Also worth re-syncing for the new `code-review` and the revised `chief-of-staff`. `in-progress/` is outside the plugin, so `chief-of-staff` + `software-factory` + `claude-handoff` only come via a direct link to the repo. |

## 5. Routing/delegation in other installed collections

- **superpowers** (`7.0.2` in `~/.claude/plugins/cache/superpowers-marketplace/superpowers/`):
  - `dispatching-parallel-agents` — "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies." Equivalent to pstack's `swarm`, more generic.
  - `subagent-driven-development` — "Use when executing implementation plans with independent tasks in the current session." Equivalent to mattpocock's `implement-spec`, more generic.
  - `requesting-code-review` + `receiving-code-review` — the canonical pair of review cycles; useful as the protocol between the builder and the reviewer lane.
  - *None of them chooses model/effort explicitly — everything is a "subagent" with no vendor.*
- **karpathy-skills** (`andrej-karpathy-skills/1.0.0`):
  - `karpathy-guidelines` — behavioral guidelines (surgical changes, assumptions, success criteria). Does not route, but works as a standard brief for the Jev classifier to assess `risk`/`ambiguity`.
- **openai-codex** (`codex/1.0.4`):
  - `codex-cli-runtime` — "Internal helper contract for calling the codex-companion runtime from Claude Code." **Routing-adjacent**: exactly the layer needed to dispatch the Sol/Terra/Astra lanes from `route.ts`.
  - `gpt-5-4-prompting` — "Internal guidance for composing Codex and GPT-5.4 prompts for coding, review, diagnosis, and research tasks inside the Codex Claude Code plugin." Useful for formatting the work order sent to `codex exec`.
  - `codex-result-handling` — how to present Codex results to the user. A pattern for consuming the `codex exec` JSON.
  - *Note: it names GPT-5.4 models; this skill uses Sol/Terra/Astra (6.1/6) — reconfirm slugs with `codex --help`.*
- **understand-anything** (`2.7.5`): `understand`, `understand-onboard`, `understand-domain`, `understand-knowledge`, `understand-diff`, `understand-dashboard`, `understand-explain`, `understand-chat`. An onboarding product; none of them routes — they do not mention choosing model/effort/vendor.
- **claude-plugins-official** (marketplace): catalogue with `code-modernization`, `code-review`, `code-simplifier`, `feature-dev`, `frontend-design`, `pr-review-toolkit`, `ralph-loop`, `security-guidance`, `session-report`, `skill-creator`, `playground`, `plugin-dev`. None of these chooses model/effort explicitly; `ralph-loop` and `code-review` are review flows comparable to the ones above. `agent-sdk-dev` / `mcp-server-dev` are for building integrations, not routing.

## 6. Recommendation (5 lines)

- Install/adapt **tstack** (`council`, `sol-loop`, `full-send`): fills the draft's gaps for "cross-vendor review with a ledger" and the "merge gate"; adopt the `id, severity, outcome, usage` shape of the `sol-loop` ledger directly in `pool-ledger.tsv`.
- Upgrade mattpocock-skills 1.3.1 → 1.3.2 and pull the three gems **`chief-of-staff` + `software-factory` + `claude-handoff`** manually from `in-progress/`; adopt the Task/Run/Runner/Orchestrator vocabulary in the text of `SKILL.md`.
- Copy from pstack the **"family + slug fallback"** algorithm of `poteto-mode` and the persistent rule file of `setup-pstack` as a model for a `~/.claude/skills/model-routing/pstack-models.toml` (or equivalent) that defines role → model/effort/budget.
- Adopt the rule "fresh context window for every subagent" (from mattpocock PR #1341), aligned with the `--no-session-persistence` flag of `claude -p` already used in headless dispatch.
- The **Jev classifier** (typed System One) is unique — none of the three collections does this; worth keeping as a differentiator, only borrowing the **round ergonomics** of `grilling` (frontier + "yes accepts the recommendation") for the output of `route.ts`.

## Sources

- cursor/plugins @ `2776ddd2355d6d6c8747d3964600f28daf62f049` — https://github.com/cursor/plugins/tree/main/pstack
- t3dotgg/tstack @ `1085050f3baed1ac724caa4a8166145fb2ac88af` — https://github.com/t3dotgg/tstack
- mattpocock/skills @ `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` — https://github.com/mattpocock/skills
- pstack installed: `~/.cursor/plugins/cache/cursor-public/pstack/ae5650febf4320793844c12c4adaa937f417f8da/` (hash outside the public history, same skill list by name)
- mattpocock installed: `~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/` (upstream HEAD is 1.3.2)
- tstack: not installed locally
- superpowers @ `7.0.2` — `~/.claude/plugins/cache/superpowers-marketplace/superpowers/7.0.2/`
- karpathy-skills @ `1.0.0` — `~/.claude/plugins/cache/karpathy-skills/andrej-karpathy-skills/1.0.0/`
- openai-codex @ `1.0.4` — `~/.claude/plugins/cache/openai-codex/codex/1.0.4/`
- understand-anything @ `2.7.5` — `~/.claude/plugins/cache/understand-anything/understand-anything/2.7.5/`
