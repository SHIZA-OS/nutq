// Tests the end-of-turn simulator (endpoint-sim.mjs) that replays a policy on a recorded stream of VAD events and
// commits, in a headless Chrome page served by Vite so that it runs the real TurnPolicy from src/turn-policy.ts.
// Hand-made streams with known answers; the timing rules are the replay's (frame k is processed, then the commits whose
// modelled run has finished are delivered, then the policy is asked about time k * 32 ms).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-endpointsim-"), {
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { TurnPolicy, waitFor } = await import("/src/turn-policy.ts");
    const { simulate } = await import("/eval/runner/endpoint-sim.mjs");
    const { commitLatencyMs } = await import("/eval/runner/endpoint-metrics.mjs");
    const W = { done: 300, unknown: 1500, open: 3500, floor: 0, ceiling: 8000 };
    const fixed = (ms) => () => new TurnPolicy(ms);
    const semantic = () => new TurnPolicy((text, n) => waitFor(text, W, n));
    const c = (f, from, samples, text, path = "commit") => ({ k: "commit", f, from, samples, skipped: false, path, text });
    const base = (seq, nFile = 200) => ({ nFile, seq });
    const out = {};
    // one utterance: speech starts at frame 2, a pause commit at 60 ("Hello there."), the VAD speech end at frame 100
    const one = base([{ k: "start", f: 2 }, c(60, 0, 35000, "Hello there."), { k: "end", f: 100 }, c(100, 61, 10000, "")]);
    out.fixed = simulate(one, fixed(500), commitLatencyMs, 1);
    out.semanticDone = simulate(one, semantic, commitLatencyMs, 1);
    // the text lands after the speech end: the policy waits as if unknown until it arrives, then the short wait is already past
    const late = base([{ k: "start", f: 2 }, c(95, 0, 35000, "Hello there."), { k: "end", f: 100 }]);
    out.semanticLate = simulate(late, semantic, commitLatencyMs, 1);
    // a later speech start in the stream is never seen when the turn already ended: premature, and the text is what was committed
    const cut = base([{ k: "start", f: 2 }, c(60, 0, 35000, "I want a flight and"), { k: "end", f: 100 }, { k: "start", f: 140 }, c(170, 61, 30000, "a hotel."), { k: "end", f: 200 }]);
    out.cutFixed = simulate(cut, fixed(500), commitLatencyMs, 1);
    out.cutOpen = simulate(cut, semantic, commitLatencyMs, 1); // "and" is open: 3500 ms, long enough to hear the second part
    // the second speech start cancels the pending wait
    out.cutOpenEnd = out.cutOpen.endMs;
    // no speech end at all: silence to the end of the file and the 312 grace frames, then a manual stop
    out.manual = simulate(base([{ k: "start", f: 2 }]), fixed(500), commitLatencyMs, 1);
    // a misfire arms like a speech end
    out.misfire = simulate(base([{ k: "start", f: 0 }, { k: "misfire", f: 28 }]), fixed(1000), commitLatencyMs, 1);
    // latency scale: a slower model delivers the text later
    out.slow = simulate(late, semantic, commitLatencyMs, 4);
    // a commit under the encoder minimum is never in flight
    out.skipped = simulate(base([{ k: "start", f: 2 }, { k: "commit", f: 99, from: 90, samples: 100, skipped: true, path: "stop", text: "" }, { k: "end", f: 100 }]), semantic, commitLatencyMs, 1);
    return out;
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("a fixed wait ends the turn one wait after the speech end, seen at the next frame boundary", () => {
  assert.equal(r.fixed.trigger, "auto_silence");
  assert.equal(r.fixed.endMs, 100 * 32 + 500); // speech end at frame 100 is timed at its start, 3200 ms
});

test("the semantic wait uses the text that arrived before the speech end", () => {
  assert.equal(r.semanticDone.endMs, 100 * 32 + 300); // "Hello there." is done: 300 ms
});

test("text that arrives after the wait would be over ends the turn when it arrives", () => {
  // the commit fires at 95 * 32 = 3040 ms and its modelled run is 527 ms: the text lands at 3567 ms
  assert.equal(r.semanticLate.endMs, 3567);
});

test("a slower model makes the same stream end later", () => assert.ok(r.slow.endMs > r.semanticLate.endMs));

test("events after the turn ended are not seen, and the sent text is the commits fired before it (the stop flush is not modelled)", () => {
  assert.equal(r.cutFixed.endMs, 100 * 32 + 500);
  assert.equal(r.cutFixed.sentText, "I want a flight and"); // the second commit fires at 170, after the end
});

test("an open text keeps the turn alive across the pause, so both parts are sent", () => {
  assert.ok(r.cutOpen.endMs > 200 * 32, `ended at ${r.cutOpen.endMs}`);
  assert.equal(r.cutOpen.sentText, "I want a flight and a hotel.");
});

test("no speech end: the turn runs to the end of the file plus the 312 grace frames and stops manually", () => {
  assert.deepEqual(r.manual, { endMs: (200 + 312) * 32, trigger: "manual", sentText: "" });
});

test("a misfire arms the wait like a speech end", () => assert.deepEqual([r.misfire.trigger, r.misfire.endMs], ["auto_silence", 28 * 32 + 1000]));

test("a skipped commit is never counted as in flight", () => assert.equal(r.skipped.endMs, 100 * 32 + 1500)); // no text: unknown, 1500 ms
