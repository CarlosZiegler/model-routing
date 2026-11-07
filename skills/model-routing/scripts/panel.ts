#!/usr/bin/env -S node --experimental-strip-types
// Helpers for review-panel.sh. Zero dependencies.
//
//   panel.ts pick --repo DIR [--builder claude|codex|agy|grok] [--ledger PATH] [--brief FILE]
//       → Panel JSON {builder, reviewers[], judge, escalation, command, reasons}; member commands read $REVIEW_BRIEF
//   panel.ts summarize --vendor V --model M --output FILE [--stderr FILE] [--exit N]
//       → {ok, detail, text, tokens_in, cached_in, tokens_out, est_usd}
//   panel.ts verdicts --file JUDGE.md [--escalations OUT.md]
//       → {findings, confirmed, plausible, rejected, escalate}; writes the escalated finding blocks to OUT.md

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CACHED_INPUT_FACTOR, LIST_PRICE, pickPanel, type BuilderVendor } from "./lanes.ts";
import { findLedger, loadPools, parseOutput } from "./pool-ledger.ts";

const BUILDERS = ["claude", "codex", "agy", "grok"] as const;

export interface CallSummary {
  ok: boolean;
  detail: string;
  text: string;
  tokens_in: number | null;
  cached_in: number | null;
  tokens_out: number | null;
  est_usd: number | null; // list-price estimate for vendors that print no cost (Codex); vendor cost otherwise
}

export function summarize(vendor: string, model: string, stdout: string, stderr: string, exitCode: number): CallSummary {
  const parsed = parseOutput(vendor, stdout, stderr, exitCode);
  let text = "";
  let cached: number | null = null;
  if (vendor === "codex") {
    for (const line of stdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") text = ev.item.text;
      if (ev.type === "turn.completed" && ev.usage) cached = (cached ?? 0) + (ev.usage.cached_input_tokens ?? 0);
    }
  } else {
    try {
      const j = JSON.parse(stdout);
      text = String((vendor === "agy" ? j.response : j.result) ?? "");
      if (vendor === "claude") cached = j.usage?.cache_read_input_tokens ?? null;
      if (vendor === "agy") cached = j.usage?.cache_read_tokens ?? null;
    } catch {
      // parseOutput already marked it as an error
    }
  }
  let est = parsed.cost_usd;
  const price = LIST_PRICE[model];
  if (est === null && price && parsed.tokens_in !== null && parsed.tokens_out !== null) {
    // Codex usage: input_tokens includes cached_input_tokens; output_tokens is taken as including reasoning.
    const c = Math.min(cached ?? 0, parsed.tokens_in);
    est = ((parsed.tokens_in - c) * price.in + c * price.in * CACHED_INPUT_FACTOR + parsed.tokens_out * price.out) / 1e6;
    est = Math.round(est * 1e5) / 1e5;
  }
  const ok = parsed.outcome === "done" && text.trim().length > 0;
  const detail = parsed.detail || (text.trim() ? "" : "empty answer");
  return { ok, detail, text, tokens_in: parsed.tokens_in, cached_in: cached, tokens_out: parsed.tokens_out, est_usd: est };
}

const VERDICT_RE = /^[^\w\n]*verdict[^\w\n]*\s*(CONFIRMED|PLAUSIBLE|REJECTED)\b/gim;
const ESCALATE_RE = /^[^\w\n]*escalate[^\w\n]*\s*(dispute|needs[- ]test)\b/im;

export function countVerdicts(judge: string): { findings: number; confirmed: number; plausible: number; rejected: number; escalate: number; escalated: string[] } {
  const counts = { findings: 0, confirmed: 0, plausible: 0, rejected: 0, escalate: 0 };
  for (const m of judge.matchAll(VERDICT_RE)) {
    counts.findings++;
    counts[m[1].toLowerCase() as "confirmed" | "plausible" | "rejected"]++;
  }
  // Finding blocks start at a "## " heading; a block is escalated if its Escalate line says dispute/needs-test.
  const escalated = judge.split(/^(?=## )/m).filter((b) => b.startsWith("## ") && ESCALATE_RE.test(b)).map((b) => b.trim());
  counts.escalate = escalated.length;
  return { ...counts, escalated };
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) opts[a.slice(2)] = argv[++i] ?? "";
    else if (!cmd) cmd = a;
  }
  return { cmd, opts };
}

function main(argv: string[]): number {
  const { cmd, opts } = parseArgs(argv);
  switch (cmd) {
    case "pick": {
      if (!opts.repo) throw new Error("pick needs --repo DIR");
      const builder = opts.builder && opts.builder !== "none" ? opts.builder : null;
      if (builder && !(BUILDERS as readonly string[]).includes(builder)) throw new Error(`--builder must be one of ${BUILDERS.join(", ")}`);
      const repo = resolve(opts.repo);
      const ledger = opts.ledger ? resolve(opts.ledger) : process.env.POOL_LEDGER ?? findLedger(repo);
      const pools = loadPools(ledger && existsSync(ledger) ? ledger : null);
      const panel = pickPanel(builder as BuilderVendor | null, pools, { repo, brief: opts.brief ? resolve(opts.brief) : "$REVIEW_BRIEF", sessionId: randomUUID() });
      console.log(JSON.stringify(panel, null, 2));
      return 0;
    }
    case "summarize": {
      if (!opts.vendor || !opts.output) throw new Error("summarize needs --vendor V --model M --output FILE");
      const stdout = existsSync(opts.output) ? readFileSync(opts.output, "utf8") : "";
      const stderr = opts.stderr && existsSync(opts.stderr) ? readFileSync(opts.stderr, "utf8") : "";
      console.log(JSON.stringify(summarize(opts.vendor, opts.model ?? "", stdout, stderr, Number(opts.exit ?? 0))));
      return 0;
    }
    case "verdicts": {
      if (!opts.file) throw new Error("verdicts needs --file JUDGE.md");
      const { escalated, ...counts } = countVerdicts(readFileSync(opts.file, "utf8"));
      if (opts.escalations) writeFileSync(opts.escalations, escalated.join("\n\n") + (escalated.length ? "\n" : ""));
      console.log(JSON.stringify(counts));
      return 0;
    }
    default:
      console.error("usage: panel.ts pick|summarize|verdicts ... (see header)");
      return 1;
  }
}

if (process.argv[1]?.endsWith("panel.ts")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`panel: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
