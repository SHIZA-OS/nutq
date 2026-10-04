// Tests that src/main.ts wires the text-dependent end of turn (?endpoint=semantic) to the Transcriber's
// callbacks, in the real page in headless Chrome served by Vite. The Transcriber is replaced in the page by a
// minimal fake (route interception) and getUserMedia by a fake stream, so there is no speech model, no
// microphone and no gateway (?eval=1&nosend=1). The test fires the Transcriber callbacks itself and reads the
// EVENT lines from the log panel. Runs with the rest of the suite via `npm test`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let W; // SEMANTIC_WAITS, read from the module so the test does not copy placeholder numbers
const r = {};

const FAKE_TRANSCRIBER = `export class Transcriber {
  constructor(model, callbacks) { this.callbacks = callbacks; window.__cb = callbacks; }
  async load() {}
  attachStream() {}
  async start() {}
  async stop() {}
}`;

async function openPage(query) {
  const page = await context.newPage();
  await page.route(/\/src\/vendor\/transcriber\.ts/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_TRANSCRIBER }));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [{ getSettings: () => ({}) }] });
  });
  await page.goto(`${vite.url}?eval=1&nosend=1&${query}`);
  await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: 15000 });
  await page.click("#mic-btn"); // start listening
  await page.waitForFunction(() => window.__cb);
  const cb = (name, ...args) => page.evaluate(([n, a]) => window.__cb[n](...a), [name, args]);
  const events = () =>
    page.evaluate(() => [...document.getElementById("log").textContent.matchAll(/EVENT (\{.*\})/g)].map((m) => JSON.parse(m[1])));
  const only = async (name) => (await events()).filter((e) => e.event === name);
  const endpoint = async () => (await only("endpoint")).map(({ hint, wait_ms, text_chars, commits_in_flight }) => ({ hint, wait_ms, text_chars, commits_in_flight }));
  const final = async (ms) => {
    await page.waitForFunction(() => document.getElementById("log").textContent.includes('"transcript_final"'), null, { timeout: ms }).catch(() => {});
    return (await only("transcript_final"))[0] ?? null;
  };
  return { page, cb, events, only, endpoint, final };
}

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-endpointwiring-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const probe = await context.newPage();
  await probe.goto(vite.url);
  W = await probe.evaluate(async () => (await import("/src/turn-policy.ts")).SEMANTIC_WAITS);
  await probe.close();

  // finished text, then the speech end: the arm event says done, and the turn ends on auto_silence after that wait
  let p = await openPage("endpoint=semantic");
  await p.cb("onSpeechStart", 0);
  await p.cb("onTranscriptionCommitted", "Thank you.");
  await p.cb("onSpeechEnd");
  r.doneEnd = (await p.only("speech_end"))[0];
  r.doneEvents = await p.endpoint();
  r.doneFinal = await p.final(W.done + 3000);
  await p.page.close();

  // no text yet at the speech end, then a commit goes in flight, its open text lands, and the count drops
  p = await openPage("endpoint=semantic");
  await p.cb("onSpeechStart", 0);
  await p.cb("onSpeechEnd");
  await p.cb("onCommitsInFlight", 1);
  await p.cb("onTranscriptionCommitted", "I want a flight and");
  await p.cb("onCommitsInFlight", 0);
  r.openEvents = await p.endpoint();
  await p.page.close();

  // open text arms the long wait; a later piece that finishes the sentence re-arms the timer to the short one
  p = await openPage("endpoint=semantic");
  await p.cb("onSpeechStart", 0);
  await p.cb("onTranscriptionCommitted", "I want a flight and");
  await p.cb("onSpeechEnd");
  await p.page.waitForTimeout(W.done + 400);
  r.openStillWaiting = await p.only("transcript_final");
  await p.cb("onTranscriptionCommitted", "a hotel.");
  r.rearmFinal = await p.final(W.done + 3000);
  await p.page.close();

  // a speech start cancels the wait for good: text that lands later arms nothing and logs nothing
  p = await openPage("endpoint=semantic");
  await p.cb("onSpeechStart", 0);
  await p.cb("onSpeechEnd");
  await p.cb("onSpeechStart", 0);
  const before = (await p.endpoint()).length;
  await p.cb("onTranscriptionCommitted", "Thank you.");
  await p.cb("onCommitsInFlight", 1);
  await p.page.waitForTimeout(W.done + 500);
  r.speakingEvents = [before, (await p.endpoint()).length];
  r.speakingFinal = await p.only("transcript_final");
  await p.page.close();

  // ?silence is a fixed wait that ignores the text, and wins over ?endpoint=semantic
  p = await openPage("endpoint=semantic&silence=900");
  await p.cb("onSpeechStart", 0);
  await p.cb("onTranscriptionCommitted", "and");
  await p.cb("onSpeechEnd");
  r.silenceEnd = (await p.only("speech_end"))[0];
  r.silenceFinal = await p.final(4000);
  r.silenceEvents = await p.endpoint();
  await p.page.close();

  // no ?endpoint: nothing semantic, no endpoint events
  p = await openPage("silence=800");
  await p.cb("onSpeechStart", 0);
  await p.cb("onTranscriptionCommitted", "and");
  await p.cb("onSpeechEnd");
  r.fixedFinal = await p.final(4000);
  r.fixedEvents = await p.endpoint();
  await p.page.close();
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("at the speech end the arm event reports the hint, the wait, the text length and the commits in flight", () => {
  assert.deepEqual(r.doneEvents, [{ hint: "done", wait_ms: W.done, text_chars: "Thank you.".length, commits_in_flight: 0 }]);
});

test("the turn ends on auto_silence about one wait after the speech end, with the committed text", () => {
  assert.equal(r.doneFinal.trigger, "auto_silence");
  assert.equal(r.doneFinal.text, "Thank you.");
  const waited = r.doneFinal.timestamp_ms - r.doneEnd.timestamp_ms;
  assert.ok(waited >= W.done - 50 && waited < W.done + 1500, `waited ${waited} ms for a ${W.done} ms wait`);
});

test("no text at the speech end is unknown; every later change while armed logs the recomputed wait", () => {
  assert.deepEqual(r.openEvents, [
    { hint: "unknown", wait_ms: W.unknown, text_chars: 0, commits_in_flight: 0 },
    { hint: "unknown", wait_ms: W.unknown, text_chars: 0, commits_in_flight: 1 },
    { hint: "open", wait_ms: Math.min(W.open, W.ceiling), text_chars: "I want a flight and".length, commits_in_flight: 1 },
    { hint: "open", wait_ms: Math.min(W.open, W.ceiling), text_chars: "I want a flight and".length, commits_in_flight: 0 },
  ]);
});

test("text that finishes the sentence after the arm re-arms the running timer to the short wait", () => {
  assert.deepEqual(r.openStillWaiting, []); // the open wait is longer than the short one
  assert.equal(r.rearmFinal.trigger, "auto_silence");
  assert.equal(r.rearmFinal.text, "I want a flight and a hotel.");
});

test("a speech start cancels the wait: later text and in-flight changes log nothing and the turn does not end", () => {
  assert.equal(r.speakingEvents[0], 1); // the arm event from the first speech end
  assert.equal(r.speakingEvents[1], 1);
  assert.deepEqual(r.speakingFinal, []);
});

test("?silence wins over ?endpoint=semantic: the fixed wait ends the turn, with no endpoint events", () => {
  assert.equal(r.silenceFinal.trigger, "auto_silence");
  const waited = r.silenceFinal.timestamp_ms - r.silenceEnd.timestamp_ms;
  assert.ok(waited >= 850 && waited < 2500, `waited ${waited} ms for a 900 ms wait`);
  assert.deepEqual(r.silenceEvents, []);
});

test("without ?endpoint nothing semantic runs: the fixed wait applies and no endpoint events are logged", () => {
  assert.equal(r.fixedFinal.trigger, "auto_silence");
  assert.deepEqual(r.fixedEvents, []);
});
