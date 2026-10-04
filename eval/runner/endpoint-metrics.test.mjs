// Tests the pure helpers behind the replay's end-of-turn report (endpoint-metrics.mjs): speech runs and pauses
// from per-frame VAD probabilities, premature sends, the wait after the true end of speech, the summary, the
// commit latency model and the policy argument. No browser: plain Node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_MS, speechRuns, analyzeTurn, summarize, commitLatencyMs, parsePolicy, quantile, compareGate } from "./endpoint-metrics.mjs";

// probabilities from a pattern: "s" = speech frame (0.9), "." = silence (0.05), "w" = in between (0.4)
const probs = (pattern) => [...pattern].map((c) => (c === "s" ? 0.9 : c === "w" ? 0.4 : 0.05));
const sil = (n) => ".".repeat(n);
const sp = (n) => "s".repeat(n);

test("speech runs are frames at 0.5 or above; a gap shorter than 16 frames is a breath between words, not a pause", () => {
  assert.deepEqual(speechRuns(probs(sil(3) + sp(10) + sil(15) + sp(5) + sil(4))), [{ start: 3, end: 32 }]);
  assert.deepEqual(speechRuns(probs(sil(3) + sp(10) + sil(16) + sp(5) + sil(4))), [{ start: 3, end: 12 }, { start: 29, end: 33 }]);
  assert.deepEqual(speechRuns(probs("w".repeat(20))), []); // 0.4 is not speech
  assert.deepEqual(speechRuns([]), []);
});

test("a single utterance: the turn ends after the last speech, the wait after the true end is counted from its last frame", () => {
  const p = probs(sil(5) + sp(40) + sil(200));
  const end = 45 * FRAME_MS + 768 + 300; // 768 ms of redemption plus a 300 ms wait
  const a = analyzeTurn({ probs: p, endMs: end, trigger: "auto_silence" });
  assert.equal(a.last_speech_end_ms, 45 * FRAME_MS);
  assert.equal(a.premature, false);
  assert.equal(a.wait_after_true_end_ms, 768 + 300);
  assert.equal(a.pause_ms, null);
  assert.deepEqual(a.pauses, []);
});

test("a turn that ends inside a pause is premature, and says how far into the pause it ended", () => {
  const p = probs(sil(5) + sp(30) + sil(60) + sp(30) + sil(100));
  const pauseStart = 35 * FRAME_MS;
  const a = analyzeTurn({ probs: p, endMs: pauseStart + 1500, trigger: "auto_silence" });
  assert.equal(a.premature, true);
  assert.equal(a.pause_ms, 60 * FRAME_MS);
  assert.deepEqual(a.pauses, [{ start_ms: pauseStart, end_ms: 95 * FRAME_MS, ms: 60 * FRAME_MS }]);
  assert.equal(a.cut_into_pause_ms, 1500);
  assert.equal(a.wait_after_true_end_ms, null); // not a true end of turn
});

test("a turn that outlasts the pause is not premature and its true end is the last speech after it", () => {
  const p = probs(sil(5) + sp(30) + sil(60) + sp(30) + sil(300));
  const a = analyzeTurn({ probs: p, endMs: 125 * FRAME_MS + 1000, trigger: "auto_silence" });
  assert.equal(a.premature, false);
  assert.equal(a.pause_ms, 60 * FRAME_MS); // the pause is still reported
  assert.equal(a.last_speech_end_ms, 125 * FRAME_MS);
  assert.equal(a.wait_after_true_end_ms, 1000);
});

test("the longest gap is the pause; a manual stop is never premature and has no wait", () => {
  const p = probs(sil(2) + sp(20) + sil(30) + sp(20) + sil(80) + sp(20) + sil(50));
  const a = analyzeTurn({ probs: p, endMs: 2000, trigger: "manual" });
  assert.equal(a.pause_ms, 80 * FRAME_MS);
  assert.equal(a.premature, false);
  assert.equal(a.wait_after_true_end_ms, null);
});

test("no speech at all: no runs, nothing premature, no wait", () => {
  const a = analyzeTurn({ probs: probs(sil(100)), endMs: 5000, trigger: "auto_silence" });
  assert.deepEqual([a.last_speech_end_ms, a.premature, a.wait_after_true_end_ms, a.pause_ms], [null, false, null, null]);
});

test("quantile is nearest rank and ignores order", () => {
  assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.5), null);
});

test("summarize counts premature turns among turns with a pause and takes wait statistics over true ends", () => {
  const rows = [
    { pause_ms: null, premature: false, wait_after_true_end_ms: 1000 },
    { pause_ms: null, premature: false, wait_after_true_end_ms: 2000 },
    { pause_ms: 1500, premature: true, wait_after_true_end_ms: null },
    { pause_ms: 1500, premature: false, wait_after_true_end_ms: 3000 },
    { pause_ms: null, premature: false, wait_after_true_end_ms: null }, // a manual stop
  ];
  assert.deepEqual(summarize(rows), { cases: 5, with_pause: 2, premature: 1, true_ends: 3, wait_median_ms: 2000, wait_p90_ms: 3000, wait_max_ms: 3000 });
});

test("the commit latency model is 269 ms per second of audio minus 61 ms, at least 100 ms, scaled", () => {
  assert.equal(commitLatencyMs(2 * 16000, 1), 477); // 538 - 61
  assert.equal(commitLatencyMs(0.5 * 16000, 1), 100); // floor
  assert.equal(commitLatencyMs(2 * 16000, 0.5), 239); // 477 * 0.5, rounded
  assert.equal(commitLatencyMs(2 * 16000, 2), 954);
});

test("--policy: fixed:<ms>, semantic, semantic with five numbers; the default is the fixed 5000", () => {
  assert.deepEqual(parsePolicy(undefined), { kind: "fixed", ms: 5000 });
  assert.deepEqual(parsePolicy("fixed:1200"), { kind: "fixed", ms: 1200 });
  assert.deepEqual(parsePolicy("semantic"), { kind: "semantic", waits: null });
  assert.deepEqual(parsePolicy("semantic:0,1000,2500,0,8000"), { kind: "semantic", waits: { done: 0, unknown: 1000, open: 2500, floor: 0, ceiling: 8000 } });
  assert.deepEqual(parsePolicy("semantic:0,1000,2500,0,8000,tier2"), { kind: "semantic", waits: { done: 0, unknown: 1000, open: 2500, floor: 0, ceiling: 8000, tier2: true } });
  for (const bad of ["fixed", "fixed:abc", "fixed:-1", "semantic:1,2,3", "semantic:a,b,c,d,e", "semantic:1,2,3,4,5,tier3", "other", ""]) {
    assert.throws(() => parsePolicy(bad), /--policy/, bad);
  }
});

// --- the v1 gate: fail on a new error against the reference, list a changed hypothesis whose errors did not grow ---

const gc = (id, hypothesis, S, D, I) => ({ id, hypothesis, num_norm: { S, D, I } });

test("gate: an identical hypothesis is neither failed nor listed", () => {
  const g = compareGate([gc("a", "hello there", 0, 0, 0)], [gc("a", "hello there", 0, 0, 0)]);
  assert.deepEqual(g, { fail: [], review: [], unchanged: 1 });
});

test("gate: a new error of any kind (more substitutions, deletions or insertions) fails, and says which", () => {
  const base = [gc("s", "a b", 0, 0, 0), gc("d", "a b", 0, 0, 0), gc("i", "a b", 0, 0, 0), gc("ok", "a b", 1, 0, 0)];
  const got = [gc("s", "a x", 1, 0, 0), gc("d", "a", 0, 1, 0), gc("i", "a b c", 0, 0, 1), gc("ok", "a b", 1, 0, 0)];
  const g = compareGate(base, got);
  assert.deepEqual(g.fail.map((f) => [f.id, f.more]), [["s", ["S"]], ["d", ["D"]], ["i", ["I"]]]);
  assert.deepEqual(g.review, []);
  assert.equal(g.unchanged, 1);
});

test("gate: a changed hypothesis whose errors did not grow is listed for review, not failed", () => {
  // the stray word that was an insertion is gone: fewer errors
  const g = compareGate([gc("bn-03", "set a timer. yes.", 1, 0, 1)], [gc("bn-03", "set a timer.", 1, 0, 0)]);
  assert.deepEqual(g.fail, []);
  assert.deepEqual(g.review, [{ id: "bn-03", baseline: "set a timer. yes.", got: "set a timer.", errors: { baseline: { S: 1, D: 0, I: 1 }, got: { S: 1, D: 0, I: 0 } } }]);
  // only punctuation or case changed, same errors
  const p = compareGate([gc("p", "Yes.", 0, 0, 0)], [gc("p", "Yes", 0, 0, 0)]);
  assert.equal(p.fail.length, 0);
  assert.equal(p.review.length, 1);
});

test("gate: swapping one kind of error for another is a new error of that kind and fails", () => {
  const g = compareGate([gc("x", "a b", 1, 0, 0)], [gc("x", "a", 0, 1, 0)]);
  assert.deepEqual(g.fail.map((f) => [f.id, f.more]), [["x", ["D"]]]);
});

test("gate: a case missing from the new run fails; a case only in the new run is ignored", () => {
  const g = compareGate([gc("gone", "a", 0, 0, 0)], [gc("new", "b", 0, 0, 5)]);
  assert.deepEqual(g.fail.map((f) => [f.id, f.more]), [["gone", ["missing"]]]);
  assert.equal(g.review.length, 0);
});

// A case with an empty reference (sil-01, no-01 to no-04) is scored "silence": no num_norm, words_produced instead.
const sc = (id, hypothesis, words) => ({ id, hypothesis, status: "silence", words_produced: words });

test("gate: a silence case is compared by the words it produced (each is an insertion), and does not crash", () => {
  assert.deepEqual(compareGate([sc("no-01", "", 0)], [sc("no-01", "", 0)]), { fail: [], review: [], unchanged: 1 });
  const more = compareGate([sc("no-01", "", 0)], [sc("no-01", "Yes.", 1)]);
  assert.deepEqual(more.fail.map((f) => [f.id, f.more]), [["no-01", ["I"]]]);
  const fewer = compareGate([sc("no-01", "Yes.", 1)], [sc("no-01", "", 0)]);
  assert.deepEqual([fewer.fail.length, fewer.review.length], [0, 1]);
});

test("gate: a case that was scored before and has no transcript now fails as unscored; an unscored baseline case never fails", () => {
  const noTranscript = { id: "x", status: "no_transcript", reason: "no_transcript_final" };
  assert.deepEqual(compareGate([gc("x", "a b", 0, 0, 0)], [noTranscript]).fail.map((f) => [f.id, f.more]), [["x", ["unscored"]]]);
  const g = compareGate([noTranscript], [gc("x", "a b", 5, 5, 5)]);
  assert.deepEqual([g.fail.length, g.review.length], [0, 1]);
});
