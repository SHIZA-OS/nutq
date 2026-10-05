// The first utterance of a turn waits FIRST_UTTERANCE_WAIT_MS (700) after its first unit is ready, collecting the units that
// arrive, and speaks at once on done or when the batch is full (?tts_stream=1). Real page in headless Chrome, stub gateway
// (page-harness.mjs). The 700 ms timer is a fake the test fires (__fireLong), and Date.now is a fake the test moves, so
// waited_ms is exact. The queue itself is tested with a fake clock in speech-queue.test.mjs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, eventsOf } from "./page-harness.mjs";

let h;
const r = {};
const S1 = "First sentence is long enough.";
const S2 = "Second sentence is long too.";
const POST = "The weather is sunny today.";
const tool = { type: "tool_call", id: "1", name: "search", args: { q: "A query." } };
const starts = (events) => eventsOf(events, "tts_sentence_start").map(({ index, units, chars, waited_ms }) => ({ index, units, chars, waited_ms }));

before(async () => {
  h = await startHarness();
  const open = () => h.openPage("tts_stream=1", { keepFirstWait: true });
  const timers = (p) => p.page.evaluate(() => window.__longCount());

  // Collect: the second unit arrives during the wait and joins the first; nothing is spoken before the timer.
  let p = await open();
  await p.send({ type: "chunk", content: `${S1} ` });
  r.collect = { afterFirst: await p.state(), timers: await timers(p) };
  await p.advance(300);
  await p.send({ type: "chunk", content: `${S2} ` });
  r.collect.afterSecond = await p.state();
  await p.advance(400);
  await p.page.evaluate(() => window.__fireLong());
  r.collect.after = await p.state();
  await p.page.evaluate(() => window.__sp.utterances[0].onstart({}));
  r.collect.audible = await p.state();

  // done during the wait: speaks at once, with the time waited, and the timer is gone.
  p = await open();
  await p.send({ type: "chunk", content: `${S1} ` });
  await p.advance(250);
  await p.send({ type: "done", full_response: `${S1} `, tokens_used: 1 });
  r.done = { state: await p.state(), timers: await timers(p) };
  await p.page.evaluate(() => window.__sp.utterances[0].onstart({}));
  r.done.audible = await p.state();

  // A tool call during the wait drops the collected units; nothing was with the browser, so nothing is cancelled; what comes after
  // waits again from its own start.
  p = await open();
  await p.send({ type: "chunk", content: `${S1} ` });
  await p.send({ type: "chunk", content: `${S2} And then I will` });
  await p.send(tool);
  r.tool = { dropped: await p.state(), timers: await timers(p) };
  await p.page.evaluate(() => window.__fireLong());
  r.tool.quiet = await p.state();
  await p.advance(100);
  await p.send({ type: "chunk", content: `${POST} ` });
  await p.advance(700);
  await p.page.evaluate(() => window.__fireLong());
  await p.page.evaluate(() => window.__sp.utterances[0].onstart({}));
  r.tool.after = await p.state();

  // A mic tap during the wait cancels what is collected: nothing is spoken, tts_cancelled mic_press, no timer left.
  p = await open();
  await p.send({ type: "chunk", content: `${S1} ` });
  await p.mic();
  r.tap = { state: await p.state(), timers: await timers(p) };
  await p.page.evaluate(() => window.__fireLong());
  r.tap.after = await p.state();
});

after(async () => {
  await h?.close();
});

test("the first sentence is not spoken until the wait is over or the turn finishes: one timer, nothing with the browser", () => {
  assert.deepEqual(r.collect.afterFirst.spoken, []);
  assert.equal(r.collect.timers, 1);
  assert.deepEqual(eventsOf(r.collect.afterFirst.events, "tts_requested").map((e) => e.index), [0]); // queued at once, reported at once
});

test("units that arrive during the wait are one utterance with the first, and tts_sentence_start carries units, chars and waited_ms", () => {
  assert.deepEqual(r.collect.afterSecond.spoken, []);
  assert.deepEqual(r.collect.after.spoken, [`${S1} ${S2}`]);
  assert.deepEqual(starts(r.collect.audible.events), [{ index: 0, units: 2, chars: S1.length + 1 + S2.length, waited_ms: 700 }]);
  assert.equal(eventsOf(r.collect.audible.events, "tts_start").length, 1); // tts_start keeps its meaning: the first audible audio
});

test("done during the wait speaks at once and reports the time actually waited; no timer is left to speak again", () => {
  assert.deepEqual(r.done.state.spoken, [S1]);
  assert.equal(r.done.timers, 0);
  assert.deepEqual(starts(r.done.audible.events), [{ index: 0, units: 1, chars: S1.length, waited_ms: 250 }]);
});

test("a tool call during the wait drops the collected units (tts_dropped), cancels nothing, and leaves no timer", () => {
  const dropped = eventsOf(r.tool.dropped.events, "tts_dropped").map(({ reason, units, chars, partial_chars }) => ({ reason, units, chars, partial_chars }));
  assert.deepEqual(dropped, [{ reason: "tool_call", units: 2, chars: S1.length + S2.length, partial_chars: "And then I will".length }]);
  assert.equal(r.tool.dropped.cancels, 0);
  assert.equal(r.tool.timers, 0);
  assert.deepEqual(r.tool.quiet.spoken, []);
});

test("what comes after the tool call waits again from its own start and is spoken as itself", () => {
  assert.deepEqual(r.tool.after.spoken, [POST]);
  assert.deepEqual(starts(r.tool.after.events).map((x) => [x.index, x.waited_ms]), [[2, 700]]);
});

test("a mic tap during the wait cancels it: nothing is spoken, tts_cancelled mic_press, and no timer fires later", () => {
  assert.deepEqual(eventsOf(r.tap.state.events, "tts_cancelled").map((e) => e.reason), ["mic_press"]);
  assert.equal(r.tap.timers, 0);
  assert.deepEqual(r.tap.after.spoken, []);
});
