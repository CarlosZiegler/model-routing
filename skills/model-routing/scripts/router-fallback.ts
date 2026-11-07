#!/usr/bin/env -S node --experimental-strip-types
// Regex keyword classifier used when Jev times out, errors, or is unsure.
// Conservative: no clear single class → opus_medium; a reviewer is always attached.
//
// CLI: router-fallback.ts <brief-file>   prints the classification JSON.

import { readFileSync } from "node:fs";
import { LANE_BY_KIND, LANES, oneRungUp, type Kind, type LaneId } from "./lanes.ts";

type Pattern = [RegExp, number];

const KIND_PATTERNS: Record<Kind, Pattern[]> = {
  review_frozen: [
    [/\b(review|audit|critique|attack|assess)\w*\b/i, 3],
    [/\b(findings?|verdict|SHIP or FIX|FREEZE or REVISE|severity)\b/i, 2],
    [/\b(diff[- ]gate|spec[- ]gate|second opinion)\b/i, 3],
  ],
  planning_spec: [
    [/\b(write|draft|design)\b.{0,40}\b(spec|plan|proposal|rfc|adr|architecture)\b/i, 3],
    [/\b(architecture|trade-?offs?|design doc|roadmap|decide between)\b/i, 2],
  ],
  research_recent: [
    [/\b(research|latest|newest|current (price|version)|release notes|changelog|announced?)\b/i, 2],
    [/\b(cite|citations?|sources?)\b/i, 1],
  ],
  debug_hard: [
    [/\b(debug|diagnos\w*|root cause|flaky|crash\w*|regression|intermittent|stack ?trace|segfault|deadlock|race condition)\b/i, 3],
    [/\b(bug|fails?|failing|broken|error)\b/i, 1],
  ],
  refactor_multifile: [
    [/\b(refactor\w*|restructur\w*|migrate|extract (a |the )?(module|service)|across (all|several|many) files|rename .{0,30} everywhere)\b/i, 3],
  ],
  feature_frozen: [
    [/\b(implement|add (a |an |the )?(new )?(feature|endpoint|button|field|screen|command|flag|option)|build (a|the)|ticket|acceptance criteria)\b/i, 3],
    [/\b(feature|endpoint|component|handler)\b/i, 1],
  ],
  mechanical_edit: [
    [/\b(typo|spelling|wording|reword|docs?|readme|changelog entry|comment|rename|bump|version|formatting|lint fix|update (the )?(link|text|copy))\b/i, 2],
    [/\b(one[- ]line|single line|small edit|mechanical)\b/i, 2],
  ],
  bulk_extraction: [
    [/\b(extract|list all|for (each|every)|bulk|triage|classify (all|each)|count|inventory|csv|spreadsheet)\b/i, 2],
  ],
  chat_qa: [
    [/^\s*(what|why|how|when|where|which|who|is|are|can|does|do)\b[^\n]{0,200}\?\s*$/im, 2],
    [/\b(explain|question|quick answer)\b/i, 1],
  ],
};

const RISK_RE =
  /\b(infra\w*|terraform|kubernetes|k8s|deploy\w*|security|auth\w*|permissions?|migrations?|schema|database|production|prod\b|payments?|billing|encryption|secrets?)\b/i;
const SECRETS_RE =
  /(\.env\b|\bapi[_ -]?keys?\b|\b(access|auth|api|bearer|refresh|session|secret) tokens?\b|\bpasswords?\b|\bcredentials?\b|\bprivate keys?\b|\bsecrets?\b|\.pem\b)/i;
// "no secrets in output", "never print .env" are constraints, not secret work.
const NEGATED_SECRETS_RE =
  /\b(no|never|without|don't|do not|not)\b[^.\n]{0,40}?(secrets?|\.env|tokens?|credentials?|passwords?|keys?)\b/gi;
const RECENT_RE = /\b(latest|newest|this (week|month)|recent(ly)?|2026|announced|release notes|current price)\b/i;

// Secret *values* in the brief itself: never send such a brief to Jev or a worker.
const SECRET_VALUE_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(api|secret|access)[_-]?(key|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-/+]{16,}/i,
];

export function containsSecretValue(brief: string): boolean {
  return SECRET_VALUE_RES.some((re) => re.test(brief));
}

export interface FallbackJudgment {
  kind: Kind | null; // null = no single clear class
  scores: Partial<Record<Kind, number>>;
  risk: boolean;
  touches_secrets: boolean;
  needs_recent_facts: boolean;
}

export function asksForEdits(brief: string): boolean {
  if (/\b(read-only|do not edit|don't edit|no edits)\b/i.test(brief)) return false;
  return /(^|\n)\s*(fix|implement|refactor|build|add|change)\b|red test first|\bcommit\b|git merge main/i.test(brief);
}

export function classifyFallback(brief: string): FallbackJudgment {
  const scores: Partial<Record<Kind, number>> = {};
  for (const [kind, patterns] of Object.entries(KIND_PATTERNS) as [Kind, Pattern[]][]) {
    const s = patterns.reduce((acc, [re, w]) => acc + (re.test(brief) ? w : 0), 0);
    if (s > 0) scores[kind] = s;
  }
  const ranked = (Object.entries(scores) as [Kind, number][]).sort((a, b) => b[1] - a[1]);
  const clear = ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]);
  let kind: Kind | null = clear ? ranked[0][0] : null;
  // A brief that asks for edits is never a read-only review (see asksForEdits).
  if (kind === "review_frozen" && asksForEdits(brief)) kind = "refactor_multifile";
  return {
    kind,
    scores,
    risk: RISK_RE.test(brief),
    touches_secrets: SECRETS_RE.test(brief.replace(NEGATED_SECRETS_RE, " ")) || containsSecretValue(brief),
    needs_recent_facts: RECENT_RE.test(brief),
  };
}

// Base lane before pool placement; route.ts places it and always attaches a reviewer.
export function fallbackBaseLane(fb: FallbackJudgment, reasons: string[]): LaneId {
  if (fb.touches_secrets) {
    reasons.push("fallback: brief mentions secrets/.env/tokens → coordinator only");
    return "coordinator_only";
  }
  let lane: LaneId;
  if (fb.kind) {
    lane = LANE_BY_KIND[fb.kind];
    reasons.push(`fallback: keywords → ${fb.kind} → ${lane}`);
  } else {
    lane = "opus_medium";
    reasons.push(`fallback: no single clear class (${JSON.stringify(fb.scores)}) → conservative opus_medium`);
  }
  if (fb.risk && (LANES[lane].mode === "build" || LANES[lane].mode === "bulk" || LANES[lane].mode === "chat")) {
    const up = oneRungUp(lane, fb.kind);
    reasons.push(`fallback: risk keywords → rung up ${lane} → ${up}`);
    lane = up;
  }
  return lane;
}

if (process.argv[1]?.endsWith("router-fallback.ts")) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: router-fallback.ts <brief-file>");
    process.exitCode = 1;
  } else {
    const brief = readFileSync(file, "utf8");
    const fb = classifyFallback(brief);
    const reasons: string[] = [];
    const lane = fallbackBaseLane(fb, reasons);
    console.log(JSON.stringify({ ...fb, lane, reasons }, null, 2));
  }
}
