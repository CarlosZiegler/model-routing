import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput, parseResetsText } from "../scripts/pool-ledger.ts";

const claudeLimit = JSON.stringify({ type: "result", is_error: true, num_turns: 1, total_cost_usd: 0, result: "You've hit your 5-hour limit · resets 1:30pm (Europe/Berlin)" });

test("Claude Code's 5-hour limit message is a limit, not an error", () => {
  const out = parseOutput("claude", claudeLimit, "", 1);
  assert.equal(out.outcome, "limit");
  assert.ok(out.resets_at, "resets_at parsed from the message");
});

test("resets 1:30pm (Europe/Berlin) at 12:32 Berlin (11:32Z, CET) → 12:30Z the same day", () => {
  assert.equal(parseResetsText("resets 1:30pm (Europe/Berlin)", new Date("2026-11-07T11:32:54Z")), "2026-11-07T12:30:00.000Z");
});

test("a reset time already past today rolls to tomorrow", () => {
  assert.equal(parseResetsText("resets 9am (Europe/Berlin)", new Date("2026-11-07T11:32:54Z")), "2026-11-08T08:00:00.000Z");
});
