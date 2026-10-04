// Tests src/speech-queue.ts, the sentence queue, in a headless Chrome page served by Vite (the real module). The
// engine is a fake and the clock is a fake: time only moves when the test ticks it, so nothing here waits. Runs
// with the rest of the suite via `npm test`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-speechqueue-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { SpeechQueue } = await import("/src/speech-queue.ts");

    const makeClock = () => {
      let now = 0;
      let seq = 0;
      const timers = [];
      return {
        get now() {
          return now;
        },
        setTimeout: (fn, ms) => timers.push({ at: now + ms, seq: seq++, fn }),
        tick(ms) {
          const end = now + ms;
          for (;;) {
            const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
            if (!due) break;
            timers.splice(timers.indexOf(due), 1);
            now = due.at;
            due.fn();
          }
          now = end;
        },
      };
    };

    // Audio starts 10 ms after speak() and lasts 2 ms per character. A text starting "bad" fails with
    // synthesis-failed at the start, and one starting "interrupt" with interrupted. cancel() reports the active
    // utterance as canceled right away, like a browser; its start and end timers are NOT cleared, so a late
    // onStart or onEnd from a cancelled utterance still arrives, which a queue must ignore.
    const makeEngine = (clock) => {
      const e = { name: "fake", spoken: [], cancels: 0, overlaps: 0, active: null };
      e.speak = (text, onStart, onEnd, onError) => {
        if (e.active) e.overlaps++;
        const u = { onError };
        e.active = u;
        e.spoken.push(text);
        const done = (fn) => () => {
          if (e.active === u) e.active = null;
          fn();
        };
        if (text.startsWith("bad")) clock.setTimeout(done(() => onError("synthesis-failed")), 10);
        else if (text.startsWith("interrupt")) clock.setTimeout(done(() => onError("interrupted")), 10);
        else {
          clock.setTimeout(() => onStart({ voice: "V" }), 10);
          clock.setTimeout(done(onEnd), 10 + text.length * 2);
        }
      };
      e.cancel = () => {
        e.cancels++;
        const u = e.active;
        e.active = null;
        if (u) u.onError("canceled");
      };
      return e;
    };
    const setup = () => {
      const clock = makeClock();
      const engine = makeEngine(clock);
      const events = [];
      const queue = new SpeechQueue(engine, (e) => events.push({ t: clock.now, ...e }));
      return { clock, engine, events, queue };
    };
    const out = {};

    // In order, one at a time, with the engine's start info carried on the start event.
    let s = setup();
    ["aaaa", "bbbbbb", "cc"].forEach((t) => s.queue.enqueue(t));
    out.firstSpoken = [...s.engine.spoken]; // only the first sentence has gone to the engine
    s.clock.tick(100);
    out.ordered = { events: s.events, spoken: s.engine.spoken, overlaps: s.engine.overlaps };

    // A sentence queued while another plays waits; one queued after the queue drained plays at once, same turn.
    s = setup();
    s.queue.enqueue("aaaa");
    s.clock.tick(5);
    s.queue.enqueue("bbbb");
    s.clock.tick(100);
    s.queue.enqueue("cccc");
    s.clock.tick(100);
    out.whilePlaying = s.events.filter((e) => e.type !== "end").map((e) => [e.t, e.type, e.index, e.first ?? null]);

    // A one-sentence reply: one requested, one start (first), one end.
    s = setup();
    s.queue.enqueue("only one sentence");
    out.finishReturns = s.queue.finish();
    s.clock.tick(100);
    out.single = s.events;

    // A turn ends when finish() was called and everything has played; the next sentence is a new turn.
    s = setup();
    s.queue.enqueue("aaaa");
    s.clock.tick(100);
    out.finishAfterDrain = s.queue.finish();
    s.queue.enqueue("bbbb");
    s.clock.tick(100);
    out.nextTurn = s.events.filter((e) => e.type === "requested" || e.type === "start").map((e) => [e.type, e.index, e.first ?? null]);
    s = setup();
    s.queue.enqueue("aaaa");
    s.queue.enqueue("bbbb");
    out.finishWhilePlaying = s.queue.finish(); // not over until both have played
    s.clock.tick(100);
    s.queue.enqueue("cccc");
    s.clock.tick(100);
    out.finishWhilePlayingEvents = s.events.filter((e) => e.type === "requested" || e.type === "start").map((e) => [e.type, e.index, e.first ?? null]);
    out.finishEmpty = setup().queue.finish();

    // cancel() mid-sentence: queued sentences are dropped, the engine is stopped, one cancelled event, and
    // nothing else is reported, not the cancelled utterance's own error and not its late end.
    s = setup();
    ["aaaa", "bbbb", "cccc"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(12);
    s.queue.cancel();
    s.clock.tick(1000);
    out.cancelMid = { events: s.events.map((e) => [e.t, e.type, e.index ?? null]), spoken: s.engine.spoken, cancels: s.engine.cancels };

    // cancel() before the first sentence became audible: its late start is ignored, so no tts_start.
    s = setup();
    s.queue.enqueue("aaaa");
    s.clock.tick(5);
    s.queue.cancel();
    s.clock.tick(1000);
    out.cancelBeforeStart = s.events.map((e) => [e.t, e.type]);

    // cancel() with nothing playing or waiting: the engine is still stopped, but no event.
    s = setup();
    s.queue.cancel();
    s.queue.enqueue("aaaa");
    s.clock.tick(100);
    s.queue.cancel();
    out.cancelIdle = { cancelled: s.events.filter((e) => e.type === "cancelled").length, cancels: s.engine.cancels };

    // The next run after a cancel starts clean, and the cancelled run's late callbacks do not touch it.
    s = setup();
    s.queue.enqueue("aaaa");
    s.clock.tick(12);
    s.queue.cancel();
    s.queue.enqueue("bbbbbb");
    s.clock.tick(5); // t=17: the cancelled sentence would have ended at 18
    s.clock.tick(1000);
    out.afterCancel = { events: s.events.map((e) => [e.t, e.type, e.index ?? null, e.first ?? null]), overlaps: s.engine.overlaps };

    // An engine error is reported with its code and the queue goes on. The first audible audio of the turn is the
    // first sentence that actually starts, even if it is not index 0.
    s = setup();
    ["bad one", "good one", "interrupted one", "last one"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(1000);
    out.errors = s.events.filter((e) => e.type !== "requested").map((e) => [e.type, e.index, e.first ?? null, e.code ?? null]);
    return out;
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("sentences play in order, one at a time; the engine only gets the next one when the last has ended", () => {
  assert.deepEqual(r.firstSpoken, ["aaaa"]);
  assert.deepEqual(r.ordered.spoken, ["aaaa", "bbbbbb", "cc"]);
  assert.equal(r.ordered.overlaps, 0);
  assert.deepEqual(r.ordered.events, [
    { t: 0, type: "requested", index: 0 },
    { t: 0, type: "requested", index: 1 },
    { t: 0, type: "requested", index: 2 },
    { t: 10, type: "start", index: 0, first: true, info: { voice: "V" } },
    { t: 18, type: "end", index: 0 },
    { t: 28, type: "start", index: 1, first: false, info: { voice: "V" } },
    { t: 40, type: "end", index: 1 },
    { t: 50, type: "start", index: 2, first: false, info: { voice: "V" } },
    { t: 54, type: "end", index: 2 },
  ]);
});

test("a sentence queued while another plays waits for it; one queued after the queue drained plays at once, in the same turn", () => {
  assert.deepEqual(r.whilePlaying, [
    [0, "requested", 0, null],
    [5, "requested", 1, null],
    [10, "start", 0, true],
    [28, "start", 1, false],
    [105, "requested", 2, null],
    [115, "start", 2, false],
  ]);
});

test("a one-sentence reply is one requested, one start marked first, one end; finish() says how many sentences there were", () => {
  assert.deepEqual(r.single, [
    { t: 0, type: "requested", index: 0 },
    { t: 10, type: "start", index: 0, first: true, info: { voice: "V" } },
    { t: 44, type: "end", index: 0 },
  ]);
  assert.equal(r.finishReturns, 1);
  assert.equal(r.finishEmpty, 0);
});

test("after finish() and a full drain, the next sentence is a new turn: index 0 again and first again", () => {
  assert.equal(r.finishAfterDrain, 1);
  assert.deepEqual(r.nextTurn, [["requested", 0, null], ["start", 0, true], ["requested", 0, null], ["start", 0, true]]);
  assert.equal(r.finishWhilePlaying, 2);
  assert.deepEqual(r.finishWhilePlayingEvents, [
    ["requested", 0, null],
    ["requested", 1, null],
    ["start", 0, true],
    ["start", 1, false],
    ["requested", 0, null],
    ["start", 0, true],
  ]);
});

test("cancel() drops what is queued, stops the engine and reports one cancelled; the cancelled sentence reports nothing more", () => {
  assert.deepEqual(r.cancelMid.events, [
    [0, "requested", 0],
    [0, "requested", 1],
    [0, "requested", 2],
    [10, "start", 0],
    [12, "cancelled", null],
  ]);
  assert.deepEqual(r.cancelMid.spoken, ["aaaa"]);
  assert.equal(r.cancelMid.cancels, 1);
});

test("cancel() before the first sentence is audible means no start event at all, even when the engine starts late", () => {
  assert.deepEqual(r.cancelBeforeStart, [[0, "requested"], [5, "cancelled"]]);
});

test("cancel() with nothing playing or queued still stops the engine but reports nothing", () => {
  assert.deepEqual(r.cancelIdle, { cancelled: 0, cancels: 2 });
});

test("a run after a cancel starts clean: index 0, first, and the cancelled run's late callbacks do not touch it", () => {
  assert.deepEqual(r.afterCancel.events, [
    [0, "requested", 0, null],
    [10, "start", 0, true],
    [12, "cancelled", null, null],
    [12, "requested", 0, null],
    [22, "start", 0, true],
    [34, "end", 0, null],
  ]);
  assert.equal(r.afterCancel.overlaps, 0);
});

test("an engine error is reported with its code and the queue goes on; first is the first sentence that really starts", () => {
  assert.deepEqual(r.errors, [
    ["error", 0, null, "synthesis-failed"],
    ["start", 1, true, null],
    ["end", 1, null, null],
    ["error", 2, null, "interrupted"],
    ["start", 3, false, null],
    ["end", 3, null, null],
  ]);
});
