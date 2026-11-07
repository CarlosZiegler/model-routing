// Run: node --experimental-strip-types --test tests/   (offline)

import { test } from "node:test";
import assert from "node:assert/strict";
import { countVerdicts, summarize } from "../scripts/panel.ts";

const judge = `## F1: Off-by-one start
Verdict: CONFIRMED
Severity: high
Escalate: no

## F2: Maybe a race
**Verdict:** PLAUSIBLE
Escalate: needs-test

## F3: Wrong claim
- Verdict: REJECTED
- Escalate: dispute

COUNTS confirmed=1 plausible=1 rejected=1 escalate=2
`;

test("judge verdicts and escalated blocks are counted from the finding lines", () => {
  const c = countVerdicts(judge);
  assert.deepEqual({ ...c, escalated: c.escalated.length }, { findings: 3, confirmed: 1, plausible: 1, rejected: 1, escalate: 2, escalated: 2 });
  assert.match(c.escalated[0], /^## F2/);
  assert.match(c.escalated[1], /^## F3/);
});

test("codex JSONL: last agent message, tokens, list-price estimate with cached input", () => {
  const out = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}',
    '{"type":"turn.completed","usage":{"input_tokens":19725,"cached_input_tokens":8320,"output_tokens":5}}',
  ].join("\n");
  const s = summarize("codex", "gpt-6.1-terra", out, "", 0);
  assert.equal(s.ok, true);
  assert.equal(s.text, "final answer");
  assert.equal(s.tokens_in, 19725);
  // (19725-8320)*1 + 8320*0.1 + 5*5, per MTok
  assert.equal(s.est_usd, Math.round(((19725 - 8320) + 832 + 25) / 1e6 * 1e5) / 1e5);
});

test("agy: cache_read_tokens counted in tokens_in; empty response is not ok", () => {
  const good = summarize("agy", "gemini-4-argon-high", JSON.stringify({ status: "SUCCESS", response: "x", usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 30 } }), "", 0);
  assert.equal(good.tokens_in, 40);
  assert.equal(good.est_usd, null);
  const empty = summarize("agy", "gemini-4-argon-high", JSON.stringify({ status: "SUCCESS", response: "", denied_actions: [{ display_name: "RunCommand" }] }), "", 0);
  assert.equal(empty.ok, false);
  assert.match(empty.detail, /denied=RunCommand/);
});
