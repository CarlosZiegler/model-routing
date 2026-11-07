#!/usr/bin/env -S node --experimental-strip-types
// route.ts <brief-file> — asks TypeSafe Jev the "Jev loop" questions, applies pickLane(),
// prints the lane JSON. Jev timeout (2s), error or low `kind` confidence → scripts/router-fallback.ts.
// Low confidence in `risk` alone keeps Jev's kind and treats risk as high (conservative bump).
//
// Options:
//   --repo DIR          worktree the lane runs in (default: cwd)
//   --ledger PATH       pool ledger (default: $POOL_LEDGER, else nearest .coord/model-routing/pool-ledger.tsv)
//   --log PATH          router log JSONL (default: router-log.jsonl next to the ledger); --no-log disables
//   --touches-secrets   mark the brief as secret by hand → coordinator only, Jev is not called
//   --no-jev            skip Jev, use the fallback classifier
//   --timeout-ms N      Jev timeout (default 2000)
//   --builder VENDOR    review briefs: vendor that wrote the diff (claude|codex|agy|grok); the panel avoids it
//
// The API key is read from ~/.config/typesafe/key ($TYPESAFE_KEY_FILE overrides) and never printed.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CLASS_CHECK, KINDS, LANE_BY_KIND, LANES, PANEL_BY_DEFAULT, buildCommand, oneRungUp, pickPanel, placeLane, reviewPanelFor,
  type BuilderVendor, type CommandContext, type Kind, type Lane, type LaneId, type Panel, type PoolStatus,
} from "./scripts/lanes.ts";
import { findLedger, loadPools } from "./scripts/pool-ledger.ts";
import { classifyFallback, containsSecretValue, fallbackBaseLane } from "./scripts/router-fallback.ts";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const MAX_BRIEF_CHARS = 60_000; // Jev default context: 32k tokens per question
// Confidence floor: below it in `kind` → fallback; below it in `risk` → keep kind, treat risk as high.
export const CONFIDENCE_FLOOR = 0.4;

// ---- Jev questions (SKILL.md "Jev loop") ---------------------------------------------

const CTX_LEVELS = ["tiny", "small", "mid", "large", "xl"] as const;
const STEP_LEVELS = ["1", "2-5", "6-20", ">20"] as const;

const KIND_CRITERIA: Record<Kind, string> = {
  bulk_extraction: "Bulk, repetitive extraction, triage or listing over many items with a simple, countable output and little judgment per item.",
  mechanical_edit: "A small mechanical edit whose content is already fully specified: a typo, docs wording, a rename, a config value, a version bump, formatting.",
  feature_frozen: "Implement a feature or fix from a frozen, clear spec that touches one or two files.",
  refactor_multifile: "Restructure or change existing code across several files or modules.",
  debug_hard: "Diagnose a hard bug, flaky test, crash or production issue whose cause is not known yet.",
  planning_spec: "Write or design a spec, plan, architecture or decision before any implementation.",
  review_frozen: "Review an existing diff, pull request, spec or document against a frozen standard and report findings, without implementing anything.",
  research_recent: "Research recent public facts, releases, prices or documentation and report them with citations.",
  chat_qa: "Answer a short question or explain something, with no code or file changes.",
};

const ABOUT = "`brief` is a work order that a coordinator wrote for an AI coding agent.";

const QUESTIONS = {
  kind: {
    type: "choice",
    instructions: `${ABOUT} Which class of work is the task in \`brief\`?`,
    criteria: KIND_CRITERIA,
  },
  risk: {
    type: "noul",
    instructions: `${ABOUT} Does the task change infrastructure, security, a database schema (migration), or production code without a clear reproduction?`,
  },
  ctx_size: {
    type: "score",
    instructions: `${ABOUT} How much code, documentation or logs will the agent need to read to do the task?`,
    criteria: [
      "tiny: under 1K tokens, a few lines or one small file",
      "small: 1K to 10K tokens, a few files",
      "mid: 10K to 50K tokens, a module or about a dozen files",
      "large: 50K to 200K tokens, a large part of a codebase or long documents",
      "xl: over 200K tokens, a whole large codebase or huge logs",
    ],
  },
  needs_recent_facts: {
    type: "noul",
    instructions: `${ABOUT} Does the task need public facts that changed in the last 60 days, such as new releases, prices, docs or news?`,
  },
  cross_vendor_review_recommended: {
    type: "noul",
    instructions: `${ABOUT} Does the resulting change deserve an independent review by a reviewer from a different AI vendor, because it has non-trivial logic, security, data or user-facing impact?`,
  },
  estimated_steps: {
    type: "score",
    instructions: `${ABOUT} How many agent steps (tool calls, edits, test runs) will the task take?`,
    criteria: ["1 step: a single edit or answer", "2 to 5 steps", "6 to 20 steps", "more than 20 steps"],
  },
  touches_secrets: {
    type: "noul",
    instructions: `${ABOUT} Does the brief contain a secret value, or ask the worker to read, create, rotate, copy or send a secret (.env contents, API keys, tokens, passwords, credentials, private keys)? Rules that only forbid printing or committing secrets, or code that reads a key file at runtime without showing it, do not count.`,
  },
} as const;

// ---- judgment types ---------------------------------------------------------------

interface ChoiceJ { top: Kind; confidence: number; probabilities: Record<string, number> }
interface NoulJ { p: number }
interface ScoreJ { top: string; score: number; confidence: number }
export interface JevJudgment {
  kind: ChoiceJ;
  risk: NoulJ;
  ctx_size: ScoreJ;
  needs_recent_facts: NoulJ;
  cross_vendor_review_recommended: NoulJ;
  estimated_steps: ScoreJ;
  touches_secrets: NoulJ;
}

// Noul has no confidence field; docs.typesafe.ai/confidence.md: |2p - 1|.
export const noulConfidence = (p: number): number => Math.abs(2 * p - 1);

function scoreTop(answer: any, names: readonly string[]): ScoreJ {
  const probs: Record<string, number> = answer.probabilities ?? {};
  let best = 0;
  for (const [k, v] of Object.entries(probs)) if (v > (probs[String(best)] ?? -1)) best = Number(k);
  return { top: names[best] ?? String(best), score: answer.score, confidence: answer.confidence };
}

function toJudgment(answers: any): JevJudgment {
  const kind = answers?.kind;
  if (!kind || !KINDS.includes(kind.choice)) throw new Error(`unexpected Jev answer for kind: ${JSON.stringify(kind)?.slice(0, 120)}`);
  const noul = (id: string): NoulJ => {
    const p = answers?.[id]?.noul;
    if (typeof p !== "number") throw new Error(`missing Noul answer ${id}`);
    return { p };
  };
  return {
    kind: { top: kind.choice, confidence: kind.confidence, probabilities: kind.probabilities },
    risk: noul("risk"),
    ctx_size: scoreTop(answers.ctx_size, CTX_LEVELS),
    needs_recent_facts: noul("needs_recent_facts"),
    cross_vendor_review_recommended: noul("cross_vendor_review_recommended"),
    estimated_steps: scoreTop(answers.estimated_steps, STEP_LEVELS),
    touches_secrets: noul("touches_secrets"),
  };
}

// ---- Jev call ----------------------------------------------------------------------

function readApiKey(): string {
  const path = process.env.TYPESAFE_KEY_FILE ?? join(homedir(), ".config", "typesafe", "key");
  const raw = readFileSync(path, "utf8").trim();
  const m = /^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\s]+)/m.exec(raw);
  const key = m ? m[1] : raw.split(/\s+/)[0];
  if (!key) throw new Error(`no API key in ${path}`);
  return key;
}

class JevError extends Error {}

async function askJev(brief: string, timeoutMs: number): Promise<{ judgment: JevJudgment; ms: number; model: string; usage: unknown }> {
  let key: string;
  try {
    key = readApiKey();
  } catch (e) {
    throw new JevError(`cannot read API key: ${(e as Error).message.replace(/\S{40,}/g, "<redacted>")}`);
  }
  const redact = (s: string) => s.split(key).join("<redacted>");
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state: { brief }, questions: QUESTIONS }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new JevError(`timeout after ${timeoutMs} ms`);
    throw new JevError(redact(`network error: ${err.message}${(err as any).cause ? ` (${(err as any).cause.code ?? (err as any).cause.message})` : ""}`));
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new JevError(redact(`HTTP ${res.status}: ${text.slice(0, 300)}`));
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new JevError("response is not JSON");
  }
  try {
    return { judgment: toJudgment(body.answers), ms: Date.now() - started, model: body.model, usage: body.usage };
  } catch (e) {
    throw new JevError(redact((e as Error).message));
  }
}

// ---- pickLane (SKILL.md, applied as written) ---------------------------------------------

export interface PickOptions {
  riskUnsure?: boolean; // |2p-1| of risk below the floor → treat risk as high
  builder?: BuilderVendor | null; // review briefs: who wrote the diff under review
}

export function pickLane(j: JevJudgment, pools: PoolStatus, ctx: CommandContext, opts: PickOptions = {}): Lane {
  const SECRETS_P = 0.5;
  const reasons: string[] = [];
  const pct = (n: number) => n.toFixed(2);

  // 1. Secrets guard — never route a brief with secrets to a worker.
  // 0.5, not 0.2: at 0.2 Jev flagged briefs that merely say "no secrets in output" (p=0.41, 2026-11-07).
  // Literal secret values are caught earlier by the regex guard, before Jev is called.
  if (j.touches_secrets.p > SECRETS_P) {
    reasons.push(`touches_secrets p=${pct(j.touches_secrets.p)} > ${SECRETS_P} → coordinator only (Jev kind=${j.kind.top}, confidence ${pct(j.kind.confidence)})`);
    return { id: "coordinator_only", account: "coordinator", panel: null, reasons };
  }

  // 2. Base lane from kind
  const kind = j.kind.top;
  let lane: LaneId = LANE_BY_KIND[kind];
  reasons.push(`kind=${kind} (confidence ${pct(j.kind.confidence)}) → ${lane}`);

  // 3. Risk bump. An unsure risk answer does not discard a confident kind: treat risk as high.
  if (j.risk.p > 0.6 || opts.riskUnsure) {
    const up = oneRungUp(lane, kind);
    const why = j.risk.p > 0.6
      ? `risk p=${pct(j.risk.p)} > 0.6`
      : `risk unsure (p=${pct(j.risk.p)}, |2p-1|=${pct(noulConfidence(j.risk.p))} < ${CONFIDENCE_FLOOR}) → treated as high`;
    reasons.push(`${why} → rung up ${lane} → ${up}`);
    lane = up;
  }

  // 4. Ambiguity bump (Choice confidence low)
  if (j.kind.confidence < 0.55) {
    const up = oneRungUp(lane, kind);
    reasons.push(`kind confidence ${pct(j.kind.confidence)} < 0.55 → rung up ${lane} → ${up}`);
    lane = up;
  }

  // 5. Context guard: Haiku is cliff > 100K
  if (j.ctx_size.top === "large" && lane === "haiku_max") {
    reasons.push("ctx_size=large on haiku_max → sonnet_high");
    lane = "sonnet_high";
  }
  if (j.ctx_size.top === "xl" && lane === "review_panel") {
    reasons.push("ctx_size=xl on review_panel → panel kept; split the diff if a reviewer reports truncation");
  } else if (j.ctx_size.top === "xl" && lane !== "opus_xhigh") {
    const target: LaneId = LANES[lane].mode === "review" ? "opus_high_review" : "opus_high";
    reasons.push(`ctx_size=xl → ${target}`);
    lane = target;
  }

  // 6. Pool capacity guard
  const placed = placeLane(lane, pools, reasons);

  // 7. Review panel: the lane itself for review_frozen; attached to builds when the class
  //    check is a panel (PANEL_BY_DEFAULT) or Jev recommends a cross-vendor review.
  const xv = j.cross_vendor_review_recommended.p;
  let panel: Panel | null = null;
  if (placed.id === "review_panel") {
    panel = pickPanel(opts.builder ?? null, pools, ctx);
    reasons.push(`review_panel: ${describePanel(panel)}`);
  } else if (xv > 0.5 || PANEL_BY_DEFAULT[kind]) {
    panel = reviewPanelFor(placed.id, pools, ctx);
    const why = xv > 0.5 ? `cross_vendor_review p=${pct(xv)} > 0.5` : `class ${kind} is reviewed by a panel (p=${pct(xv)})`;
    if (panel) reasons.push(`${why} → review panel: ${describePanel(panel)}`);
  }
  if (!panel && placed.id !== "review_panel") reasons.push(`no review panel (p=${pct(xv)}); class check: ${CLASS_CHECK[kind]}`);

  return { id: placed.id, account: placed.account, panel, reasons };
}

function describePanel(p: Panel): string {
  const who = (r: { lane: string; account: string | null }) => `${r.lane}@${r.account}`;
  return `reviewers [${p.reviewers.map(who).join(", ")}], judge ${p.judge ? who(p.judge) : "coordinator"}` +
    (p.escalation ? `, escalation ${who(p.escalation)}` : "") + (p.reasons.length ? `; ${p.reasons.join("; ")}` : "");
}

function fallbackLane(brief: string, pools: PoolStatus, ctx: CommandContext, why: string, builder: BuilderVendor | null): Lane {
  const reasons = [`fallback used: ${why}`];
  const fb = classifyFallback(brief);
  const base = fallbackBaseLane(fb, reasons);
  const placed = placeLane(base, pools, reasons);
  const panel = placed.id === "review_panel" ? pickPanel(builder, pools, ctx) : reviewPanelFor(placed.id, pools, ctx);
  if (panel) reasons.push(`fallback: review panel always attached → ${describePanel(panel)}`);
  return { id: placed.id, account: placed.account, panel, reasons };
}

// Jev judgment (or error) → lane. Exported for tests (tests/route.test.ts).
export function asksForEdits(brief: string): boolean {
  if (/\b(read-only|do not edit|don't edit|no edits)\b/i.test(brief)) return false;
  return /(^|\n)\s*(fix|implement|refactor|build|add|change)\b|red test first|\bcommit\b|git merge main/i.test(brief);
}

export function decide(input: {
  judgment: JevJudgment | null;
  jevError: string | null;
  brief: string;
  pools: PoolStatus;
  ctx: CommandContext;
  builder?: BuilderVendor | null;
}): { lane: Lane; source: "jev" | "fallback"; riskUnsure: boolean } {
  const { judgment, jevError, brief, pools, ctx } = input;
  const builder = input.builder ?? null;
  // Fall back entirely only when the API failed or `kind` itself is unsure.
  if (!judgment || judgment.kind.confidence < CONFIDENCE_FLOOR) {
    const why = !judgment
      ? `Jev error: ${jevError ?? "no judgment"}`
      : `Jev unsure about kind: confidence ${judgment.kind.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}`;
    const lane = fallbackLane(brief, pools, ctx, why, builder);
    if (judgment) lane.reasons.push(`Jev said kind=${judgment.kind.top}`);
    return { lane, source: "fallback", riskUnsure: false };
  }
  const riskUnsure = noulConfidence(judgment.risk.p) < CONFIDENCE_FLOOR;
  // A brief that asks for edits is never a read-only review, whatever words it quotes from the
  // review it answers (2026-11-07: a "fix the panel's findings" brief went to review_frozen and
  // launched a panel instead of a worker).
  if (judgment.kind.top === "review_frozen" && asksForEdits(brief)) {
    const j = { ...judgment, kind: { ...judgment.kind, top: "refactor_multifile" as const } };
    const lane = pickLane(j, pools, ctx, { riskUnsure, builder });
    lane.reasons.unshift("brief asks for edits (fix / red test / commit) and does not say read-only → review_frozen overridden to refactor_multifile");
    return { lane, source: "jev", riskUnsure };
  }
  return { lane: pickLane(judgment, pools, ctx, { riskUnsure, builder }), source: "jev", riskUnsure };
}

// ---- CLI ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) positional.push(a);
    else if (["--touches-secrets", "--no-jev", "--no-log"].includes(a)) flags.add(a.slice(2));
    else opts[a.slice(2)] = argv[++i] ?? "";
  }
  return { positional, opts, flags };
}

async function main(): Promise<number> {
  const { positional, opts, flags } = parseArgs(process.argv.slice(2));
  const briefPath = positional[0];
  if (!briefPath || !existsSync(briefPath)) {
    console.error("usage: route.ts <brief-file> [--repo DIR] [--ledger PATH] [--log PATH|--no-log] [--touches-secrets] [--no-jev] [--timeout-ms N] [--builder claude|codex|agy|grok]");
    return 1;
  }
  const BUILDERS = ["claude", "codex", "agy", "grok"];
  if (opts.builder !== undefined && !BUILDERS.includes(opts.builder)) {
    console.error(`route: --builder must be one of ${BUILDERS.join(", ")}`);
    return 1;
  }
  const builder = (opts.builder as BuilderVendor | undefined) ?? null;
  const fullBrief = readFileSync(briefPath, "utf8");
  const brief = fullBrief.slice(0, MAX_BRIEF_CHARS);
  const repo = resolve(opts.repo ?? process.cwd());
  const ledger = opts.ledger ? resolve(opts.ledger) : process.env.POOL_LEDGER ?? findLedger(repo);
  const pools = loadPools(ledger && existsSync(ledger) ? ledger : null);
  const sessionId = randomUUID();
  const ctx: CommandContext = { repo, brief: resolve(briefPath), sessionId };
  const timeoutMs = Number(opts["timeout-ms"] ?? 2000);

  let lane: Lane;
  let source: "jev" | "fallback" | "manual";
  let judgment: JevJudgment | null = null;
  let jevMeta: Record<string, unknown> = {};
  let jevError: string | null = null;
  let riskUnsure = false;

  if (flags.has("touches-secrets") || containsSecretValue(fullBrief)) {
    source = "manual";
    const why = flags.has("touches-secrets") ? "--touches-secrets set by hand" : "brief contains a secret-looking value";
    lane = { id: "coordinator_only", account: "coordinator", panel: null, reasons: [`${why} → coordinator only; Jev not called`] };
  } else if (flags.has("no-jev")) {
    source = "fallback";
    lane = fallbackLane(brief, pools, ctx, "--no-jev", builder);
  } else {
    try {
      const r = await askJev(brief, timeoutMs);
      judgment = r.judgment;
      jevMeta = { model: r.model, ms: r.ms, usage: r.usage };
    } catch (e) {
      jevError = e instanceof JevError ? e.message : `unexpected: ${(e as Error).message}`;
    }
    ({ lane, source, riskUnsure } = decide({ judgment, jevError, brief, pools, ctx, builder }));
  }
  if (fullBrief.length > MAX_BRIEF_CHARS) lane.reasons.push(`brief truncated to ${MAX_BRIEF_CHARS} chars for classification`);

  // Agreement check: the coordinator reviews cases where Jev and the fallback disagree.
  const fb = classifyFallback(brief);
  const disagree = source === "jev" && judgment !== null && fb.kind !== null && fb.kind !== judgment.kind.top;
  if (source === "jev") {
    lane.reasons.push(
      fb.kind === null
        ? "fallback classifier: no clear class (no comparison)"
        : `fallback classifier: kind=${fb.kind} (${disagree ? "DISAGREES — coordinator should check" : "agrees"})`,
    );
  }

  const spec = LANES[lane.id];
  const command =
    lane.account === "coordinator" ? null
    : lane.id === "review_panel" ? lane.panel?.command ?? buildCommand(lane.id, lane.account, ctx)
    : buildCommand(lane.id, lane.account, ctx);
  const isPanelLane = lane.id === "review_panel";
  const out = {
    vendor: spec.vendor,
    model: spec.model,
    effort: spec.effort,
    account: lane.account,
    // Review panel: the lane itself for review_frozen, else the review attached to this lane.
    reviewers: lane.panel?.reviewers ?? [],
    judge: lane.panel?.judge ?? null,
    escalation: lane.panel?.escalation ?? null,
    review_command: !isPanelLane && lane.panel ? lane.panel.command : null,
    command,
    reasons: lane.reasons,
    lane: lane.id,
    mode: spec.mode,
    source,
    repo,
    brief: ctx.brief,
    ...(spec.vendor === "grok" ? { session_id: sessionId } : {}),
    ledger: ledger ?? null,
    judgment: judgment && {
      kind: judgment.kind.top,
      kind_confidence: round(judgment.kind.confidence),
      kind_probabilities: Object.fromEntries(Object.entries(judgment.kind.probabilities).map(([k, v]) => [k, round(v)])),
      risk: round(judgment.risk.p),
      ctx_size: judgment.ctx_size.top,
      needs_recent_facts: round(judgment.needs_recent_facts.p),
      cross_vendor_review_recommended: round(judgment.cross_vendor_review_recommended.p),
      estimated_steps: judgment.estimated_steps.top,
      touches_secrets: round(judgment.touches_secrets.p),
      ...jevMeta,
    },
  };
  console.log(JSON.stringify(out, null, 2));

  const logPath = flags.has("no-log") ? null : opts.log ?? process.env.MODEL_ROUTING_LOG ?? (ledger && existsSync(dirname(ledger)) ? join(dirname(ledger), "router-log.jsonl") : null);
  if (logPath) {
    appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      brief_sha256: createHash("sha256").update(fullBrief).digest("hex").slice(0, 16),
      source, lane: lane.id, account: lane.account,
      jev_kind: judgment?.kind.top ?? null, jev_kind_confidence: judgment ? round(judgment.kind.confidence) : null,
      fallback_kind: fb.kind, disagree, jev_error: jevError, risk_unsure: riskUnsure,
    }) + "\n");
  }
  return 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

if (process.argv[1]?.endsWith("route.ts")) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(`route: ${(e as Error).message}`); process.exitCode = 1; },
  );
}
