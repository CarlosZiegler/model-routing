// Account configuration: which Claude team seats exist and where their config dirs live.
//
// Sources, highest precedence first:
//   1. MODEL_ROUTING_SEATS="seat-a,seat-b"   (comma list; overrides `seats` from the file)
//   2. $MODEL_ROUTING_CONFIG, else ~/.config/model-routing/config.json:
//        { "seats": ["seat-a", ...], "mainAccount": "main", "seatConfigDirPattern": "~/.claude-{seat}" }
//   3. Defaults below.
//
// Run directly to print the resolved config as JSON (used by dispatch.sh).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RoutingConfig {
  seats: string[];
  mainAccount: string;
  seatConfigDirPattern: string;
  source: string; // "defaults" | config file path, plus "+env" when MODEL_ROUTING_SEATS is set
}

export const DEFAULT_SEATS = ["seat-a", "seat-b", "seat-c", "seat-d"];
export const DEFAULT_MAIN_ACCOUNT = "main";
export const DEFAULT_SEAT_DIR_PATTERN = "~/.claude-{seat}";
// Account names that already mean something else in the ledger.
const RESERVED = new Set(["codex", "google", "grok", "coordinator", "panel"]);
// Names go into shell commands and file paths: keep them boring.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODEL_ROUTING_CONFIG || join(env.HOME || homedir(), ".config", "model-routing", "config.json");
}

function checkName(kind: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid ${kind} name ${JSON.stringify(name)} (allowed: letters, digits, . _ -)`);
  if (RESERVED.has(name)) throw new Error(`${kind} name "${name}" is reserved`);
  return name;
}

export function parseSeatList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  const path = configPath(env);
  let file: Partial<Record<keyof RoutingConfig, unknown>> = {};
  let source = "defaults";
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`cannot parse ${path}: ${(e as Error).message}`);
    }
    source = path;
  }
  let seats: string[] = DEFAULT_SEATS;
  if (Array.isArray(file.seats)) seats = file.seats.map(String);
  if (env.MODEL_ROUTING_SEATS) {
    seats = parseSeatList(env.MODEL_ROUTING_SEATS);
    source += "+env";
  }
  if (!seats.length) throw new Error("no seats configured (MODEL_ROUTING_SEATS or config.json `seats`)");
  if (new Set(seats).size !== seats.length) throw new Error(`duplicate seat names: ${seats.join(",")}`);
  const mainAccount = typeof file.mainAccount === "string" && file.mainAccount ? file.mainAccount : DEFAULT_MAIN_ACCOUNT;
  checkName("mainAccount", mainAccount);
  for (const s of seats) {
    checkName("seat", s);
    if (s === mainAccount) throw new Error(`seat "${s}" has the same name as mainAccount`);
  }
  const pattern =
    typeof file.seatConfigDirPattern === "string" && file.seatConfigDirPattern
      ? file.seatConfigDirPattern
      : DEFAULT_SEAT_DIR_PATTERN;
  if (!pattern.includes("{seat}")) throw new Error(`seatConfigDirPattern must contain {seat}: ${pattern}`);
  if (/["`$\\\n]/.test(pattern)) throw new Error(`seatConfigDirPattern must not contain quotes, $, backslashes or newlines`);
  return { seats, mainAccount, seatConfigDirPattern: pattern, source };
}

// Shell-ready value for CLAUDE_CONFIG_DIR: "~/x" becomes "$HOME/x" so the command stays portable.
export function seatConfigDirShell(seat: string, cfg: RoutingConfig): string {
  const p = cfg.seatConfigDirPattern.replaceAll("{seat}", seat);
  return `"${p.startsWith("~/") ? "$HOME/" + p.slice(2) : p}"`;
}

// Absolute path, for existence checks.
export function seatConfigDir(seat: string, cfg: RoutingConfig, env: NodeJS.ProcessEnv = process.env): string {
  const p = cfg.seatConfigDirPattern.replaceAll("{seat}", seat);
  return p.startsWith("~/") ? join(env.HOME || homedir(), p.slice(2)) : p;
}

if (process.argv[1]?.endsWith("config.ts")) {
  try {
    const cfg = loadConfig();
    console.log(JSON.stringify({ ...cfg, seatConfigDirs: Object.fromEntries(cfg.seats.map((s) => [s, seatConfigDir(s, cfg)])) }));
  } catch (e) {
    console.error(`model-routing config: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
