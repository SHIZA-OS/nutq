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
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { SpeechQueue, MAX_UTTERANCE_CHARS, FIRST_UTTERANCE_WAIT_MS } = await import("/src/speech-queue.ts");

    const makeClock = () => {
      let now = 0;
      let seq = 0;
      const timers = [];
      return {
        get now() {
          return now;
        },
        setTimeout: (fn, ms) => {
          const t = { at: now + ms, seq: seq++, fn };
          timers.push(t);
          return t;
        },
        clearTimeout: (t) => {
          const i = timers.indexOf(t);
          if (i >= 0) timers.splice(i, 1);
        },
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
    // The wait for the first utterance (FIRST_UTTERANCE_WAIT_MS) is off in setup() so the older cases below keep their meaning
    // (the first unit goes to the engine as soon as it is queued); setupWait() has it on, with the fake clock as the queue's timers.
    const setup = (firstWaitMs = 0) => {
      const clock = makeClock();
      const engine = makeEngine(clock);
      const events = [];
      const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now };
      const queue = new SpeechQueue(engine, (e) => events.push({ t: clock.now, ...e }), { firstWaitMs, timers });
      return { clock, engine, events, queue };
    };
    const setupWait = () => setup(FIRST_UTTERANCE_WAIT_MS);
    const starts = (x) => x.events.filter((e) => e.type === "start").map((e) => ({ t: e.t, index: e.index, units: e.units, chars: e.chars, first: e.first, waited: e.waited ?? null }));
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

    // `sentences` is how many were queued this turn so far, readable before finish() ends the turn.
    s = setup();
    const counts = [s.queue.sentences];
    s.queue.enqueue("aaaa");
    s.queue.enqueue("bbbb");
    counts.push(s.queue.sentences);
    s.queue.finish();
    s.clock.tick(100);
    counts.push(s.queue.sentences); // the turn is over
    s.queue.enqueue("cccc");
    counts.push(s.queue.sentences);
    s.queue.cancel();
    counts.push(s.queue.sentences);
    out.counts = counts;

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

    // Coalescing: the first unit of the turn is spoken alone; the units that arrived while it played are one utterance.
    out.limit = MAX_UTTERANCE_CHARS;
    const L = MAX_UTTERANCE_CHARS;
    const lengths = (x) => x.engine.spoken.map((t) => t.length);
    s = setup();
    ["aaaa", "bbbb", "cccc", "dddd"].forEach((t) => s.queue.enqueue(t));
    out.finishCoalesced = s.queue.finish();
    s.clock.tick(1000);
    out.coalesce = { spoken: [...s.engine.spoken], overlaps: s.engine.overlaps, events: s.events.map((e) => [e.t, e.type, e.index, e.units ?? null, e.chars ?? null, e.first ?? null]) };
    s.queue.enqueue("eeee"); // the turn is over: a new one, alone, index 0
    s.clock.tick(1000);
    out.afterCoalesce = s.events.slice(-3).map((e) => [e.type, e.index, e.units ?? null, e.first ?? null]);

    // A unit that arrives after the merged utterance has started waits for it and is not merged into it.
    s = setup();
    ["aaaa", "bbbb", "cccc"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(20);
    s.queue.enqueue("dddd");
    s.clock.tick(1000);
    out.late = s.engine.spoken;

    // The limit: breaks at unit boundaries; exactly the limit fits (the join spaces count), one more does not.
    const pieces = (n, c) => c.repeat(n);
    s = setup();
    s.queue.enqueue("first");
    [pieces(500, "x"), pieces(500, "y"), pieces(L - 1002, "z")].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(100000);
    out.atLimit = lengths(s);
    s = setup();
    s.queue.enqueue("first");
    [pieces(500, "x"), pieces(500, "y"), pieces(L - 1001, "z")].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(100000);
    out.overLimit = lengths(s);
    // A unit longer than the limit is spoken alone, whole, and the units around it are not merged into it.
    s = setup();
    s.queue.enqueue("first");
    ["ab", pieces(L + 1, "x"), "cd", "ef"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(100000);
    out.oversized = lengths(s);

    // "First alone" is the first utterance handed to the engine, not the first one that became audible: after a failed
    // first one, what waited is still merged.
    s = setup();
    ["bad one", "aaaa", "bbbb"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(1000);
    out.mergeAfterError = s.engine.spoken;

    // An engine error on a merged utterance loses all its units; the index is the first unit's; the queue goes on.
    s = setup();
    ["aaaa", "interrupted one", "last one"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(1000);
    s.queue.enqueue("dddd");
    s.clock.tick(1000);
    out.batchError = s.events.filter((e) => e.type !== "requested").map((e) => [e.type, e.index, e.units ?? null, e.code ?? null]);

    // cancel() during a merged utterance: one cancelled, nothing more spoken, its late end ignored.
    s = setup();
    ["aaaa", "bbbb", "cccc", "dddd"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(30);
    s.queue.cancel();
    s.clock.tick(1000);
    out.cancelBatch = { events: s.events.map((e) => [e.t, e.type, e.index ?? null]), spoken: s.engine.spoken, cancels: s.engine.cancels };

    // drop(): what has not become audible is dropped, silently; what is audible plays on. `fresh` counts the units queued
    // since the last drop() (or the turn start), `sentences` all the turn's units.
    s = setup();
    ["aaaa", "bbbb", "cccc"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(12); // aaaa is audible
    out.dropWaiting = { dropped: s.queue.drop(), cancels: s.engine.cancels, sentences: s.queue.sentences, fresh: s.queue.fresh };
    s.clock.tick(1000);
    out.dropWaiting.events = s.events.filter((e) => e.type !== "requested").map((e) => [e.t, e.type, e.index]);
    out.dropWaiting.spoken = s.engine.spoken;

    // An utterance handed to the engine that is not audible yet is dropped too (the engine is told to cancel it), and
    // its late callbacks are ignored. Numbering goes on, and the next audible one is still the turn's first.
    s = setup();
    ["aaaa", "bbbb"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(5);
    out.dropInaudible = { dropped: s.queue.drop(), cancels: s.engine.cancels };
    s.clock.tick(1000);
    out.dropInaudible.quiet = s.events.filter((e) => e.type !== "requested").length;
    s.queue.enqueue("cccc");
    s.clock.tick(1000);
    out.dropInaudible.after = s.events.filter((e) => e.type !== "requested").map((e) => [e.type, e.index, e.first ?? null]);
    out.dropInaudible.requestedIndexes = s.events.filter((e) => e.type === "requested").map((e) => e.index);

    // A merged utterance that is not audible yet counts all its units; chars is the units' own text, no join spaces.
    s = setup();
    ["aaaa", "bbbb", "cccc"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(20); // aaaa ended at 18; "bbbb cccc" was handed then and becomes audible at 28
    out.dropMergedInaudible = { dropped: s.queue.drop(), cancels: s.engine.cancels };

    // An audible merged utterance is left alone; only what waits behind it is dropped.
    s = setup();
    ["aaaa", "bbbb", "cccc"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(30);
    s.queue.enqueue("dddd");
    out.dropBehindMerged = { dropped: s.queue.drop(), cancels: s.engine.cancels };
    s.clock.tick(1000);
    out.dropBehindMerged.spoken = s.engine.spoken;

    // Nothing to drop: zeros, no cancel, no event. `fresh` still restarts.
    s = setup();
    out.dropEmpty = [s.queue.drop(), s.engine.cancels, s.events.length];
    s.queue.enqueue("aaaa");
    s.clock.tick(12);
    out.dropOnlyAudible = { dropped: s.queue.drop(), cancels: s.engine.cancels, fresh: s.queue.fresh, sentences: s.queue.sentences };
    s.queue.enqueue("bbbb");
    out.dropOnlyAudible.freshAfter = s.queue.fresh;

    // `fresh` starts again with the next turn (a stale count would suppress the done fallback there), and on cancel.
    s = setup();
    s.queue.enqueue("aaaa");
    s.queue.enqueue("bbbb");
    const freshDuring = s.queue.fresh;
    s.queue.finish();
    s.clock.tick(1000);
    const freshAfterTurn = s.queue.fresh;
    s.queue.enqueue("cccc");
    s.queue.cancel();
    out.freshTurns = [freshDuring, freshAfterTurn, s.queue.fresh];

    // finish() after a drop still returns the turn's units, and the turn ends once what is audible has played.
    s = setup();
    ["aaaa", "bbbb"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(12);
    s.queue.drop();
    out.finishAfterDrop = s.queue.finish();
    s.clock.tick(1000);
    s.queue.enqueue("cccc");
    s.clock.tick(1000);
    out.nextTurnAfterDrop = s.events.slice(-3).map((e) => [e.type, e.index, e.first ?? null]);

    // --- The first utterance waits up to FIRST_UTTERANCE_WAIT_MS after its first unit is ready (Version A) ---
    out.waitMs = FIRST_UTTERANCE_WAIT_MS;
    s = setupWait();
    s.queue.enqueue("aaaa");
    const w0 = [...s.engine.spoken];
    s.clock.tick(699);
    const w699 = [...s.engine.spoken];
    s.clock.tick(1);
    out.fwBasic = { w0, w699, w700: [...s.engine.spoken], starts: (s.clock.tick(100), starts(s)) };

    // Units that arrive while it waits join the first utterance (in order, joined with a space), which starts at 700.
    s = setupWait();
    s.queue.enqueue("aaaa");
    s.clock.tick(300);
    s.queue.enqueue("bbbb");
    s.clock.tick(300);
    s.queue.enqueue("cccc");
    s.clock.tick(99);
    const j699 = [...s.engine.spoken];
    s.clock.tick(1);
    s.clock.tick(100);
    out.fwJoin = { j699, spoken: s.engine.spoken, starts: starts(s) };

    // done (finish) before the wait is over: it speaks at once, and the timer is gone.
    s = setupWait();
    s.queue.enqueue("aaaa");
    s.clock.tick(100);
    s.queue.enqueue("bbbb");
    out.fwFinish = { before: [...s.engine.spoken], returned: s.queue.finish(), at: [...s.engine.spoken] };
    s.clock.tick(5000);
    out.fwFinish.starts = starts(s);
    out.fwFinish.after = s.engine.spoken;
    // A one-unit reply that finishes in the same tick waited 0 ms.
    s = setupWait();
    s.queue.enqueue("only one");
    s.queue.finish();
    out.fwSameTick = { spoken: [...s.engine.spoken], starts: (s.clock.tick(100), starts(s)) };

    // The cap: a unit that does not fit ends the wait at once, and the one that does not fit is a later utterance.
    s = setupWait();
    s.queue.enqueue("x".repeat(1000));
    s.clock.tick(50);
    const cap0 = s.engine.spoken.length;
    s.queue.enqueue("y".repeat(300));
    out.fwCap = { cap0, atOnce: s.engine.spoken.map((t) => t.length) };
    s.clock.tick(100000);
    out.fwCap.all = s.engine.spoken.map((t) => t.length);
    out.fwCap.starts = starts(s);
    // Exactly the cap (join space counted) is full too: it speaks at once with both units.
    s = setupWait();
    s.queue.enqueue("a".repeat(599));
    s.clock.tick(10);
    s.queue.enqueue("b".repeat(600));
    out.fwCapExact = { atOnce: s.engine.spoken.map((t) => t.length), starts: (s.clock.tick(100000), starts(s)) };
    // One short of the cap is not full: it keeps waiting.
    s = setupWait();
    s.queue.enqueue("a".repeat(599));
    s.clock.tick(10);
    s.queue.enqueue("b".repeat(599));
    out.fwCapShort = { atOnce: s.engine.spoken.length, at700: (s.clock.tick(690), s.engine.spoken.map((t) => t.length)) };

    // drop() during the wait drops the collected units (as it does for waiting units today), the timer is gone, and the next
    // unit starts a new wait.
    s = setupWait();
    ["aaaa", "bbbb"].forEach((t) => s.queue.enqueue(t));
    s.clock.tick(200);
    out.fwDrop = { dropped: s.queue.drop(), cancels: s.engine.cancels };
    s.clock.tick(2000);
    out.fwDrop.quiet = { spoken: [...s.engine.spoken], starts: starts(s).length };
    s.queue.enqueue("cccc");
    s.clock.tick(699);
    out.fwDrop.w699 = [...s.engine.spoken];
    s.clock.tick(1);
    s.clock.tick(100);
    out.fwDrop.starts = starts(s);

    // cancel() during the wait: nothing is spoken, one cancelled event, no leftover timer; the next turn gets a whole new wait.
    s = setupWait();
    s.queue.enqueue("aaaa");
    s.clock.tick(200);
    s.queue.cancel();
    s.clock.tick(2000);
    out.fwCancel = { spoken: [...s.engine.spoken], events: s.events.map((e) => e.type) };
    s.queue.enqueue("bbbb");
    s.clock.tick(699);
    out.fwCancel.w699 = [...s.engine.spoken];
    s.clock.tick(1);
    out.fwCancel.w700 = [...s.engine.spoken];

    // Only the turn's first utterance waits: once audio has started, a unit queued after the queue drained plays at once, and
    // the next turn waits again.
    s = setupWait();
    s.queue.enqueue("aaaa");
    s.clock.tick(700);
    s.queue.enqueue("bbbb");
    s.clock.tick(100);
    s.queue.enqueue("cccc");
    out.fwLater = { atOnce: [...s.engine.spoken], starts: (s.clock.tick(100), starts(s)) };
    s.queue.finish();
    s.clock.tick(100);
    s.queue.enqueue("dddd");
    out.fwLater.nextTurnAtOnce = s.engine.spoken.length;
    s.clock.tick(700);
    out.fwLater.nextTurnAfterWait = s.engine.spoken.length;

    // A tool call (drop) after audio has started does not bring the wait back: the next unit is handed over at once.
    s = setupWait();
    s.queue.enqueue("aaaa");
    s.clock.tick(800); // spoken at 700, audible at 710, ended at 718
    s.queue.drop();
    s.queue.enqueue("bbbb");
    out.fwDropAfterAudio = [...s.engine.spoken];

    // A failed first utterance does not start a second wait for what came next.
    s = setupWait();
    s.queue.enqueue("bad one");
    s.clock.tick(700);
    s.queue.enqueue("good one");
    s.clock.tick(10);
    out.fwError = { spoken: [...s.engine.spoken], t: s.clock.now };

    // The first utterance released by the cap (not by the timer) and then failed: what was left over does not wait again.
    s = setupWait();
    s.queue.enqueue("bad " + "x".repeat(996)); // 1000 chars, fails at 10 ms
    s.queue.enqueue("y".repeat(300)); // does not fit: releases the first at once
    s.clock.tick(10);
    out.fwCapError = { spoken: s.engine.spoken.map((t) => t.length), t: s.clock.now };

    // sentences, fresh and requested events do not wait: they happen at enqueue.
    s = setupWait();
    s.queue.enqueue("aaaa");
    s.queue.enqueue("bbbb");
    out.fwCounts = { sentences: s.queue.sentences, fresh: s.queue.fresh, requested: s.events.filter((e) => e.type === "requested").length };
    return out;
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("sentences play in order, one utterance at a time; the engine only gets the next one when the last has ended", () => {
  assert.deepEqual(r.firstSpoken, ["aaaa"]);
  assert.deepEqual(r.ordered.spoken, ["aaaa", "bbbbbb cc"]); // the first alone, the two that waited merged
  assert.equal(r.ordered.overlaps, 0);
  assert.deepEqual(r.ordered.events, [
    { t: 0, type: "requested", index: 0 },
    { t: 0, type: "requested", index: 1 },
    { t: 0, type: "requested", index: 2 },
    { t: 10, type: "start", index: 0, units: 1, chars: 4, first: true, info: { voice: "V" } },
    { t: 18, type: "end", index: 0 },
    { t: 28, type: "start", index: 1, units: 2, chars: 9, first: false, info: { voice: "V" } },
    { t: 46, type: "end", index: 1 },
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
    { t: 10, type: "start", index: 0, units: 1, chars: 17, first: true, info: { voice: "V" } },
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

test("sentences counts what this turn has queued so far, and starts again after the turn ends or is cancelled", () => {
  assert.deepEqual(r.counts, [0, 2, 0, 1, 0]);
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
    ["start", 1, true, null], // the three that waited are one utterance, whose index is the first unit's
    ["end", 1, null, null],
  ]);
});

test("coalescing: the first unit is spoken alone, the units that waited are one utterance joined with a space, one start and one end for it", () => {
  assert.deepEqual(r.coalesce.spoken, ["aaaa", "bbbb cccc dddd"]);
  assert.equal(r.coalesce.overlaps, 0);
  assert.deepEqual(r.coalesce.events, [
    [0, "requested", 0, null, null, null],
    [0, "requested", 1, null, null, null],
    [0, "requested", 2, null, null, null],
    [0, "requested", 3, null, null, null],
    [10, "start", 0, 1, 4, true],
    [18, "end", 0, null, null, null],
    [28, "start", 1, 3, 14, false],
    [56, "end", 1, null, null, null],
  ]);
  assert.equal(r.finishCoalesced, 4); // units, not utterances
  assert.deepEqual(r.afterCoalesce, [["requested", 0, null, null], ["start", 0, 1, true], ["end", 0, null, null]]);
});

test("coalescing: a unit that arrives after the merged utterance started waits for it and is spoken on its own", () => {
  assert.deepEqual(r.late, ["aaaa", "bbbb cccc", "dddd"]);
});

test("coalescing: the limit is MAX_UTTERANCE_CHARS including the join spaces; exactly the limit fits, one more starts the next utterance", () => {
  assert.equal(r.limit, 1200);
  assert.deepEqual(r.atLimit, [5, r.limit]);
  assert.deepEqual(r.overLimit, [5, 1001, r.limit - 1001]);
});

test("coalescing: a unit longer than the limit is spoken alone and whole, and nothing is merged into it or after it in the same utterance", () => {
  assert.deepEqual(r.oversized, [5, 2, r.limit + 1, 5]);
});

test("coalescing: 'first alone' means the first utterance handed to the engine, so units that waited behind a failed first one are still merged", () => {
  assert.deepEqual(r.mergeAfterError, ["bad one", "aaaa bbbb"]);
});

test("coalescing: an engine error on a merged utterance is reported once with the first unit's index, and the queue goes on", () => {
  assert.deepEqual(r.batchError, [
    ["start", 0, 1, null],
    ["end", 0, null, null],
    ["error", 1, null, "interrupted"],
    ["start", 3, 1, null],
    ["end", 3, null, null],
  ]);
});

test("coalescing: cancel() during a merged utterance reports one cancelled and ignores that utterance's late end", () => {
  assert.deepEqual(r.cancelBatch.events, [
    [0, "requested", 0], [0, "requested", 1], [0, "requested", 2], [0, "requested", 3],
    [10, "start", 0], [18, "end", 0], [28, "start", 1], [30, "cancelled", null],
  ]);
  assert.deepEqual(r.cancelBatch.spoken, ["aaaa", "bbbb cccc dddd"]);
  assert.equal(r.cancelBatch.cancels, 1);
});

test("drop(): the units that wait are dropped, the audible utterance is not cancelled and plays to its end, and nothing is reported", () => {
  assert.deepEqual(r.dropWaiting.dropped, { units: 2, chars: 8 });
  assert.equal(r.dropWaiting.cancels, 0);
  assert.deepEqual([r.dropWaiting.sentences, r.dropWaiting.fresh], [3, 0]); // all three were queued; none since the drop
  assert.deepEqual(r.dropWaiting.events, [[10, "start", 0], [18, "end", 0]]);
  assert.deepEqual(r.dropWaiting.spoken, ["aaaa"]);
});

test("drop(): an utterance handed to the engine but not audible yet is dropped too, its late callbacks are ignored, and the next audible one is still the turn's first", () => {
  assert.deepEqual(r.dropInaudible.dropped, { units: 2, chars: 8 });
  assert.equal(r.dropInaudible.cancels, 1);
  assert.equal(r.dropInaudible.quiet, 0);
  assert.deepEqual(r.dropInaudible.after, [["start", 2, true], ["end", 2, null]]);
  assert.deepEqual(r.dropInaudible.requestedIndexes, [0, 1, 2]);
});

test("drop(): a merged utterance that is not audible yet counts all its units, with the units' own characters", () => {
  assert.deepEqual(r.dropMergedInaudible.dropped, { units: 2, chars: 8 });
  assert.equal(r.dropMergedInaudible.cancels, 1);
});

test("drop(): an audible merged utterance is left alone; only what waits behind it is dropped", () => {
  assert.deepEqual(r.dropBehindMerged.dropped, { units: 1, chars: 4 });
  assert.equal(r.dropBehindMerged.cancels, 0);
  assert.deepEqual(r.dropBehindMerged.spoken, ["aaaa", "bbbb cccc"]);
});

test("drop() with nothing to drop returns zeros and does nothing; fresh restarts all the same", () => {
  assert.deepEqual(r.dropEmpty, [{ units: 0, chars: 0 }, 0, 0]);
  assert.deepEqual(r.dropOnlyAudible, { dropped: { units: 0, chars: 0 }, cancels: 0, fresh: 0, sentences: 1, freshAfter: 1 });
});

test("finish() after a drop still returns the turn's units, and the turn ends when the audible utterance has played", () => {
  assert.equal(r.finishAfterDrop, 2);
  assert.deepEqual(r.nextTurnAfterDrop, [["requested", 0, null], ["start", 0, true], ["end", 0, null]]);
});

test("fresh counts the units queued this turn and starts again when the turn ends or is cancelled", () => {
  assert.deepEqual(r.freshTurns, [2, 0, 0]);
});

test("the first utterance waits FIRST_UTTERANCE_WAIT_MS (700) after its first unit is ready, then speaks, with waited 700 on its start", () => {
  assert.equal(r.waitMs, 700);
  assert.deepEqual(r.fwBasic.w0, []);
  assert.deepEqual(r.fwBasic.w699, []);
  assert.deepEqual(r.fwBasic.w700, ["aaaa"]);
  assert.deepEqual(r.fwBasic.starts, [{ t: 710, index: 0, units: 1, chars: 4, first: true, waited: 700 }]);
});

test("units that arrive during the wait are collected into the first utterance, in order, joined with a space", () => {
  assert.deepEqual(r.fwJoin.j699, []);
  assert.deepEqual(r.fwJoin.spoken, ["aaaa bbbb cccc"]);
  assert.deepEqual(r.fwJoin.starts, [{ t: 710, index: 0, units: 3, chars: 14, first: true, waited: 700 }]);
});

test("done (finish) during the wait speaks at once, with the waited time, and the timer does not speak again", () => {
  assert.deepEqual(r.fwFinish.before, []);
  assert.equal(r.fwFinish.returned, 2);
  assert.deepEqual(r.fwFinish.at, ["aaaa bbbb"]);
  assert.deepEqual(r.fwFinish.starts, [{ t: 110, index: 0, units: 2, chars: 9, first: true, waited: 100 }]);
  assert.deepEqual(r.fwFinish.after, ["aaaa bbbb"]);
  assert.deepEqual(r.fwSameTick.spoken, ["only one"]);
  assert.equal(r.fwSameTick.starts[0].waited, 0);
});

test("a unit that does not fit under MAX_UTTERANCE_CHARS ends the wait at once and is a later utterance", () => {
  assert.equal(r.fwCap.cap0, 0); // 50 ms in, still waiting
  assert.deepEqual(r.fwCap.atOnce, [1000]);
  assert.deepEqual(r.fwCap.all, [1000, 300]);
  assert.deepEqual(r.fwCap.starts.map((x) => [x.units, x.waited]), [[1, 50], [1, null]]);
});

test("exactly the cap (join space counted) is full and speaks at once with both units; one short of it keeps waiting", () => {
  assert.deepEqual(r.fwCapExact.atOnce, [1200]);
  assert.deepEqual(r.fwCapExact.starts[0], { t: 20, index: 0, units: 2, chars: 1200, first: true, waited: 10 });
  assert.equal(r.fwCapShort.atOnce, 0);
  assert.deepEqual(r.fwCapShort.at700, [1199]);
});

test("drop() during the wait drops the collected units and the timer; the next unit starts a new 700 ms wait", () => {
  assert.deepEqual(r.fwDrop.dropped, { units: 2, chars: 8 });
  assert.equal(r.fwDrop.cancels, 0); // nothing was with the engine
  assert.deepEqual(r.fwDrop.quiet, { spoken: [], starts: 0 });
  assert.deepEqual(r.fwDrop.w699, []);
  assert.deepEqual(r.fwDrop.starts.map((x) => [x.index, x.waited]), [[2, 700]]);
});

test("cancel() during the wait speaks nothing, reports one cancelled, and the next turn gets a whole new wait", () => {
  assert.deepEqual(r.fwCancel.spoken, []);
  assert.deepEqual(r.fwCancel.events, ["requested", "cancelled"]);
  assert.deepEqual(r.fwCancel.w699, []);
  assert.deepEqual(r.fwCancel.w700, ["bbbb"]);
});

test("only the turn's first utterance waits: later units are not delayed, and the next turn waits again", () => {
  assert.deepEqual(r.fwLater.atOnce, ["aaaa", "bbbb", "cccc"]);
  assert.deepEqual(r.fwLater.starts.map((x) => x.waited), [700, null, null]);
  assert.equal(r.fwLater.nextTurnAtOnce, 3);
  assert.equal(r.fwLater.nextTurnAfterWait, 4);
});

test("a failed first utterance does not start a second wait for what came next", () => {
  assert.deepEqual(r.fwError.spoken, ["bad one", "good one"]);
  assert.equal(r.fwError.t, 710);
});

test("sentences, fresh and requested events count at enqueue, not after the wait", () => {
  assert.deepEqual(r.fwCounts, { sentences: 2, fresh: 2, requested: 2 });
});

test("a tool call after audio has started does not bring the wait back", () => {
  assert.deepEqual(r.fwDropAfterAudio, ["aaaa", "bbbb"]);
});

test("a first utterance released by the cap that then fails does not make the next unit wait", () => {
  assert.deepEqual(r.fwCapError.spoken, [1000, 300]);
  assert.equal(r.fwCapError.t, 10);
});
