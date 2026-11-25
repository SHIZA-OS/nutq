// Tests src/listen-loop.ts, the hands-free loop, in Node (the real module, no copy of the logic here). Time is a plain number the
// test passes in. Runs with the rest of the suite via `npm test`.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./load-ts.mjs";

let M; // the module
let Q; // src/speech-queue.ts, for the cases that need the real "is speech idle" answer

before(async () => {
  M = await loadTs("listen-loop");
  Q = await loadTs("speech-queue");
});

const mk = () => new M.ListenLoop();
const armed = () => {
  const l = mk();
  l.setOn(true);
  return l;
};
const opening = () => {
  const l = armed();
  l.tap(0, false);
  return l;
};
const listening = (at = 0) => {
  const l = opening();
  l.micLive(at);
  return l;
};
const waiting = () => {
  const l = listening();
  l.finished("sent", "manual", 1);
  return l;
};
const speaking = () => {
  const l = waiting();
  l.turnEnd("done", false, 10);
  return l;
};
const reopening = (at = 10) => {
  const l = waiting();
  l.turnEnd("done", true, at);
  return l;
};
const ON_STATES = { armed, opening, listening, waiting, speaking, reopening };

test("the two delays are the stated judgements", () => {
  assert.equal(M.REOPEN_GUARD_MS, 300);
  assert.equal(M.IDLE_STOP_MS, 10000);
});

test("off by default; toggling on arms the loop, toggling on again changes nothing", () => {
  const l = mk();
  assert.equal(l.state, "off");
  assert.equal(l.on, false);
  l.setOn(true);
  assert.equal(l.state, "armed");
  l.setOn(true);
  assert.equal(l.state, "armed");
  assert.equal(l.on, true);
});

test("toggling off from any state goes to off, with no action and no timer", () => {
  for (const [name, make] of Object.entries(ON_STATES)) {
    const l = make();
    l.setOn(false);
    assert.equal(l.state, "off", name);
    assert.equal(l.nextAt(), null, name);
  }
});

test("while off every event is ignored", () => {
  const l = mk();
  assert.deepEqual(
    [l.tap(0, false), l.speechStart(), l.micLive(0), l.finished("sent", "manual", 0), l.turnEnd("done", true, 0), l.speechDrained(0), l.sent(), l.tick(1e9), l.socketClosed(), l.fault()],
    [undefined, undefined, null, [], [], [], undefined, [], [], []],
  );
  assert.equal(l.state, "off");
  assert.equal(l.nextAt(), null);
});

test("armed: the first tap starts opening the mic, a tap while the mic is already open (tap mode) does not", () => {
  const a = armed();
  a.tap(0, false);
  assert.equal(a.state, "opening");
  const b = armed();
  b.tap(0, true);
  assert.equal(b.state, "armed");
});

test("armed ignores turn ends, drains, ticks and finishes", () => {
  const l = armed();
  assert.deepEqual([l.turnEnd("done", true, 0), l.speechDrained(0), l.tick(1e9), l.finished("sent", "manual", 0), l.micLive(0)], [[], [], [], [], null]);
  assert.equal(l.state, "armed");
});

test("opening: mic live goes to listening; the first start is not a reopen", () => {
  const l = opening();
  assert.deepEqual(l.micLive(100), { reopenDelayMs: null });
  assert.equal(l.state, "listening");
  assert.equal(l.nextAt(), 100 + M.IDLE_STOP_MS);
});

test("opening: a mic failure turns the loop off, a tap before the mic is live then an empty result turns it off", () => {
  const a = opening();
  a.fault();
  assert.equal(a.state, "armed");
  const b = opening();
  b.tap(5, true);
  assert.equal(b.state, "opening");
  assert.deepEqual(b.finished("empty", "manual", 6), []);
  assert.equal(b.state, "armed");
});

test("listening: 10 s without a speech start stops listening, once, and the loop stays on", () => {
  const l = listening(1000);
  assert.deepEqual(l.tick(1000 + M.IDLE_STOP_MS - 1), []);
  assert.equal(l.state, "listening");
  assert.deepEqual(l.tick(1000 + M.IDLE_STOP_MS), [{ type: "idle_stop" }]);
  assert.equal(l.state, "armed");
  assert.equal(l.on, true);
  assert.deepEqual(l.tick(1e9), []);
  l.tap(1e9, false); // the next tap restarts the loop
  assert.equal(l.state, "opening");
});

test("listening: a speech start suspends the idle timer", () => {
  const l = listening(0);
  l.speechStart();
  assert.equal(l.nextAt(), null);
  assert.deepEqual(l.tick(1e9), []);
  assert.equal(l.state, "listening");
});

test("listening: a sent or held utterance goes to waiting", () => {
  for (const result of ["sent", "held"]) {
    const l = listening();
    assert.deepEqual(l.finished(result, "auto_silence", 5), []);
    assert.equal(l.state, "waiting", result);
    assert.equal(l.nextAt(), null);
  }
});

test("listening: an empty or noise result by auto-silence listens again at once and the idle timer keeps counting", () => {
  const l = listening(1000);
  l.speechStart(); // noise that started speech
  assert.deepEqual(l.finished("empty", "auto_silence", 6000), [{ type: "open" }]);
  assert.equal(l.state, "opening");
  l.micLive(6100);
  assert.equal(l.state, "listening");
  assert.equal(l.nextAt(), 1000 + M.IDLE_STOP_MS, "still counted from the first live moment");
  assert.deepEqual(l.tick(1000 + M.IDLE_STOP_MS), [{ type: "idle_stop" }]);
});

test("listening: a tap with speech captured sends and the loop continues; a tap with nothing captured turns the loop off", () => {
  const sent = listening();
  sent.tap(3, true);
  assert.equal(sent.nextAt(), null, "no idle stop while the tap is being finished");
  assert.deepEqual(sent.finished("sent", "manual", 4), []);
  assert.equal(sent.state, "waiting");
  const empty = listening();
  empty.tap(3, true);
  assert.deepEqual(empty.finished("empty", "manual", 4), []);
  assert.equal(empty.state, "armed");
});

test("listening: a result that could not be sent turns the loop off", () => {
  const l = listening();
  assert.deepEqual(l.finished("none", "auto_silence", 4), []);
  assert.equal(l.state, "armed");
});

test("listening: a done that arrives while the user is speaking changes nothing", () => {
  const l = listening();
  assert.deepEqual(l.turnEnd("done", true, 5), []);
  assert.equal(l.state, "listening");
});

test("aborted and every terminal error turn the loop off from any state with the loop running, and an open mic is left to tap mode", () => {
  for (const kind of ["aborted", "error"]) {
    for (const [name, make] of Object.entries(ON_STATES)) {
      if (name === "armed") continue;
      const l = make();
      const past = name === "speaking" || name === "reopening"; // those two states are past their turn end already
      // The loop going off is reported once, as a pause the page tells the user about; a turn end that changes nothing says nothing.
      assert.deepEqual(l.turnEnd(kind, true, 50), past ? [] : [{ type: "paused", reason: "agent_error" }], `${kind} in ${name}`);
      assert.equal(l.state, past ? name : "armed", `${kind} in ${name}`);
    }
  }
});

test("waiting: done with the speech idle starts the guard; the mic is not reopened before it ends", () => {
  const l = waiting();
  assert.deepEqual(l.turnEnd("done", true, 1000), []);
  assert.equal(l.state, "reopening");
  assert.equal(l.nextAt(), 1000 + M.REOPEN_GUARD_MS);
  assert.deepEqual(l.tick(1000 + M.REOPEN_GUARD_MS - 1), []);
  assert.equal(l.state, "reopening");
  assert.deepEqual(l.tick(1000 + M.REOPEN_GUARD_MS), [{ type: "open" }]);
  assert.equal(l.state, "opening");
});

test("waiting: done while speech is still queued or playing waits for the drain, however long that takes", () => {
  const l = waiting();
  l.turnEnd("done", false, 1000);
  assert.equal(l.state, "speaking");
  assert.equal(l.nextAt(), null);
  assert.deepEqual(l.tick(1000 + 1e9), [], "no reopen while the queue has not drained");
  assert.equal(l.state, "speaking");
  assert.deepEqual(l.speechDrained(5000), []);
  assert.equal(l.state, "reopening");
  assert.equal(l.nextAt(), 5000 + M.REOPEN_GUARD_MS, "the guard runs from the drain, not from the done");
  assert.deepEqual(l.tick(5000 + M.REOPEN_GUARD_MS), [{ type: "open" }]);
});

test("a drain outside the speaking state is ignored (a drain before the done, or a late one)", () => {
  for (const make of [waiting, listening, opening, reopening]) {
    const l = make();
    const before = l.state;
    assert.deepEqual(l.speechDrained(1), []);
    assert.equal(l.state, before);
  }
});

test("waiting and speaking: a tap (the mute) opens the mic at once", () => {
  for (const make of [waiting, speaking, reopening]) {
    const l = make();
    l.tap(77, false);
    assert.equal(l.state, "opening");
    assert.equal(l.nextAt(), null, "the guard is gone");
  }
});

test("the reopen delay is measured from the moment the turn was fully over to the mic being live", () => {
  const a = reopening(1000);
  a.tick(1000 + M.REOPEN_GUARD_MS);
  assert.deepEqual(a.micLive(1000 + 412), { reopenDelayMs: 412 });
  const b = speaking();
  b.speechDrained(2000);
  b.tick(2000 + M.REOPEN_GUARD_MS);
  assert.deepEqual(b.micLive(2350), { reopenDelayMs: 350 });
  const c = waiting();
  c.tap(3000, false); // a mute tap
  assert.deepEqual(c.micLive(3040), { reopenDelayMs: 40 });
  const d = listening();
  d.speechStart();
  d.finished("empty", "auto_silence", 4000);
  assert.deepEqual(d.micLive(4060), { reopenDelayMs: 60 });
});

test("reopening: a held message sent at the turn end goes back to waiting and cancels the guard", () => {
  const l = reopening();
  l.sent();
  assert.equal(l.state, "waiting");
  assert.equal(l.nextAt(), null);
  assert.deepEqual(l.tick(1e9), []);
  const s = speaking();
  s.sent();
  assert.equal(s.state, "waiting");
});

test("a done after the turn is already over changes nothing", () => {
  for (const make of [speaking, reopening]) {
    const l = make();
    const before = l.state;
    assert.deepEqual(l.turnEnd("done", true, 99), []);
    assert.equal(l.state, before);
  }
});

test("socket close or the reply timeout: the loop turns off, and a mic the loop opened is stopped without sending", () => {
  for (const name of ["opening", "listening"]) {
    const l = ON_STATES[name]();
    assert.deepEqual(l.socketClosed(), [{ type: "stop" }], name);
    assert.equal(l.state, "armed", name);
  }
  for (const name of ["waiting", "speaking", "reopening"]) {
    const l = ON_STATES[name]();
    assert.deepEqual(l.socketClosed(), [], name);
    assert.equal(l.state, "armed", name);
    assert.equal(l.nextAt(), null, name);
  }
  const a = armed();
  assert.deepEqual(a.socketClosed(), [], "a mic open in tap mode is not the loop's to stop");
  assert.equal(a.state, "armed");
});

test("a fault (mic failure, transcriber error) turns a running loop off, clears its timer and is reported as a pause", () => {
  for (const [name, make] of Object.entries(ON_STATES)) {
    const l = make();
    assert.deepEqual(l.fault(), name === "armed" ? [] : [{ type: "paused", reason: "mic" }], name);
    assert.equal(l.state, "armed", name);
    assert.equal(l.nextAt(), null, name);
  }
  assert.deepEqual(mk().fault(), [], "off stays off, with nothing to report");
  const l = armed();
  l.fault();
  assert.deepEqual(l.fault(), [], "a second fault in the stopped loop says nothing again");
});

test("three turns in a row cycle listening, waiting, speaking and back", () => {
  const l = armed();
  l.tap(0, false);
  const seen = [l.state];
  let t = 0;
  for (let i = 0; i < 3; i++) {
    l.micLive((t += 10));
    seen.push(l.state);
    l.finished("sent", "auto_silence", (t += 10));
    seen.push(l.state);
    l.turnEnd("done", false, (t += 10));
    seen.push(l.state);
    l.speechDrained((t += 10));
    seen.push(l.state);
    assert.deepEqual(l.tick((t += M.REOPEN_GUARD_MS)), [{ type: "open" }]);
    seen.push(l.state);
  }
  assert.deepEqual(seen, ["opening", ...Array(3).fill(["listening", "waiting", "speaking", "reopening", "opening"]).flat()]);
});

// The real speech queue decides "speech is idle" in the page. These cases tie the two together: whatever the queue says is what the
// loop is told, so the loop never reopens while the queue is playing, holding units for the first utterance, or has units waiting.
function queueWithClock(firstWaitMs) {
  let now = 0;
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }) && timers[timers.length - 1],
    clearTimeout: (t) => timers.splice(timers.indexOf(t), 1),
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
  const ends = [];
  const engine = { name: "fake", speak: (_t, onStart, onEnd) => { clock.setTimeout(() => onStart({}), 5); clock.setTimeout(onEnd, 50); }, cancel() {} };
  const loop = armed();
  loop.tap(0, false);
  loop.micLive(0);
  loop.finished("sent", "manual", 0); // waiting
  const queue = new Q.SpeechQueue(engine, () => {}, { firstWaitMs, timers: clock, onDrained: () => ends.push(now) });
  return { loop, queue, tick, now: () => now, ends };
}

test("never during the first-utterance wait: done with units held back is not idle, so the loop waits for the drain", () => {
  const x = queueWithClock(700);
  x.queue.enqueue("one."); // held back for more units
  assert.equal(x.queue.idle, false, "units waiting for the first utterance");
  x.queue.finish(); // done arrived: the wait is released and the sentence goes to the engine
  x.loop.turnEnd("done", x.queue.idle, x.now());
  assert.equal(x.loop.state, "speaking");
  assert.deepEqual(x.loop.tick(x.now() + 10_000), []);
  x.tick(60); // the utterance ends, the queue drains
  assert.equal(x.ends.length, 1);
  x.loop.speechDrained(x.now());
  assert.equal(x.loop.state, "reopening");
});

test("a reply with nothing to say is idle at the done, so the guard starts at once", () => {
  const x = queueWithClock(700);
  x.queue.finish();
  assert.equal(x.queue.idle, true);
  x.loop.turnEnd("done", x.queue.idle, 0);
  assert.equal(x.loop.state, "reopening");
});
