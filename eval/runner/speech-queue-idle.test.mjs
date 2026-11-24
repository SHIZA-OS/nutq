// Tests the two things src/speech-queue.ts gives the hands-free loop: `idle` (nothing playing, nothing waiting, the units held back for
// the first utterance included) and the `onDrained` callback (a finished turn has nothing left to say). Real module in Node, with a fake
// engine and a fake clock. Runs with the rest of the suite via `npm test`.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./load-ts.mjs";

let Q;
before(async () => {
  Q = await loadTs("speech-queue");
});

// An utterance becomes audible 5 ms after speak() and ends 50 ms after it; text starting "bad" fails at once instead.
function setup(firstWaitMs = 0) {
  let now = 0;
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => now,
  };
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
    }
    now = end;
  };
  const engine = {
    name: "fake",
    cancels: 0,
    speak(text, onStart, onEnd, onError) {
      if (text.startsWith("bad")) clock.setTimeout(() => onError("synthesis-failed"), 5);
      else {
        clock.setTimeout(() => onStart({}), 5);
        clock.setTimeout(onEnd, 50);
      }
    },
    cancel() {
      this.cancels++;
    },
  };
  const drained = [];
  const queue = new Q.SpeechQueue(engine, () => {}, { firstWaitMs, timers: clock, onDrained: () => drained.push(now) });
  return { queue, tick, drained, now: () => now };
}

test("idle: true when nothing was queued, false while a unit waits or an utterance plays, true again between sentences", () => {
  const s = setup();
  assert.equal(s.queue.idle, true);
  s.queue.enqueue("one");
  assert.equal(s.queue.idle, false, "handed to the engine, playing");
  s.tick(60);
  assert.equal(s.queue.idle, true, "the sentence ended and the turn is not finished: idle, which is why the caller asks it at the done");
});

test("idle is false for units held back for the first utterance, and the wait ends at the done", () => {
  const s = setup(700);
  s.queue.enqueue("one");
  assert.equal(s.queue.idle, false);
  s.tick(699);
  assert.equal(s.queue.idle, false);
  s.queue.finish(); // done: released at once, now playing
  assert.equal(s.queue.idle, false);
  assert.deepEqual(s.drained, []);
  s.tick(60);
  assert.equal(s.queue.idle, true);
  assert.deepEqual(s.drained, [699 + 50], "the utterance went to the engine at 699 and ends 50 ms later");
});

test("onDrained: once, when the last utterance of a finished turn ends; never before", () => {
  const s = setup();
  s.queue.enqueue("one"); // plays at once (no first-utterance wait here), ends at 50
  s.queue.enqueue("two"); // waits for it, then plays 50 to 100
  s.queue.finish();
  s.tick(30);
  assert.deepEqual(s.drained, []);
  s.tick(30); // 60: the first has ended, the second is playing
  assert.deepEqual(s.drained, []);
  assert.equal(s.queue.idle, false);
  s.tick(50);
  assert.deepEqual(s.drained, [100]);
});

test("onDrained: not for a turn that was never finished, and not for cancel()", () => {
  const s = setup();
  s.queue.enqueue("one");
  s.tick(60);
  assert.deepEqual(s.drained, [], "the turn is not finished: more sentences may come");
  const c = setup();
  c.queue.enqueue("one");
  c.queue.finish();
  c.queue.cancel();
  c.tick(100);
  assert.deepEqual(c.drained, []);
  assert.equal(c.queue.idle, true);
});

test("onDrained: at once for a finished turn with nothing queued, after a failed utterance too, and once per turn", () => {
  const s = setup();
  s.queue.finish();
  assert.deepEqual(s.drained, [0]);
  s.queue.enqueue("bad voice");
  s.queue.finish();
  s.tick(10);
  assert.deepEqual(s.drained, [0, 5], "a failed utterance still ends the turn");
  s.queue.enqueue("next");
  s.queue.finish();
  s.tick(100);
  assert.equal(s.drained.length, 3);
});
