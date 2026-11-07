// Lane catalogue, per-class defaults and headless command builders.
// Shared by route.ts and scripts/router-fallback.ts. Zero dependencies.

export const KINDS = [
  "bulk_extraction",
  "mechanical_edit",
  "feature_frozen",
  "refactor_multifile",
  "debug_hard",
  "planning_spec",
  "review_frozen",
  "research_recent",
  "chat_qa",
] as const;
export type Kind = (typeof KINDS)[number];

import { fileURLToPath } from "node:url";
import { loadConfig, seatConfigDirShell, type RoutingConfig } from "./config.ts";

export type Vendor = "claude" | "codex" | "agy" | "grok" | "panel";
export type BuilderVendor = Exclude<Vendor, "panel">;
// team = one of the configured team seats (scripts/config.ts), each with its own CLAUDE_CONFIG_DIR;
// main = the main Claude account (default config dir, no CLAUDE_CONFIG_DIR);
// panel = composite lane run by review-panel.sh, each member placed on its own pool.
export type Pool = "team" | "main" | "codex" | "google" | "grok" | "coordinator" | "panel";
// review/judge are read-only; prove may run tests (escalation rung) but must not edit source.
export type Mode = "build" | "review" | "judge" | "prove" | "plan" | "bulk" | "chat";

export interface LaneSpec {
  vendor: Vendor;
  model: string;
  effort: string;
  pool: Pool;
  mode: Mode;
}

export const LANES = {
  haiku_medium: { vendor: "claude", model: "haiku", effort: "medium", pool: "team", mode: "chat" },
  haiku_max: { vendor: "claude", model: "haiku", effort: "max", pool: "team", mode: "build" },
  sonnet_high: { vendor: "claude", model: "sonnet", effort: "high", pool: "team", mode: "build" },
  sonnet_max: { vendor: "claude", model: "sonnet", effort: "max", pool: "team", mode: "build" },
  opus_medium: { vendor: "claude", model: "opus", effort: "medium", pool: "team", mode: "build" },
  opus_high: { vendor: "claude", model: "opus", effort: "high", pool: "team", mode: "build" },
  opus_high_review: { vendor: "claude", model: "opus", effort: "high", pool: "team", mode: "review" },
  opus_high_judge: { vendor: "claude", model: "opus", effort: "high", pool: "team", mode: "judge" },
  opus_high_prove: { vendor: "claude", model: "opus", effort: "high", pool: "team", mode: "prove" },
  opus_xhigh: { vendor: "claude", model: "opus", effort: "xhigh", pool: "main", mode: "plan" },
  sol_high_review: { vendor: "codex", model: "gpt-6.1-sol", effort: "high", pool: "codex", mode: "review" },
  sol_high_prove: { vendor: "codex", model: "gpt-6.1-sol", effort: "high", pool: "codex", mode: "prove" },
  sol_xhigh_review: { vendor: "codex", model: "gpt-6.1-sol", effort: "xhigh", pool: "codex", mode: "review" },
  astra_xhigh: { vendor: "codex", model: "gpt-6-astra", effort: "xhigh", pool: "codex", mode: "review" },
  sol_medium_build: { vendor: "codex", model: "gpt-6.1-sol", effort: "medium", pool: "codex", mode: "build" },
  terra_xhigh: { vendor: "codex", model: "gpt-6.1-terra", effort: "xhigh", pool: "codex", mode: "bulk" },
  terra_high_review: { vendor: "codex", model: "gpt-6.1-terra", effort: "high", pool: "codex", mode: "review" },
  terra_high_judge: { vendor: "codex", model: "gpt-6.1-terra", effort: "high", pool: "codex", mode: "judge" },
  argon_high_review: { vendor: "agy", model: "gemini-4-argon-high", effort: "high", pool: "google", mode: "review" },
  argon_medium_build: { vendor: "agy", model: "gemini-4-argon-medium", effort: "medium", pool: "google", mode: "build" },
  flash_bulk: { vendor: "agy", model: "gemini-3.8-flash-medium", effort: "medium", pool: "google", mode: "bulk" },
  grok_build: { vendor: "grok", model: "grok-4.7", effort: "high", pool: "grok", mode: "build" },
  // Members are chosen by pickPanel(); review-panel.sh runs them (reviewers in parallel, then the judge).
  review_panel: { vendor: "panel", model: "panel", effort: "high", pool: "panel", mode: "review" },
  coordinator_only: { vendor: "claude", model: "opus", effort: "xhigh", pool: "coordinator", mode: "plan" },
} as const satisfies Record<string, LaneSpec>;
export type LaneId = keyof typeof LANES;

// "Task classes → lane + reviewer" table in SKILL.md.
export const LANE_BY_KIND: Record<Kind, LaneId> = {
  bulk_extraction: "haiku_max",
  mechanical_edit: "haiku_max",
  feature_frozen: "sonnet_high",
  refactor_multifile: "opus_medium",
  debug_hard: "opus_high",
  planning_spec: "opus_xhigh",
  review_frozen: "review_panel",
  research_recent: "astra_xhigh",
  chat_qa: "haiku_medium",
};

// Class-specific "Rung-up" column, applied to the class's default lane.
const RUNG_UP_BY_KIND: Record<Kind, LaneId> = {
  bulk_extraction: "terra_xhigh",
  mechanical_edit: "sonnet_high",
  feature_frozen: "opus_medium",
  refactor_multifile: "opus_high",
  debug_hard: "sonnet_max",
  planning_spec: "opus_xhigh", // rung-up is a debate with Astra/Argon, not another lane
  review_frozen: "review_panel", // the panel is the top review rung; Sol high (escalation) proves disputed findings
  research_recent: "argon_high_review",
  chat_qa: "haiku_max",
};

// Generic ladder for a second bump. Build lanes cap at opus_high: Ultra is not
// for builds, and the next step after that is a coordinator takeover on failure.
const GENERIC_RUNG_UP: Record<LaneId, LaneId> = {
  haiku_medium: "haiku_max",
  haiku_max: "sonnet_high",
  sonnet_high: "opus_medium",
  sonnet_max: "sonnet_max",
  opus_medium: "opus_high",
  opus_high: "opus_high",
  opus_high_review: "opus_high_review",
  opus_high_judge: "opus_high_judge",
  opus_high_prove: "opus_high_prove",
  opus_xhigh: "opus_xhigh",
  sol_high_review: "argon_high_review",
  sol_high_prove: "sol_high_prove",
  sol_xhigh_review: "sol_xhigh_review",
  astra_xhigh: "argon_high_review",
  sol_medium_build: "opus_medium",
  terra_xhigh: "terra_xhigh",
  terra_high_review: "terra_high_review",
  terra_high_judge: "terra_high_judge",
  argon_high_review: "argon_high_review",
  argon_medium_build: "opus_medium",
  flash_bulk: "terra_xhigh",
  grok_build: "opus_medium",
  review_panel: "review_panel",
  coordinator_only: "coordinator_only",
};

export function oneRungUp(lane: LaneId, kind: Kind | null): LaneId {
  if (kind && lane === LANE_BY_KIND[kind]) return RUNG_UP_BY_KIND[kind];
  return GENERIC_RUNG_UP[lane];
}

// Overflow when the primary pool has no account. Build/bulk may move down or
// sideways; planning/review only move to another vendor at the same rung.
const OVERFLOW: Record<LaneId, LaneId[]> = {
  haiku_medium: ["flash_bulk", "terra_xhigh"],
  haiku_max: ["terra_xhigh", "flash_bulk", "sol_medium_build"],
  sonnet_high: ["sol_medium_build", "argon_medium_build", "grok_build"],
  sonnet_max: ["sol_medium_build", "argon_medium_build", "grok_build"],
  opus_medium: ["sol_medium_build", "argon_medium_build", "grok_build"],
  opus_high: ["sol_medium_build", "argon_medium_build", "grok_build"],
  opus_high_review: ["argon_high_review", "sol_high_review"],
  opus_high_judge: ["terra_high_judge"],
  opus_high_prove: ["sol_high_prove"],
  opus_xhigh: ["astra_xhigh"],
  sol_high_review: ["argon_high_review"],
  sol_high_prove: ["opus_high_prove"],
  sol_xhigh_review: ["argon_high_review"],
  astra_xhigh: ["argon_high_review"],
  sol_medium_build: ["argon_medium_build", "grok_build"],
  terra_xhigh: ["flash_bulk"],
  terra_high_review: ["argon_high_review", "opus_high_review"],
  terra_high_judge: ["opus_high_judge"],
  argon_high_review: ["sol_high_review"],
  argon_medium_build: ["sol_medium_build", "grok_build"],
  flash_bulk: ["terra_xhigh"],
  grok_build: [],
  review_panel: [], // members substitute one by one in pickPanel()
  coordinator_only: [],
};

// Class default when no review panel is attached.
export const CLASS_CHECK: Record<Kind, string> = {
  bulk_extraction: "script count (no model)",
  mechanical_edit: "coordinator reads the diff",
  feature_frozen: "review panel",
  refactor_multifile: "review panel",
  debug_hard: "review panel",
  planning_spec: "Sol xhigh spec-gate + Argon high, coordinator judges",
  review_frozen: "n/a (this lane is the review panel)",
  research_recent: "coordinator checks citations",
  chat_qa: "coordinator",
};

// Classes whose own check is a review panel get one even when Jev's cross_vendor_review p <= 0.5
// (the panel replaces the old single "Sol diff-gate"/"Sol spec-gate" default).
export const PANEL_BY_DEFAULT: Record<Kind, boolean> = {
  bulk_extraction: false,
  mechanical_edit: false,
  feature_frozen: true,
  refactor_multifile: true,
  debug_hard: true,
  planning_spec: true,
  review_frozen: true,
  research_recent: false,
  chat_qa: false,
};

export interface PoolStatus {
  chooseAccountFor(lane: LaneId): string | null;
}

export interface Reviewer {
  lane: LaneId;
  vendor: Vendor;
  model: string;
  effort: string;
  account: string | null;
  command: string | null; // reads its brief from $REVIEW_BRIEF (review-panel.sh writes one per role)
}

// A review panel: independent read-only reviewers in parallel, then a judge that makes their
// findings debate, dedupes, verifies each against the code and labels it CONFIRMED / PLAUSIBLE /
// REJECTED. The escalation lane (may run tests) is used only for findings the judge marks
// "dispute" or "needs-test". Evidence and re-evaluation rule: SKILL.md "Review panel".
export interface Panel {
  builder: BuilderVendor | null; // vendor that wrote the diff under review (null = unknown)
  reviewers: Reviewer[];
  judge: Reviewer | null; // null → the coordinator judges
  escalation: Reviewer | null;
  command: string; // review-panel.sh invocation
  reasons: string[];
}

export interface Lane {
  id: LaneId;
  account: string;
  panel: Panel | null;
  reasons: string[];
}

interface PanelSpec {
  reviewers: LaneId[];
  judge: LaneId | null;
  escalation: LaneId | null;
}

// Default: 2× Terra high (Codex) + Argon high (third vendor for diversity), Terra high judge, Sol high escalation.
const DEFAULT_PANEL: PanelSpec = {
  reviewers: ["terra_high_review", "terra_high_review", "argon_high_review"],
  judge: "terra_high_judge",
  escalation: "sol_high_prove",
};

// Cross-vendor: no panel member comes from the builder's vendor.
export const PANEL_BY_BUILDER: Record<BuilderVendor | "none", PanelSpec> = {
  none: DEFAULT_PANEL,
  claude: DEFAULT_PANEL,
  grok: DEFAULT_PANEL,
  codex: { reviewers: ["opus_high_review", "argon_high_review"], judge: "opus_high_judge", escalation: "opus_high_prove" },
  agy: { reviewers: ["terra_high_review", "terra_high_review", "opus_high_review"], judge: "terra_high_judge", escalation: "sol_high_prove" },
};

// Specs keep their two-vendor spec-gate; the coordinator (Opus xhigh, Ultra) is the judge.
const PLANNING_PANEL: PanelSpec = { reviewers: ["sol_xhigh_review", "argon_high_review"], judge: null, escalation: null };

// Same-rung substitutes when a member's pool has no free account (filtered by the builder vendor).
const PANEL_SUBSTITUTES: Partial<Record<LaneId, LaneId[]>> = {
  terra_high_review: ["argon_high_review", "opus_high_review"],
  argon_high_review: ["terra_high_review", "opus_high_review"],
  opus_high_review: ["argon_high_review", "terra_high_review"],
  sol_xhigh_review: ["argon_high_review"],
  terra_high_judge: ["opus_high_judge"],
  opus_high_judge: ["terra_high_judge"],
  sol_high_prove: ["opus_high_prove"],
  opus_high_prove: ["sol_high_prove"],
};

export const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
export const PANEL_SCRIPT = `${SKILL_DIR}/review-panel.sh`;

export function panelCommand(ctx: CommandContext, builder: BuilderVendor | null, runIdSuffix = ""): string {
  return (
    `${q(PANEL_SCRIPT)} ${q(ctx.brief)} ${q(ctx.repo)} "\${RUN_ID:?set RUN_ID}${runIdSuffix}"` +
    (builder ? ` --builder ${builder}` : "")
  );
}

export function pickPanel(
  builder: BuilderVendor | null,
  pools: PoolStatus,
  ctx: CommandContext,
  opts: { planning?: boolean; runIdSuffix?: string } = {},
): Panel {
  const reasons: string[] = [];
  const spec = opts.planning ? PLANNING_PANEL : PANEL_BY_BUILDER[builder ?? "none"];
  const memberCtx = { ...ctx, brief: "$REVIEW_BRIEF" };
  const place = (id: LaneId, role: string): Reviewer | null => {
    for (const cand of [id, ...(PANEL_SUBSTITUTES[id] ?? [])]) {
      if (builder && LANES[cand].vendor === builder) continue;
      const account = pools.chooseAccountFor(cand);
      if (!account) continue;
      if (cand !== id) reasons.push(`${role}: no free account for ${id} → ${cand}`);
      const s = LANES[cand];
      return { lane: cand, vendor: s.vendor, model: s.model, effort: s.effort, account, command: buildCommand(cand, account, memberCtx) };
    }
    reasons.push(`${role}: no cross-vendor pool can take ${id}; left out (no silent downgrade)`);
    return null;
  };
  const reviewers = spec.reviewers.map((id, i) => place(id, `reviewer ${i + 1}`)).filter((r): r is Reviewer => r !== null);
  const judge = spec.judge ? place(spec.judge, "judge") : null;
  if (!spec.judge) reasons.push("judge: the coordinator (Opus xhigh, Ultra) settles the findings");
  const escalation = spec.escalation ? place(spec.escalation, "escalation") : null;
  if (reviewers.length && new Set(reviewers.map((r) => r.vendor)).size < 2) {
    reasons.push(`panel has one vendor only (${reviewers[0].vendor}); diversity lost, say so in the review`);
  }
  if (!reviewers.length) reasons.push("no reviewer could be placed; queue the review for the coordinator");
  return { builder, reviewers, judge, escalation, command: panelCommand(ctx, builder, opts.runIdSuffix), reasons };
}

// Review attached to a build/plan lane: a panel whose members avoid the builder's vendor.
export function reviewPanelFor(lane: LaneId, pools: PoolStatus, ctx: CommandContext): Panel | null {
  const spec = LANES[lane];
  if (lane === "coordinator_only" || spec.vendor === "panel") return null;
  if (spec.mode === "review" || spec.mode === "judge" || spec.mode === "prove") return null;
  const reviewCtx = { ...ctx, brief: "$REVIEW_BRIEF" };
  if (lane === "opus_xhigh") return pickPanel("claude", pools, reviewCtx, { planning: true, runIdSuffix: "-review" });
  return pickPanel(spec.vendor, pools, reviewCtx, { runIdSuffix: "-review" });
}

// Step 6 of pickLane(): pools.chooseAccountFor(lane) ?? overflowSibling(lane, pools).
export function placeLane(lane: LaneId, pools: PoolStatus, reasons: string[]): { id: LaneId; account: string } {
  if (lane === "coordinator_only") return { id: lane, account: "coordinator" };
  if (lane === "review_panel") return { id: lane, account: "panel" }; // members are placed by pickPanel()
  const account = pools.chooseAccountFor(lane);
  if (account) return { id: lane, account };
  for (const sibling of OVERFLOW[lane]) {
    const acc = pools.chooseAccountFor(sibling);
    if (acc) {
      reasons.push(`pool for ${lane} has no free account; overflow to ${sibling}`);
      return { id: sibling, account: acc };
    }
  }
  reasons.push(`no pool can take ${lane}; queue it for the coordinator (no silent downgrade)`);
  return { id: "coordinator_only", account: "coordinator" };
}

// API list prices, USD per MTok (Lane catalogue). Only for est_usd in panel logs: Codex prints no cost.
export const LIST_PRICE: Record<string, { in: number; out: number }> = {
  "gpt-6.1-terra": { in: 1, out: 5 },
  "gpt-6.1-sol": { in: 2, out: 10 },
  "gpt-6-astra": { in: 10, out: 50 },
};
// Assumption, unverified for GPT-6.1: cached input billed at 10% (OpenAI convention).
export const CACHED_INPUT_FACTOR = 0.1;

// ---- Headless commands ------------------------------------------------------

export interface CommandContext {
  repo: string;
  brief: string; // path, or the literal "$REVIEW_BRIEF" for reviewer templates
  sessionId: string; // fresh UUID for grok
}

export function q(s: string): string {
  if (s === "$REVIEW_BRIEF") return '"$REVIEW_BRIEF"';
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const MAX_TURNS: Record<Mode, number> = { chat: 10, bulk: 30, build: 120, review: 40, judge: 60, prove: 80, plan: 120 };

const CLAUDE_BUILD_DENY = [
  "Bash(git push:*)",
  "Bash(gh:*)",
  "Bash(git worktree:*)",
  "Bash(pkill:*)",
  "Bash(killall:*)",
];
// Escalation (prove) may run tests but must not edit source or move git state.
const CLAUDE_PROVE_DENY = [
  ...CLAUDE_BUILD_DENY,
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(git commit:*)",
  "Bash(git checkout:*)",
  "Bash(git reset:*)",
  "Bash(git stash:*)",
  "Bash(rm:*)",
];
const CLAUDE_READ_ONLY_ALLOW = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
];

// Verified allow list from reference-agy-cli.md section 1A (reads inside cwd need no rule).
const AGY_REVIEW_ALLOW = [
  "git diff", "git log", "git show", "git status", "git grep", "git ls-files",
  "rg", "grep", "ls", "cat", "head", "tail", "sed -n", "wc", "find", "jq",
];
const AGY_BUILD_ALLOW = ["git status", "git diff", "git add", "git commit"];

function agySettings(commands: string[]): string {
  return JSON.stringify({ permissions: { allow: commands.map((c) => `command(${c})`) } });
}

function agyPreamble(commands: string[], mode: Mode): string {
  const base =
    mode === "build"
      ? "Edit files only inside the current directory."
      : "Answer directly in chat. Do not write a plan document.";
  const shell = commands.length
    ? `Only these shell commands are allowed: ${commands.join(", ")}; any other command ends your run.`
    : "Do not run shell commands; any command ends your run.";
  return `${base} Read files with your file-read tool. ${shell}`;
}

export function buildCommand(id: LaneId, account: string, ctx: CommandContext, cfg: RoutingConfig = loadConfig()): string | null {
  const spec = LANES[id];
  const repo = q(ctx.repo);
  const brief = q(ctx.brief);
  const turns = spec.model === "haiku" ? Math.min(30, MAX_TURNS[spec.mode]) : MAX_TURNS[spec.mode];
  switch (spec.vendor) {
    case "claude": {
      if (spec.pool === "coordinator") return null;
      const env =
        account === cfg.mainAccount ? "env -u CLAUDE_CONFIG_DIR" : `CLAUDE_CONFIG_DIR=${seatConfigDirShell(account, cfg)}`;
      const perms =
        // "plan" writes its plan/spec/docs into the repo, so it gets build permissions (still no push,
        // no gh, no worktree surgery). Read-only "plan" cost $8.51 on 2026-11-07 for a run that could
        // not write a single file. Reviews and judges stay read-only.
        spec.mode === "build" || spec.mode === "bulk" || spec.mode === "plan"
          ? `--permission-mode bypassPermissions --disallowedTools ${CLAUDE_BUILD_DENY.map(q).join(" ")}`
          : spec.mode === "prove"
            ? `--permission-mode bypassPermissions --disallowedTools ${CLAUDE_PROVE_DENY.map(q).join(" ")}`
            : `--permission-mode dontAsk --allowedTools ${CLAUDE_READ_ONLY_ALLOW.map(q).join(" ")}`;
      return (
        `cd ${repo} && ${env} command claude -p --model ${spec.model} --effort ${spec.effort} ` +
        `--output-format json ${perms} --no-session-persistence --max-turns ${turns} < ${brief}`
      );
    }
    case "codex": {
      // prove: workspace-write so tests can write caches; the brief forbids source edits.
      const sandbox =
        spec.mode === "build"
          ? "--dangerously-bypass-approvals-and-sandbox"
          : spec.mode === "prove"
            ? "--sandbox workspace-write"
            : "--sandbox read-only";
      return (
        `cd ${repo} && CODEX_HOME="$HOME/.codex" command codex exec -m ${spec.model} ` +
        `-c model_reasoning_effort=${spec.effort} ${sandbox} -C ${repo} --json - < ${brief}`
      );
    }
    case "agy": {
      const commands = spec.mode === "build" ? AGY_BUILD_ALLOW : spec.mode === "bulk" ? [] : AGY_REVIEW_ALLOW;
      const mode = spec.mode === "build" ? "accept-edits" : "plan";
      const timeout = spec.mode === "build" ? "45m" : spec.mode === "bulk" ? "10m" : "30m";
      const settings = commands.length ? ` --settings ${q(agySettings(commands))}` : "";
      const prompt = `"$(printf '%s\\n\\n' ${q(agyPreamble(commands, spec.mode))}; cat ${brief})"`;
      return (
        `cd ${repo} && agy -p ${prompt} --model ${spec.model} --mode ${mode}${settings} ` +
        `--output-format json --print-timeout ${timeout} </dev/null`
      );
    }
    case "panel":
      return panelCommand(ctx, null);
    case "grok":
      // No --model pin: the CLI default is the newest model (grok-first skill).
      return (
        `cd ${repo} && command grok --no-auto-update --cwd ${repo} --session-id ${ctx.sessionId} ` +
        `--no-memory --verbatim --reasoning-effort ${spec.effort} --max-turns 80 --always-approve ` +
        `--output-format json --prompt-file ${brief} </dev/null`
      );
  }
}
