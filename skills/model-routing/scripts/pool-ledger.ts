#!/usr/bin/env -S node --experimental-strip-types
// Append-only pool ledger: .coord/model-routing/pool-ledger.tsv (per project).
//
// Columns: ts account vendor model effort run_id tokens_in tokens_out cost_usd verdict note
// verdict: start | done | error | limit | pass | fail | cooling
// Legacy 7/8-column rows (`... run_id start` / `... run_id done <cost>`) are read as-is.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { LANES, type LaneId, type PoolStatus } from "./lanes.ts";
import { loadConfig, type RoutingConfig } from "./config.ts";

export const HEADER = [
  "ts", "account", "vendor", "model", "effort", "run_id",
  "tokens_in", "tokens_out", "cost_usd", "verdict", "note",
] as const;
// Team seats come from scripts/config.ts (MODEL_ROUTING_SEATS or ~/.config/model-routing/config.json).
export const teamSeats = (cfg: RoutingConfig = loadConfig()): string[] => cfg.seats;
const LEDGER_REL = join(".coord", "model-routing", "pool-ledger.tsv");
const HOUR = 3600_000;

export interface Row {
  ts: string;
  account: string;
  vendor: string;
  model: string;
  effort: string;
  run_id: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  verdict: string;
  note: string;
  legacy: boolean;
}

// ---- ledger location ---------------------------------------------------------

export function findLedger(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, LEDGER_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function defaultLedgerForWrite(start = process.cwd()): string {
  const found = findLedger(start);
  if (found) return found;
  let root = start;
  try {
    root = execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a git repo: use cwd
  }
  return join(root, LEDGER_REL);
}

// ---- read / write ------------------------------------------------------------

const num = (s: string | undefined): number | null => {
  if (s === undefined || s === "" || s === "-" || s === "null") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function parseLedger(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("ts\t")) continue;
    const f = line.split("\t");
    if (f.length < 6) continue;
    const base = { ts: f[0], account: f[1], vendor: f[2], model: f[3], effort: f[4], run_id: f[5] };
    if (f.length <= 8 && (f[6] === "start" || f[6] === "done")) {
      rows.push({ ...base, tokens_in: null, tokens_out: null, cost_usd: num(f[7]), verdict: f[6], note: "", legacy: true });
    } else {
      rows.push({
        ...base,
        tokens_in: num(f[6]),
        tokens_out: num(f[7]),
        cost_usd: num(f[8]),
        verdict: f[9] || "done",
        note: f[10] ?? "",
        legacy: false,
      });
    }
  }
  return rows;
}

export function readLedger(path: string): Row[] {
  return existsSync(path) ? parseLedger(readFileSync(path, "utf8")) : [];
}

const clean = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/[\t\r\n]+/g, " "));

export function appendRow(path: string, r: Partial<Row> & { account: string; verdict: string }): string {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) appendFileSync(path, HEADER.join("\t") + "\n");
  const row = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    vendor: "-", model: "-", effort: "-", run_id: "-",
    tokens_in: null, tokens_out: null, cost_usd: null, note: "",
    ...r,
  };
  const line = HEADER.map((k) => clean(row[k as keyof typeof row])).join("\t");
  appendFileSync(path, line + "\n");
  return line;
}

// ---- runs, cooling, seats ----------------------------------------------------------

export interface Run {
  account: string;
  vendor: string;
  model: string;
  effort: string;
  run_id: string;
  started: string | null;
  finished: string | null;
  outcome: string | null; // done | error | limit
  verdict: string | null; // pass | fail
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

export function collectRuns(rows: Row[]): Run[] {
  const runs = new Map<string, Run>();
  for (const r of rows) {
    if (r.verdict === "cooling") continue;
    const key = `${r.account}\t${r.run_id}`;
    let run = runs.get(key);
    if (!run) {
      run = {
        account: r.account, vendor: r.vendor, model: r.model, effort: r.effort, run_id: r.run_id,
        started: null, finished: null, outcome: null, verdict: null, cost_usd: null, tokens_in: null, tokens_out: null,
      };
      runs.set(key, run);
    }
    if (r.verdict === "start") {
      run.started ??= r.ts;
    } else if (r.verdict === "pass" || r.verdict === "fail") {
      run.verdict = r.verdict;
    } else {
      run.finished = r.ts;
      run.outcome = r.verdict;
      if (r.cost_usd !== null) run.cost_usd = (run.cost_usd ?? 0) + r.cost_usd;
      if (r.tokens_in !== null) run.tokens_in = (run.tokens_in ?? 0) + r.tokens_in;
      if (r.tokens_out !== null) run.tokens_out = (run.tokens_out ?? 0) + r.tokens_out;
    }
  }
  return [...runs.values()];
}

export function coolingUntil(rows: Row[], account: string, now = Date.now()): string | null {
  let until: string | null = null;
  for (const r of rows) {
    if (r.account !== account || r.verdict !== "cooling") continue;
    const m = /until=(\S+)/.exec(r.note);
    if (m && Date.parse(m[1]) > now && (!until || Date.parse(m[1]) > Date.parse(until))) until = m[1];
  }
  return until;
}

export interface SeatStatus {
  account: string;
  last_use: string | null;
  runs_5h: number;
  cost_5h: number;
  open: number;
  cooling_until: string | null;
}

export function seatStatus(rows: Row[], account: string, now = Date.now()): SeatStatus {
  let last: string | null = null;
  let runs5h = 0;
  let cost5h = 0;
  for (const r of rows) {
    if (r.account !== account || r.verdict === "cooling") continue;
    if (!last || r.ts > last) last = r.ts;
    const t = Date.parse(r.ts);
    if (now - t <= 5 * HOUR) {
      if (r.verdict === "start") runs5h++;
      if (r.cost_usd !== null) cost5h += r.cost_usd;
    }
  }
  const open = collectRuns(rows).filter(
    (x) => x.account === account && x.started && !x.finished && now - Date.parse(x.started) < 6 * HOUR,
  ).length;
  return { account, last_use: last, runs_5h: runs5h, cost_5h: round(cost5h), open, cooling_until: coolingUntil(rows, account, now) };
}

// Heuristic headroom: the ledger has no prompt counts, so a seat is "full" after
// maxRuns5h starts in the trailing 5h. Override with MODEL_ROUTING_MAX_RUNS_5H.
const maxRuns5h = (): number => Number(process.env.MODEL_ROUTING_MAX_RUNS_5H) || 20;

// Least-recently-used team seat that is not cooling and not full; ties → fewer open runs.
export function nextSeat(rows: Row[], now = Date.now(), seats: string[] = teamSeats()): string | null {
  const free = seats.map((s) => seatStatus(rows, s, now)).filter(
    (s) => !s.cooling_until && s.runs_5h < maxRuns5h(),
  );
  free.sort((a, b) => (a.last_use ?? "").localeCompare(b.last_use ?? "") || a.open - b.open);
  return free[0]?.account ?? null;
}

export function loadPools(ledger: string | null, now = Date.now(), cfg: RoutingConfig = loadConfig()): PoolStatus & { rows: Row[] } {
  const rows = ledger ? readLedger(ledger) : [];
  const POOL_ACCOUNT: Record<string, string> = { main: cfg.mainAccount, codex: "codex", google: "google", grok: "grok" };
  return {
    rows,
    chooseAccountFor(lane: LaneId): string | null {
      const pool = LANES[lane].pool;
      if (pool === "coordinator") return "coordinator";
      if (pool === "panel") return "panel"; // composite: members are placed one by one
      if (pool === "team") return nextSeat(rows, now, cfg.seats);
      const account = POOL_ACCOUNT[pool];
      return coolingUntil(rows, account, now) ? null : account;
    },
  };
}

// ---- vendor output parsing -------------------------------------------------------

export interface ParsedOutput {
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  outcome: "done" | "error" | "limit";
  resets_at: string | null;
  detail: string;
}

// "You've hit your 5-hour limit · resets 1:30pm (Europe/Berlin)" (Claude Code, 2026-11-07) was missed
// by the first version of this regex, so the seat was logged as `error` and never cooled.
const LIMIT_RE = /usage limit|rate[ _-]?limit|quota|RESOURCE_EXHAUSTED|limit reached|hit your [^.\n]*limit|\d+-hour limit|weekly limit|429|too many requests/i;

// "resets 1:30pm (Europe/Berlin)" → next such wall-clock time in that zone, as ISO.
export function parseResetsText(text: string, now = new Date()): string | null {
  const m = text.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  const min = Number(m[2] ?? 0);
  const tz = m[4];
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(now).map((p) => [p.type, p.value]),
    );
    const zoneNowAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    const offset = zoneNowAsUtc - Math.floor(now.getTime() / 60000) * 60000;
    let target = Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, min) - offset;
    if (target <= now.getTime()) target += 24 * 3600 * 1000;
    return new Date(target).toISOString();
  } catch {
    return null;
  }
}

function deepFind(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) if (k in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[k];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const hit = deepFind(v, keys);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function toIso(v: unknown): string | null {
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

export function parseOutput(vendor: string, stdout: string, stderr: string, exitCode: number): ParsedOutput {
  const out: ParsedOutput = { tokens_in: null, tokens_out: null, cost_usd: null, outcome: "done", resets_at: null, detail: "" };
  let isError = exitCode !== 0;
  let errText = "";
  if (vendor === "codex") {
    // JSONL events from `codex exec --json`; usage on turn.completed.
    for (const line of stdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      let ev: Record<string, any>;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "turn.completed" && ev.usage) {
        out.tokens_in = (out.tokens_in ?? 0) + (ev.usage.input_tokens ?? 0);
        out.tokens_out = (out.tokens_out ?? 0) + (ev.usage.output_tokens ?? 0);
      }
      if (ev.type === "turn.failed" || ev.type === "error") {
        isError = true;
        errText += " " + JSON.stringify(ev.error ?? ev.message ?? ev);
      }
      const resets = deepFind(ev, ["resets_at", "resetsAt"]);
      if (resets !== undefined) out.resets_at = toIso(resets) ?? out.resets_at;
    }
  } else {
    let j: Record<string, any> | null = null;
    try { j = JSON.parse(stdout); } catch { isError = true; errText += " output is not JSON"; }
    if (j) {
      const u = j.usage ?? {};
      // Claude: cache_*_input_tokens; agy: cache_read_tokens (excluded from its input_tokens, verified 2026-11-07).
      const tin = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_read_tokens ?? 0);
      out.tokens_in = u.input_tokens !== undefined ? tin : null;
      out.tokens_out = u.output_tokens ?? null;
      const cost = j.total_cost_usd ?? j.cost_usd ?? deepFind(j, ["total_cost_usd", "cost_usd"]);
      out.cost_usd = typeof cost === "number" ? round(cost, 6) : null;
      if (vendor === "agy") {
        // Clean only if SUCCESS, no denied actions, no finished_reason, non-empty response.
        const denied = Array.isArray(j.denied_actions) && j.denied_actions.length > 0;
        if (j.status !== "SUCCESS" || denied || j.finished_reason || !String(j.response ?? "").trim()) {
          isError = true;
          const names = denied ? j.denied_actions.map((d: any) => d.display_name ?? d.action).join(",") : "";
          errText += ` status=${j.status}` +
            (j.finished_reason ? ` finished_reason=${j.finished_reason}` : "") +
            (denied ? ` denied=${names}` : "") +
            (!String(j.response ?? "").trim() ? " empty_response" : "") +
            (j.error ? ` ${j.error}` : "");
        }
      } else if (j.is_error === true) {
        isError = true;
        errText += " " + String(j.result ?? j.error ?? "").slice(0, 300);
      }
      const resets = deepFind(j, ["resetsAt", "resets_at", "reset_time"]);
      if (resets !== undefined) out.resets_at = toIso(resets);
    }
  }
  if (isError) {
    out.outcome = LIMIT_RE.test(errText + " " + stderr.slice(-4000)) ? "limit" : "error";
    if (out.outcome === "limit" && !out.resets_at) out.resets_at = parseResetsText(errText + " " + stderr.slice(-4000));
    out.detail = (errText.trim() || stderr.trim().split("\n").slice(-1)[0] || `exit ${exitCode}`).slice(0, 200);
  }
  return out;
}

// ---- report ------------------------------------------------------------------

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface Group {
  key: string;
  runs: number;
  finished: number;
  open: number;
  cost_usd: number;
  costed: number;
  tokens_in: number;
  tokens_out: number;
  verdicts: Record<string, number>;
}

function groupRuns(runs: Run[], keyOf: (r: Run) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const r of runs) {
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, runs: 0, finished: 0, open: 0, cost_usd: 0, costed: 0, tokens_in: 0, tokens_out: 0, verdicts: {} };
      groups.set(key, g);
    }
    g.runs++;
    if (r.finished) g.finished++;
    else g.open++;
    if (r.cost_usd !== null) { g.cost_usd += r.cost_usd; g.costed++; }
    g.tokens_in += r.tokens_in ?? 0;
    g.tokens_out += r.tokens_out ?? 0;
    const v = r.verdict ?? r.outcome ?? "open";
    g.verdicts[v] = (g.verdicts[v] ?? 0) + 1;
  }
  return [...groups.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.runs - a.runs);
}

export function report(rows: Row[], since: string | null) {
  const kept = since ? rows.filter((r) => r.ts >= since) : rows;
  const runs = collectRuns(kept);
  return {
    rows: kept.length,
    legacy_rows: kept.filter((r) => r.legacy).length,
    span: kept.length ? [kept[0].ts, kept[kept.length - 1].ts] : null,
    runs: runs.length,
    total_cost_usd: round(runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0)),
    by_account: groupRuns(runs, (r) => r.account),
    by_vendor: groupRuns(runs, (r) => r.vendor),
    by_model: groupRuns(runs, (r) => `${r.vendor}/${r.model}/${r.effort}`),
    cooling: [...new Set(kept.map((r) => r.account))]
      .map((a) => ({ account: a, until: coolingUntil(kept, a) }))
      .filter((c) => c.until),
  };
}

function printTable(title: string, groups: Group[]): void {
  const head = ["key", "runs", "done", "open", "cost_usd", "costed", "avg_cost", "tok_in", "tok_out", "verdicts"];
  const lines = groups.map((g) => [
    g.key, String(g.runs), String(g.finished), String(g.open), g.cost_usd.toFixed(2), String(g.costed),
    g.costed ? (g.cost_usd / g.costed).toFixed(2) : "-",
    g.tokens_in ? String(g.tokens_in) : "-", g.tokens_out ? String(g.tokens_out) : "-",
    Object.entries(g.verdicts).map(([k, v]) => `${k}=${v}`).join(" "),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  console.log(`\n${title}`);
  console.log(fmt(head));
  for (const l of lines) console.log(fmt(l));
}

// ---- CLI -----------------------------------------------------------------------

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string>; flags: Set<string> } {
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opts[key] = next; i++; } else flags.add(key);
    } else if (!cmd) cmd = a;
  }
  return { cmd, opts, flags };
}

const USAGE = `pool-ledger.ts [--ledger PATH] <command>
  start     --account A --vendor V --model M --effort E --run-id ID [--note N]
  done      --account A --vendor V --model M --effort E --run-id ID
            [--output FILE --stderr FILE --exit N]      parse tokens/cost/limit from vendor output
            [--tokens-in N --tokens-out N --cost USD --verdict done|error|limit] [--note N]
  verdict   --run-id ID --verdict pass|fail [--account A] [--note N]
  cool      --account A [--until ISO | --hours H] [--note N]
  next-seat [--json]
  status    [--json]
  report    [--since ISO | --days N] [--json]
Ledger: --ledger > $POOL_LEDGER > nearest .coord/model-routing/pool-ledger.tsv above cwd.`;

function need(opts: Record<string, string>, ...keys: string[]): void {
  const missing = keys.filter((k) => !opts[k]);
  if (missing.length) throw new Error(`missing --${missing.join(", --")}\n${USAGE}`);
}

const DEFAULT_COOL_HOURS: Record<string, number> = { codex: 24, google: 24, grok: 24 };

function main(argv: string[]): number {
  const { cmd, opts, flags } = parseArgs(argv);
  const write = ["start", "done", "verdict", "cool"].includes(cmd);
  const ledger = opts.ledger ?? process.env.POOL_LEDGER ?? (write ? defaultLedgerForWrite() : findLedger());

  switch (cmd) {
    case "start": {
      need(opts, "account", "vendor", "model", "effort", "run-id");
      console.log(appendRow(ledger!, {
        account: opts.account, vendor: opts.vendor, model: opts.model, effort: opts.effort,
        run_id: opts["run-id"], verdict: "start", note: opts.note ?? "",
      }));
      return 0;
    }
    case "done": {
      need(opts, "account", "vendor", "model", "effort", "run-id");
      let parsed: ParsedOutput | null = null;
      if (opts.output) {
        const stdout = existsSync(opts.output) ? readFileSync(opts.output, "utf8") : "";
        const stderr = opts.stderr && existsSync(opts.stderr) ? readFileSync(opts.stderr, "utf8") : "";
        parsed = parseOutput(opts.vendor, stdout, stderr, Number(opts.exit ?? 0));
      }
      const verdict = opts.verdict ?? parsed?.outcome ?? "done";
      const note = [opts.note, parsed?.detail].filter(Boolean).join("; ");
      console.log(appendRow(ledger!, {
        account: opts.account, vendor: opts.vendor, model: opts.model, effort: opts.effort, run_id: opts["run-id"],
        tokens_in: num(opts["tokens-in"]) ?? parsed?.tokens_in ?? null,
        tokens_out: num(opts["tokens-out"]) ?? parsed?.tokens_out ?? null,
        cost_usd: num(opts.cost) ?? parsed?.cost_usd ?? null,
        verdict, note,
      }));
      if (verdict === "limit") {
        const hours = DEFAULT_COOL_HOURS[opts.account] ?? 5;
        const until = parsed?.resets_at ?? new Date(Date.now() + hours * HOUR).toISOString();
        console.log(appendRow(ledger!, { account: opts.account, vendor: opts.vendor, verdict: "cooling", note: `until=${until} usage limit on ${opts["run-id"]}` }));
      }
      return 0;
    }
    case "verdict": {
      need(opts, "run-id", "verdict");
      if (!["pass", "fail"].includes(opts.verdict)) throw new Error("--verdict must be pass or fail");
      const rows = readLedger(ledger!);
      const run = [...rows].reverse().find((r) => r.run_id === opts["run-id"] && (!opts.account || r.account === opts.account));
      if (!run) throw new Error(`run ${opts["run-id"]} not found in ${ledger}`);
      console.log(appendRow(ledger!, {
        account: run.account, vendor: run.vendor, model: run.model, effort: run.effort,
        run_id: run.run_id, verdict: opts.verdict, note: opts.note ?? "",
      }));
      return 0;
    }
    case "cool": {
      need(opts, "account");
      const hours = Number(opts.hours ?? DEFAULT_COOL_HOURS[opts.account] ?? 5);
      const until = opts.until ? toIso(opts.until) : new Date(Date.now() + hours * HOUR).toISOString();
      if (!until) throw new Error("--until must be an ISO date");
      console.log(appendRow(ledger!, { account: opts.account, verdict: "cooling", note: `until=${until} ${opts.note ?? ""}`.trim() }));
      return 0;
    }
    case "next-seat":
    case "status":
    case "report": {
      if (!ledger || !existsSync(ledger)) {
        if (cmd === "next-seat") { const first = teamSeats()[0]; console.log(flags.has("json") ? JSON.stringify({ seat: first, ledger: null }) : first); return 0; }
        throw new Error("no ledger found (pass --ledger PATH)");
      }
      const rows = readLedger(ledger);
      if (cmd === "next-seat") {
        const seat = nextSeat(rows);
        console.log(flags.has("json") ? JSON.stringify({ seat, ledger }) : (seat ?? "none"));
        return seat ? 0 : 2;
      }
      if (cmd === "status") {
        const cfg = loadConfig();
        const accounts = [...cfg.seats, cfg.mainAccount, "codex", "google", "grok"];
        const st = accounts.map((a) => seatStatus(rows, a));
        if (flags.has("json")) console.log(JSON.stringify(st, null, 2));
        else for (const s of st) console.log(`${s.account.padEnd(7)} last_use=${s.last_use ?? "-"} runs_5h=${s.runs_5h} cost_5h=${s.cost_5h} open=${s.open} cooling_until=${s.cooling_until ?? "-"}`);
        return 0;
      }
      const since = opts.since ?? (opts.days ? new Date(Date.now() - Number(opts.days) * 24 * HOUR).toISOString() : null);
      const rep = report(rows, since);
      if (flags.has("json")) { console.log(JSON.stringify({ ledger, ...rep }, null, 2)); return 0; }
      console.log(`ledger: ${ledger}`);
      console.log(`rows: ${rep.rows} (legacy ${rep.legacy_rows})  runs: ${rep.runs}  span: ${rep.span?.join(" .. ") ?? "-"}  total cost_usd: ${rep.total_cost_usd.toFixed(2)}`);
      console.log("verdicts: start-only runs count as open; done/error/limit come from the run; pass/fail from `verdict` rows");
      printTable("By account", rep.by_account);
      printTable("By vendor", rep.by_vendor);
      printTable("By model (vendor/model/effort)", rep.by_model);
      if (rep.cooling.length) console.log("\ncooling: " + rep.cooling.map((c) => `${c.account} until ${c.until}`).join(", "));
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("pool-ledger.ts")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`pool-ledger: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
