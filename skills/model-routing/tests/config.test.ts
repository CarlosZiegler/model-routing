// Run: node --experimental-strip-types --test tests/
// Account config: seats from MODEL_ROUTING_SEATS or a config file, generic defaults otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SEATS, loadConfig, seatConfigDir, seatConfigDirShell } from "../scripts/config.ts";
import { buildCommand } from "../scripts/lanes.ts";
import { loadPools, nextSeat, parseLedger } from "../scripts/pool-ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "model-routing-config-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const missing = join(dir, "missing.json");
const file = (name: string, body: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const ctx = { repo: "/tmp/repo", brief: "/tmp/brief.md", sessionId: "00000000-0000-0000-0000-000000000000" };

test("no file, no env → generic default seats", () => {
  const cfg = loadConfig({ HOME: dir, MODEL_ROUTING_CONFIG: missing });
  assert.deepEqual(cfg.seats, DEFAULT_SEATS);
  assert.deepEqual(cfg.seats, ["seat-a", "seat-b", "seat-c", "seat-d"]);
  assert.equal(cfg.mainAccount, "main");
  assert.equal(cfg.seatConfigDirPattern, "~/.claude-{seat}");
  assert.equal(cfg.source, "defaults");
});

test("config file sets seats, main account and dir pattern", () => {
  const p = file("a.json", { seats: ["alpha", "beta"], mainAccount: "primary", seatConfigDirPattern: "~/claude-seats/{seat}" });
  const cfg = loadConfig({ HOME: "/home/u", MODEL_ROUTING_CONFIG: p });
  assert.deepEqual(cfg.seats, ["alpha", "beta"]);
  assert.equal(cfg.mainAccount, "primary");
  assert.equal(seatConfigDir("beta", cfg, { HOME: "/home/u" }), "/home/u/claude-seats/beta");
  assert.equal(seatConfigDirShell("beta", cfg), '"$HOME/claude-seats/beta"');
});

test("MODEL_ROUTING_SEATS overrides the file's seats only", () => {
  const p = file("b.json", { seats: ["alpha"], mainAccount: "primary" });
  const cfg = loadConfig({ MODEL_ROUTING_CONFIG: p, MODEL_ROUTING_SEATS: " seat-a, seat-b ," });
  assert.deepEqual(cfg.seats, ["seat-a", "seat-b"]);
  assert.equal(cfg.mainAccount, "primary");
  assert.match(cfg.source, /\+env$/);
});

test("default config path is ~/.config/model-routing/config.json", () => {
  const home = mkdtempSync(join(dir, "home-"));
  assert.equal(loadConfig({ HOME: home }).source, "defaults");
  mkdirSync(join(home, ".config", "model-routing"), { recursive: true });
  writeFileSync(join(home, ".config", "model-routing", "config.json"), JSON.stringify({ seats: ["solo"] }));
  const cfg = loadConfig({ HOME: home });
  assert.deepEqual(cfg.seats, ["solo"]);
  assert.equal(cfg.source, join(home, ".config", "model-routing", "config.json"));
});

test("rejects unsafe, reserved, duplicate and empty seat lists", () => {
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: missing, MODEL_ROUTING_SEATS: "ok,bad name" }), /invalid seat/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: missing, MODEL_ROUTING_SEATS: "a;rm -rf" }), /invalid seat/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: missing, MODEL_ROUTING_SEATS: "codex" }), /reserved/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: missing, MODEL_ROUTING_SEATS: "a,a" }), /duplicate/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: missing, MODEL_ROUTING_SEATS: "main" }), /same name as mainAccount/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: file("e.json", { seats: [] }) }), /no seats/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: file("p.json", { seatConfigDirPattern: "~/.claude" }) }), /\{seat\}/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: file("q.json", { seatConfigDirPattern: "$(x)/{seat}" }) }), /must not contain/);
  assert.throws(() => loadConfig({ MODEL_ROUTING_CONFIG: file("bad.json", "{") }), /cannot parse/);
});

test("Claude command: seat gets its CLAUDE_CONFIG_DIR, main account unsets it", () => {
  const cfg = loadConfig({ MODEL_ROUTING_CONFIG: missing });
  assert.match(buildCommand("sonnet_high", "seat-c", ctx, cfg)!, /CLAUDE_CONFIG_DIR="\$HOME\/\.claude-seat-c" command claude -p/);
  assert.match(buildCommand("opus_xhigh", "main", ctx, cfg)!, /env -u CLAUDE_CONFIG_DIR command claude -p/);
});

test("pools: team lanes rotate over the configured seats, main pool uses mainAccount", () => {
  const p = file("c.json", { seats: ["alpha", "beta"], mainAccount: "primary" });
  const cfg = loadConfig({ MODEL_ROUTING_CONFIG: p });
  const rows = parseLedger("2026-01-01T00:00:00Z\talpha\tclaude\tsonnet\thigh\tr1\t\t\t\tstart\t\n");
  const now = Date.parse("2026-01-01T01:00:00Z");
  assert.equal(nextSeat(rows, now, cfg.seats), "beta", "least recently used");
  const pools = loadPools(null, now, cfg);
  assert.equal(pools.chooseAccountFor("sonnet_high"), "alpha");
  assert.equal(pools.chooseAccountFor("opus_xhigh"), "primary");
});
