// The microphone stream announcement and the pollen's level meter. src/main.ts dispatches "mic-stream" (detail { stream }) right after
// getUserMedia succeeds and "mic-stream-end" when listening stops or the start failed; src/ui/theme.ts listens, measures the level
// with its own AudioContext and AnalyserNode (read-only, no output) and closes them on stop. Real page in headless Chrome against
// a stub gateway (page-harness.mjs); the microphone is a MediaStream from an oscillator, so the level is known.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./page-harness.mjs";

let h;
const r = {};

// Page-side setup shared by the cases: records both events, wraps AudioContext and AudioNode.connect to see what the page creates
// and wires, and replaces getUserMedia with an oscillator stream (or a refusal).
const pageSetup = ([theme, refuse]) => {
  localStorage.setItem("theme", theme);
  window.__mic = { events: [], contexts: [], connects: [], consoleClosed: 0 };
  for (const name of ["mic-stream", "mic-stream-end"]) window.addEventListener(name, (e) => window.__mic.events.push({ name, stream: e.detail?.stream ?? null }));
  const Native = window.AudioContext;
  window.AudioContext = class extends Native {
    constructor(...a) {
      super(...a);
      window.__mic.contexts.push(this);
    }
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (!this.context.__src) window.__mic.connects.push({ from: this.constructor.name, toDestination: dest === this.context.destination });
    return connect.call(this, dest, ...rest);
  };
  navigator.mediaDevices.getUserMedia = async () => {
    if (refuse) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const c = new Native();
    c.__src = true; // the test's own source of sound, not the page's
    const o = c.createOscillator();
    const d = c.createMediaStreamDestination();
    o.connect(d);
    o.start();
    window.__mic.source = d.stream;
    return d.stream;
  };
};
// The harness hands `init` to addInitScript as is, so the arguments are written into the script text.
const setup = (theme, refuse = false) => ({ content: `(${pageSetup.toString()})(${JSON.stringify([theme, refuse])})` });
const state = (page) =>
  page.evaluate(() => ({
    events: window.__mic.events.map((e) => e.name),
    sameStream: window.__mic.events.filter((e) => e.name === "mic-stream").every((e) => e.stream === window.__mic.source),
    meters: window.__mic.contexts.filter((c) => !c.__src).map((c) => c.state),
    toDestination: window.__mic.connects.filter((c) => c.toDestination).length,
    track: window.__mic.source ? [window.__mic.source.getAudioTracks()[0].readyState, window.__mic.source.getAudioTracks()[0].enabled] : null,
  }));
const level = (page) => page.evaluate(async () => (await import("/src/ui/theme.ts")).pollenLevel());

before(async () => {
  h = await startHarness();

  // SHIZA theme: a real press and release.
  let p = await h.openPage("", { init: setup("shiza") });
  const closedLogs = [];
  p.page.on("console", (m) => m.text().includes("mic level meter closed") && closedLogs.push(m.text()));
  await p.commitOnStop();
  await p.texts("one", "two");
  r.before = await state(p.page);
  await p.mic(); // start listening
  await p.page.waitForFunction(() => window.__mic.contexts.some((c) => !c.__src && c.state === "running"), null, { timeout: 4000 }).catch(() => {});
  await p.page.waitForTimeout(500);
  r.listening = { ...(await state(p.page)), level: await level(p.page), canvas: await p.page.evaluate(() => document.documentElement.dataset.canvas) };
  await p.mic(); // release
  await p.page.waitForTimeout(300);
  r.stopped = { ...(await state(p.page)), logs: [...closedLogs] };
  await p.page.waitForTimeout(1500);
  r.decayed = await level(p.page);
  await p.advance(5000);
  await p.mic();
  await p.page.waitForTimeout(400);
  await p.mic();
  await p.page.waitForTimeout(400);
  r.second = { ...(await state(p.page)), logs: [...closedLogs] };

  // ZeroClaw theme: the same press, and no meter at all.
  p = await h.openPage("", { init: setup("zeroclaw") });
  await p.commitOnStop();
  await p.mic();
  await p.page.waitForTimeout(500);
  r.zeroclaw = { ...(await state(p.page)), level: await level(p.page) };
  await p.mic();

  // The microphone is refused: no stream to announce, but the end is announced.
  p = await h.openPage("", { init: setup("shiza", true) });
  await p.mic();
  await p.page.waitForTimeout(300);
  r.refused = { ...(await state(p.page)), hint: (await p.state()).hint };
});

after(async () => {
  await h?.close();
});

test("nothing is announced before the first press", () => {
  assert.deepEqual(r.before.events, []);
  assert.deepEqual(r.before.meters, []);
});

test("a press announces the stream it opened, once, and the pollen opens its own meter on it", () => {
  assert.deepEqual(r.listening.events, ["mic-stream"]);
  assert.equal(r.listening.sameStream, true);
  assert.equal(r.listening.canvas, "running");
  assert.deepEqual(r.listening.meters, ["running"]);
});

test("the pollen level follows the stream while listening", () => {
  assert.ok(r.listening.level > 0.5, `level ${r.listening.level} with a full-scale tone`);
});

test("the meter never reaches an output and leaves the stream as it was", () => {
  assert.equal(r.listening.toDestination, 0);
  assert.equal(r.stopped.toDestination, 0);
  assert.deepEqual(r.stopped.track, ["live", true]);
});

test("release announces the end; the meter's AudioContext is closed and logged once", () => {
  assert.deepEqual(r.stopped.events, ["mic-stream", "mic-stream-end"]);
  assert.deepEqual(r.stopped.meters, ["closed"]);
  assert.equal(r.stopped.logs.length, 1);
  assert.match(r.stopped.logs[0], /AudioContext closed/);
});

test("after stopping, the pollen decays to rest", () => {
  assert.ok(r.decayed < 0.05, `level ${r.decayed} a second and a half after stop`);
});

test("a second utterance opens a second meter and closes it too, with one log each", () => {
  assert.deepEqual(r.second.events, ["mic-stream", "mic-stream-end", "mic-stream", "mic-stream-end"]);
  assert.deepEqual(r.second.meters, ["closed", "closed"]);
  assert.equal(r.second.logs.length, 2);
});

test("in the ZeroClaw theme no meter is created and the level stays 0", () => {
  assert.deepEqual(r.zeroclaw.events, ["mic-stream"]);
  assert.deepEqual(r.zeroclaw.meters, []);
  assert.equal(r.zeroclaw.level, 0);
});

test("a refused microphone announces no stream, only the end", () => {
  assert.deepEqual(r.refused.events, ["mic-stream-end"]);
  assert.deepEqual(r.refused.meters, []);
  assert.match(r.refused.hint, /Microphone access is blocked/);
});
