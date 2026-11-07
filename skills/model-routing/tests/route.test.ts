// Run: node --experimental-strip-types --test tests/   (or: bun test tests/)
// Offline: no Jev call, no model call. Pools are stubbed (every pool has a free account).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, type JevJudgment } from "../route.ts";
import { LANES, pickPanel, type LaneId, type PoolStatus } from "../scripts/lanes.ts";

// Hermetic: ignore the developer's ~/.config/model-routing/config.json; use the default generic seats.
process.env.MODEL_ROUTING_CONFIG = new URL("./fixtures/no-such-config.json", import.meta.url).pathname;
delete process.env.MODEL_ROUTING_SEATS;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ctx = { repo: "/tmp/repo", brief: "/tmp/brief.md", sessionId: "00000000-0000-0000-0000-000000000000" };

function pools(cold: string[] = []): PoolStatus {
  const acct: Record<string, string> = { team: "seat-b", main: "main", codex: "codex", google: "google", grok: "grok", coordinator: "coordinator", panel: "panel" };
  return { chooseAccountFor: (lane: LaneId) => (cold.includes(LANES[lane].pool) ? null : acct[LANES[lane].pool]) };
}

function judgment(kind: JevJudgment["kind"]["top"], kindConf: number, riskP: number, xv = 0.8): JevJudgment {
  return {
    kind: { top: kind, confidence: kindConf, probabilities: { [kind]: kindConf } },
    risk: { p: riskP },
    ctx_size: { top: "small", score: 1, confidence: 0.8 },
    needs_recent_facts: { p: 0.05 },
    cross_vendor_review_recommended: { p: xv },
    estimated_steps: { top: "6-20", score: 2, confidence: 0.7 },
    touches_secrets: { p: 0.05 },
  };
}

// Regression: on tests/fixtures/review-panel-brief.md Jev returned kind=refactor_multifile (0.94) with a
// risk confidence |2p-1| = 0.30. The old rule sent everything to the keyword fallback, which saw
// "review" and picked review_frozen. Values reconstructed from that run (full probabilities not kept).
for (const riskP of [0.65, 0.35]) {
  test(`confident kind survives unsure risk (p=${riskP}): review-panel brief → refactor_multifile`, () => {
    const brief = fixture("review-panel-brief.md");
    const { lane, source, riskUnsure } = decide({ judgment: judgment("refactor_multifile", 0.94, riskP), jevError: null, brief, pools: pools(), ctx });
    assert.equal(source, "jev");
    assert.equal(riskUnsure, true);
    assert.match(lane.reasons[0], /^kind=refactor_multifile/);
    assert.equal(lane.id, "opus_high", "opus_medium plus the conservative risk bump");
    // p=0.65 already passes the 0.6 bump threshold; p=0.35 is bumped only because risk is unsure.
    const expected = riskP > 0.6 ? /^risk p=0\.65 > 0\.6 → rung up/ : /^risk unsure .* treated as high → rung up/;
    assert.ok(lane.reasons.some((r) => expected.test(r)), lane.reasons.join("\n"));
  });
}

// The live Jev answer for that brief, recorded 2026-11-07 (jev-1.14.0). Its touches_secrets p=0.41
// ("no secrets in output" in the brief) trips the secrets guard, which runs before kind.
function liveJudgment(): JevJudgment {
  const r = JSON.parse(fixture("review-panel-brief.jev.json"));
  return {
    kind: { top: r.kind, confidence: r.kind_confidence, probabilities: r.kind_probabilities },
    risk: { p: r.risk },
    ctx_size: { top: r.ctx_size, score: 2, confidence: 0.8 },
    needs_recent_facts: { p: r.needs_recent_facts },
    cross_vendor_review_recommended: { p: r.cross_vendor_review_recommended },
    estimated_steps: { top: r.estimated_steps, score: 3, confidence: 0.8 },
    touches_secrets: { p: r.touches_secrets },
  };
}

test("live judgment: p=0.41 for a brief that only forbids printing secrets no longer blocks it (threshold 0.5)", () => {
  const { lane, source, riskUnsure } = decide({ judgment: liveJudgment(), jevError: null, brief: fixture("review-panel-brief.md"), pools: pools(), ctx });
  assert.equal(source, "jev", "no keyword fallback any more");
  assert.equal(riskUnsure, true);
  assert.equal(lane.id, "opus_high");
});

test("touches_secrets above 0.5 still holds the brief for the coordinator", () => {
  const j = liveJudgment();
  j.touches_secrets.p = 0.6;
  const { lane } = decide({ judgment: j, jevError: null, brief: fixture("review-panel-brief.md"), pools: pools(), ctx });
  assert.equal(lane.id, "coordinator_only");
  assert.match(lane.reasons[0], /touches_secrets p=0\.60 > 0\.5 → coordinator only/);
});

test("live judgment with secrets cleared by the coordinator → refactor_multifile on opus_high + panel", () => {
  const j = liveJudgment();
  j.touches_secrets.p = 0.05;
  const { lane } = decide({ judgment: j, jevError: null, brief: fixture("review-panel-brief.md"), pools: pools(), ctx });
  assert.match(lane.reasons[0], /^kind=refactor_multifile/);
  assert.equal(lane.id, "opus_high");
  assert.deepEqual(lane.panel?.reviewers.map((r) => r.lane), ["terra_high_review", "terra_high_review", "argon_high_review"]);
});

test("the keyword fallback alone would have picked review_frozen on that brief (the bug)", () => {
  const { lane, source } = decide({ judgment: null, jevError: "timeout after 2000 ms", brief: fixture("review-panel-brief.md"), pools: pools(), ctx });
  assert.equal(source, "fallback");
  assert.equal(lane.id, "review_panel");
});

test("unsure kind still falls back entirely", () => {
  const { source, lane } = decide({ judgment: judgment("refactor_multifile", 0.3, 0.9), jevError: null, brief: fixture("feature-brief.md"), pools: pools(), ctx });
  assert.equal(source, "fallback");
  assert.ok(lane.reasons[0].includes("Jev unsure about kind"));
});

test("confident risk: no extra bump", () => {
  const { lane, riskUnsure } = decide({ judgment: judgment("refactor_multifile", 0.94, 0.05), jevError: null, brief: "", pools: pools(), ctx });
  assert.equal(riskUnsure, false);
  assert.equal(lane.id, "opus_medium");
});

test("review_frozen → panel: 2x Terra high + Argon high, Terra judge, Sol escalation", () => {
  const { lane } = decide({ judgment: judgment("review_frozen", 0.9, 0.1), jevError: null, brief: "", pools: pools(), ctx });
  assert.equal(lane.id, "review_panel");
  assert.equal(lane.account, "panel");
  assert.deepEqual(lane.panel?.reviewers.map((r) => r.lane), ["terra_high_review", "terra_high_review", "argon_high_review"]);
  assert.equal(lane.panel?.judge?.lane, "terra_high_judge");
  assert.equal(lane.panel?.escalation?.lane, "sol_high_prove");
  for (const r of lane.panel!.reviewers) assert.ok(r.command && !/workspace-write|bypass/.test(r.command), "reviewers are read-only");
  assert.match(lane.panel!.judge!.command!, /--sandbox read-only/);
  assert.match(lane.panel!.escalation!.command!, /--sandbox workspace-write/);
});

test("feature built by Claude gets the default panel as its review, even with cross_vendor p <= 0.5", () => {
  const { lane } = decide({ judgment: judgment("feature_frozen", 0.98, 0.22, 0.49), jevError: null, brief: fixture("feature-brief.md"), pools: pools(), ctx });
  assert.equal(lane.id, "sonnet_high");
  assert.deepEqual(lane.panel?.reviewers.map((r) => r.vendor), ["codex", "codex", "agy"]);
  assert.match(lane.panel!.command, /review-panel\.sh' "\$REVIEW_BRIEF" .* --builder claude$/);
});

test("Codex built → Opus high + Argon high reviewers, Opus high judge, no Codex member", () => {
  const p = pickPanel("codex", pools(), ctx);
  assert.deepEqual(p.reviewers.map((r) => r.lane), ["opus_high_review", "argon_high_review"]);
  assert.equal(p.judge?.lane, "opus_high_judge");
  assert.equal(p.escalation?.lane, "opus_high_prove");
  assert.ok([...p.reviewers, p.judge!, p.escalation!].every((m) => m.vendor !== "codex"));
});

test("Codex pool cooling, Claude built: Terra slots move to Argon, judge has no cross-vendor seat", () => {
  const p = pickPanel("claude", pools(["codex"]), ctx);
  assert.deepEqual(p.reviewers.map((r) => r.lane), ["argon_high_review", "argon_high_review", "argon_high_review"]);
  assert.equal(p.judge, null, "Opus judge would be same-vendor; the coordinator judges");
  assert.ok(p.reasons.some((r) => /one vendor only/.test(r)));
});

test("a fix brief that quotes a review panel is a build, not a review", async () => {
  const { decide, asksForEdits } = await import("../route.ts");
  const brief = "Continue T43. Panel: final.md (F3 proven by Sol). Fix, red test first, minimal diff. Proof: tests green after git merge main.";
  assert.equal(asksForEdits(brief), true);
  assert.equal(asksForEdits("Read-only review of repo. Do not edit files. Panel findings."), false);
  const j = liveJudgment();
  j.kind = { ...j.kind, top: "review_frozen", confidence: 0.9 };
  j.touches_secrets.p = 0.05;
  const { lane } = decide({ judgment: j, jevError: null, brief, pools: pools(), ctx });
  assert.notEqual(lane.id, "review_panel");
  assert.match(lane.reasons[0], /overridden to refactor_multifile/);
});

test("the keyword fallback also turns an edit brief away from review", async () => {
  const { classifyFallback } = await import("../scripts/router-fallback.ts");
  const fb = classifyFallback("Panel result: final.md. Review findings F1-F3. Fix each, red test first. Proof: tests green after git merge main.");
  assert.notEqual(fb.kind, "review_frozen");
});
