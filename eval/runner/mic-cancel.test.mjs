// Tests that tapping the mic button to start listening cancels speech and reports tts_cancelled { reason: "mic_press" },
// and, when a reply is still in flight, mutes the rest of it (tts_muted), with ?tts_stream=1 and without, against a
// local stub gateway and the real page in headless Chrome. The Transcriber
// module is replaced in the page by a minimal fake (served by route interception) and getUserMedia by a fake stream, so
// the mic button works with no speech model, no microphone and no network. speechSynthesis.speak and cancel are
// recorders and the test fires the utterance callbacks itself. Runs with the rest of the suite via `npm test`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let server;
let client = null;
const r = {};

const frame = (obj) => {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
};

const FAKE_TRANSCRIBER = `export class Transcriber {
  constructor(model, callbacks) { this.callbacks = callbacks; window.__tcb = callbacks; }
  async load() {}
  attachStream() {}
  async start() {}
  // A transcript is committed on stop only when the test asks, so a stop sends a message (a reply in flight).
  async stop() { if (window.__stopDelay) await new Promise((r) => setTimeout(r, window.__stopDelay)); if (window.__commitOnStop) this.callbacks.onTranscriptionCommitted("hello there"); }
}`;

async function openPage(query) {
  const page = await context.newPage();
  await page.route(/\/src\/vendor\/transcriber\.ts/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_TRANSCRIBER }));
  await page.addInitScript(() => {
    window.__sp = { utterances: [], cancels: 0 };
    window.__commitOnStop = false;
    // A fake clock: the page's Date.now only moves when the test says so.
    window.__now = 1000000;
    Date.now = () => window.__now;
    window.speechSynthesis.speak = (u) => window.__sp.utterances.push(u);
    window.speechSynthesis.cancel = () => window.__sp.cancels++;
    navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [{ getSettings: () => ({}) }] });
  });
  await page.goto(`${vite.url}?${query}`);
  await page.fill("#ws-url", `ws://127.0.0.1:${server.address().port}/ws/chat`);
  await page.fill("#agent-alias", "stub");
  await page.fill("#auth-token", "stub-token");
  await page.click("#connect-btn");
  await page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("connected"), null, { timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: 15000 });
  const send = async (obj) => {
    client.write(frame(obj));
    await page.waitForTimeout(150);
  };
  const state = () =>
    page.evaluate(() => ({
      cancels: window.__sp.cancels,
      spoken: window.__sp.utterances.map((u) => u.text),
      hint: document.getElementById("mic-hint").textContent,
      events: [...document.getElementById("log").textContent.matchAll(/EVENT (\{.*\})/g)].map((m) => JSON.parse(m[1])),
    }));
  const fire = (i, kind, code) =>
    page.evaluate(([i, kind, code]) => {
      const u = window.__sp.utterances[i];
      if (kind === "start") u.onstart({});
      else if (kind === "end") u.onend({});
      else u.onerror({ error: code });
    }, [i, kind, code]);
  const mic = async () => {
    await page.click("#mic-btn");
    await page.waitForTimeout(150);
  };
  const advance = (ms) => page.evaluate((ms) => (window.__now += ms), ms);
  // A turn: tap to start listening, tap to stop; the stop commits a transcript, so a message is sent and a reply is in flight.
  // By default the clock then moves on past the re-arm window, so the next tap is a deliberate one; `quick` leaves it at the send.
  const turn = async ({ quick = false } = {}) => {
    await page.evaluate(() => (window.__commitOnStop = true));
    await mic();
    await mic();
    if (!quick) await advance(5000);
  };
  return { page, send, state, fire, mic, turn, advance };
}

const cancelled = (events) => events.filter((e) => e.event === "tts_cancelled").map((e) => e.reason);
const muted = (events) => events.filter((e) => e.event === "tts_muted").map(({ reason, point, chars }) => [reason, point, chars]);
const names = (events, ...of) => events.filter((e) => of.includes(e.event)).map((e) => e.event);

before(async () => {
  server = http.createServer((_, res) => res.end("stub")).listen(0, "127.0.0.1");
  server.on("upgrade", (req, sock) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    client = sock;
    sock.on("data", () => {});
    sock.on("error", () => {});
    sock.write(frame({ type: "session_start", session_id: "stub", resumed: false }));
  });
  await new Promise((res) => server.once("listening", res));
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-miccancel-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  // Flag off: the reply is spoken at done. Tapping the mic cancels it; the browser reports the cancelled utterance
  // afterwards, and that one event carries the reason mic_press.
  let p = await openPage("");
  await p.mic(); // nothing is speaking: speechSynthesis.cancel() is still called, and no event
  r.offIdle = await p.state();
  await p.mic(); // stop listening
  await p.send({ type: "done", full_response: "A reply that is being read out.", tokens_used: 1 });
  await p.fire(0, "start");
  const beforeTap = await p.state();
  await p.mic(); // start listening while it speaks
  await p.fire(0, "error", "canceled"); // the browser's report of the cancelled utterance
  r.offTap = await p.state();
  r.offBefore = beforeTap;
  await p.mic(); // stop listening: must not cancel again
  r.offStop = await p.state();
  // A later cancel that is not the mic (an aborted turn) is back to the plain reason.
  await p.send({ type: "done", full_response: "Another reply to be read out.", tokens_used: 1 });
  await p.fire(1, "start");
  await p.send({ type: "aborted" });
  await p.fire(1, "error", "canceled");
  r.offAborted = await p.state();
  client.destroy();
  await p.page.close();

  // Flag on: the queue reports the cancel itself, at once, with the reason.
  p = await openPage("tts_stream=1");
  await p.send({ type: "chunk", content: "A long enough sentence is here. And another long sentence here. " });
  await p.fire(0, "start");
  const onBefore = await p.state();
  await p.mic();
  await p.fire(0, "end"); // a late end from the cancelled sentence is ignored
  r.onTap = await p.state();
  r.onBefore = onBefore;
  await p.mic(); // stop listening
  r.onStop = await p.state();
  await p.send({ type: "chunk", content: "A fresh sentence after the tap. " });
  await p.fire(1, "start");
  await p.send({ type: "aborted" });
  r.onAborted = await p.state();
  client.destroy();
  await p.page.close();

  // A reply in flight when the mic is tapped. Flag off: nothing is spoken at done, the guard still blocks the user's own
  // utterance, and the next turn speaks normally.
  p = await openPage("");
  await p.turn();
  await p.send({ type: "chunk", content: "Part of the reply. " });
  await p.mic(); // the tap under test: start listening while the reply is in flight
  await p.mic(); // the user "spoke" and stops: the guard blocks the send
  r.offMutedBlocked = await p.state();
  await p.send({ type: "done", full_response: "A reply that should not be spoken.", tokens_used: 1 });
  r.offMuted = await p.state();
  await p.turn(); // the next turn: not muted
  await p.send({ type: "done", full_response: "Second reply, spoken.", tokens_used: 1 });
  r.offNext = await p.state();
  client.destroy();
  await p.page.close();

  // Flag on: a sentence already spoken is cancelled, later chunks and the full_response at done are not spoken.
  p = await openPage("tts_stream=1");
  await p.turn();
  await p.send({ type: "chunk", content: "A long enough sentence is here. " });
  await p.fire(0, "start");
  await p.mic();
  await p.send({ type: "chunk", content: "Another long sentence follows here. " });
  await p.send({ type: "chunk", content: "And a third long sentence too. " });
  r.onMutedChunks = await p.state();
  await p.send({ type: "done", full_response: "A long enough sentence is here. Another long sentence follows here. And a third long sentence too. ", tokens_used: 1 });
  r.onMuted = await p.state();
  await p.mic(); // stop listening: the reply is over, so this sends the next message, and no tap happens during its reply
  await p.send({ type: "chunk", content: "The next turn is spoken. " });
  r.onNext = await p.state();
  client.destroy();
  await p.page.close();

  // Flag on, a tap before any chunk, then only a full_response at done: the fallback does not speak it.
  p = await openPage("tts_stream=1");
  await p.turn();
  await p.mic();
  await p.send({ type: "done", full_response: "  Full reply with no chunks.  ", tokens_used: 1 });
  r.onFallbackMuted = await p.state();
  client.destroy();
  await p.page.close();

  // No reply in flight: a tap does not mute, so an unsolicited chunk is spoken as before.
  p = await openPage("tts_stream=1");
  await p.mic();
  await p.send({ type: "chunk", content: "Not muted, nothing was in flight. " });
  r.onNoFlight = await p.state();
  client.destroy();
  await p.page.close();

  // The mute ends with an aborted turn and with a turn-failure error; the next turn is spoken.
  p = await openPage("tts_stream=1");
  await p.turn();
  await p.mic();
  await p.send({ type: "aborted" });
  await p.mic(); // stop listening: the turn is over, so this sends the next message
  await p.send({ type: "chunk", content: "After the abort, spoken. " });
  r.onAfterAbort = await p.state();
  await p.send({ type: "error", code: "PROVIDER_ERROR", message: "x" }); // a failed turn is cancelled and not read out
  r.onAfterFailure = await p.state();
  client.destroy();
  await p.page.close();

  // A press right after a send is a double tap, not the user taking the floor: it is ignored. The send is at the fake
  // clock's 1000000; the press is 118 ms later (what a live run showed), then 399 ms (still inside) and 400 ms (outside).
  p = await openPage("tts_stream=1");
  await p.turn({ quick: true });
  await p.send({ type: "chunk", content: "A long enough sentence is here. " });
  await p.fire(0, "start");
  const beforeQuick = await p.state();
  await p.advance(118);
  await p.mic();
  r.quick118 = await p.state();
  r.quick118.before = beforeQuick;
  r.quick118.text = await p.page.textContent("#mic-btn");
  await p.send({ type: "chunk", content: "Another long sentence follows here. " });
  await p.fire(0, "end");
  r.quick118.later = await p.state();
  await p.advance(281); // 399 ms since the send
  await p.mic();
  r.quick399 = await p.state();
  await p.advance(1); // 400 ms: the window is over
  await p.mic();
  r.quick400 = await p.state();
  r.quick400.text = await p.page.textContent("#mic-btn");
  await p.send({ type: "chunk", content: "A third long sentence for the muted rest. " });
  r.quick400.after = await p.state();
  await p.advance(10); // 410 ms since the send: the user stops listening again at once; that is a release, never ignored
  await p.mic();
  r.quick400.release = await p.state();
  r.quick400.releaseText = await p.page.textContent("#mic-btn");
  client.destroy();
  await p.page.close();

  // The auto-silence send is a send too.
  p = await openPage("tts_stream=1&silence=800");
  await p.mic(); // start listening
  await p.page.evaluate(() => {
    window.__tcb.onTranscriptionCommitted("hello there");
    window.__tcb.onSpeechStart(4);
    window.__tcb.onSpeechEnd();
  });
  await p.page.waitForFunction(() => document.getElementById("log").textContent.includes('"send_trigger":"auto_silence"'), null, { timeout: 15000 });
  await p.advance(100);
  await p.mic();
  r.autoQuick = await p.state();
  r.autoQuick.text = await p.page.textContent("#mic-btn");
  client.destroy();
  await p.page.close();

  // A press that lands while the previous utterance is still being finished (stop() running) starts a second utterance, and
  // the send then happens with the microphone listening again. The window must not stop the user from ending that one.
  p = await openPage("tts_stream=1");
  await p.page.evaluate(() => { window.__commitOnStop = true; window.__stopDelay = 400; });
  await p.page.click("#mic-btn"); // start listening
  await p.page.click("#mic-btn"); // release: stop() takes 400 ms (real) to finish
  await p.page.click("#mic-btn"); // pressed again while it finishes: a new utterance starts (no send yet, so nothing to ignore)
  await p.page.waitForFunction(() => document.getElementById("log").textContent.includes("ws_message_sent"), null, { timeout: 15000 });
  await p.advance(10);
  await p.page.click("#mic-btn"); // 10 ms after the send, while listening: this is the release, not a double tap
  r.stopWindow = await p.state();
  r.stopWindow.text = await p.page.textContent("#mic-btn");
  client.destroy();
  await p.page.close();

  // No send at all: a press is never ignored, not as the first press and not after an empty utterance that sent nothing.
  p = await openPage("tts_stream=1");
  await p.mic();
  r.noSendFirst = await p.state();
  r.noSendFirst.text = await p.page.textContent("#mic-btn");
  await p.mic(); // release: nothing was heard, so send_skipped and no send
  await p.mic(); // pressed again at once
  r.noSendAgain = await p.state();
  r.noSendAgain.text = await p.page.textContent("#mic-btn");
  client.destroy();
  await p.page.close();

  // A tool call in a muted turn: nothing is dropped or reported, the turn stays muted, and nothing after it is spoken.
  p = await openPage("tts_stream=1");
  await p.turn();
  await p.send({ type: "chunk", content: "A long enough sentence is here. " });
  await p.fire(0, "start");
  await p.mic(); // the tap: cancels what is speaking and mutes the rest of the reply
  const beforeTool = await p.state();
  await p.send({ type: "tool_call", id: "1", name: "search", args: {} });
  await p.send({ type: "chunk", content: "Spoken only if the turn were not muted. " });
  await p.send({ type: "done", full_response: "Spoken only if the turn were not muted. ", tokens_used: 1 });
  r.onToolMuted = await p.state();
  r.onToolMuted.eventsAfterTap = r.onToolMuted.events.slice(beforeTool.events.length);
  client.destroy();
  await p.page.close();
});

after(async () => {
  await context?.close();
  vite?.child.kill();
  client?.destroy();
  server?.close();
});

test("flag off: tapping the mic while a reply is spoken cancels it and the browser's cancelled report is tts_cancelled mic_press", () => {
  assert.equal(r.offTap.cancels - r.offBefore.cancels, 1);
  assert.deepEqual(cancelled(r.offTap.events), ["mic_press"]);
  assert.ok(r.offTap.events.some((e) => e.event === "mic_button_press"));
});

test("flag off: tapping the mic with nothing speaking stops the engine but reports nothing", () => {
  assert.equal(r.offIdle.cancels, 1);
  assert.deepEqual(cancelled(r.offIdle.events), []);
});

test("flag off: stopping the listening does not cancel speech, and a later abort is reported as canceled again", () => {
  assert.equal(r.offStop.cancels, r.offTap.cancels);
  assert.deepEqual(cancelled(r.offStop.events), ["mic_press"]);
  assert.deepEqual(cancelled(r.offAborted.events), ["mic_press", "canceled"]);
});

test("flag on: tapping the mic while a sentence is spoken cancels the queue at once, as one tts_cancelled mic_press", () => {
  assert.equal(r.onTap.cancels - r.onBefore.cancels, 1);
  assert.deepEqual(cancelled(r.onTap.events), ["mic_press"]);
  assert.equal(r.onTap.events.filter((e) => e.event === "tts_end").length, 0); // the late end is ignored
});

test("flag off: a reply in flight when the mic is tapped is not spoken at done; tts_muted point done carries the trimmed reply length", () => {
  assert.deepEqual(r.offMuted.spoken, []);
  assert.deepEqual(muted(r.offMuted.events), [["mic_press", "done", "A reply that should not be spoken.".length]]);
  assert.deepEqual(names(r.offMuted.events, "tts_start", "tts_skipped", "tts_end"), []);
});

test("the in-flight guard is unchanged: the utterance spoken during the muted reply is blocked with the hint", () => {
  assert.deepEqual(names(r.offMutedBlocked.events, "send_blocked"), ["send_blocked"]);
  assert.equal(r.offMutedBlocked.hint, "Still answering, try again");
});

test("flag off: the mute ended with the turn, so the next turn is spoken and not reported muted", () => {
  assert.deepEqual(r.offNext.spoken, ["Second reply, spoken."]);
  assert.equal(muted(r.offNext.events).length, 1); // only the first turn's
});

test("flag on: after the tap the sentence spoken is cancelled and later chunks are not spoken; tts_muted point chunk is reported once", () => {
  assert.equal(r.onMutedChunks.spoken.length, 1);
  assert.deepEqual(muted(r.onMutedChunks.events), [["mic_press", "chunk", "Another long sentence follows here. ".length]]);
  assert.deepEqual(cancelled(r.onMutedChunks.events), ["mic_press"]);
});

test("flag on: at done nothing is spoken, no tail, no fallback, no mismatch; tts_muted point done carries the trimmed full_response length", () => {
  assert.equal(r.onMuted.spoken.length, 1);
  const total = "A long enough sentence is here. Another long sentence follows here. And a third long sentence too.".length;
  assert.deepEqual(muted(r.onMuted.events), [["mic_press", "chunk", "Another long sentence follows here. ".length], ["mic_press", "done", total]]);
  assert.deepEqual(names(r.onMuted.events, "tts_text_mismatch", "tts_skipped"), []);
});

test("flag on: the mute ended with the turn, so the next turn's chunks are spoken", () => {
  assert.equal(r.onNext.spoken.at(-1), "The next turn is spoken.");
});

test("flag on: a tap before any chunk, then only a full_response at done: the fallback does not speak it", () => {
  assert.deepEqual(r.onFallbackMuted.spoken, []);
  assert.deepEqual(muted(r.onFallbackMuted.events), [["mic_press", "done", "Full reply with no chunks.".length]]);
  assert.deepEqual(names(r.onFallbackMuted.events, "tts_requested"), []);
});

test("no reply in flight: a mic tap does not mute", () => {
  assert.deepEqual(r.onNoFlight.spoken, ["Not muted, nothing was in flight."]);
  assert.deepEqual(muted(r.onNoFlight.events), []);
});

test("the mute ends with an aborted turn; a turn-failure error cancels what is being read out (flag on)", () => {
  assert.equal(r.onAfterAbort.spoken.at(-1), "After the abort, spoken.");
  assert.deepEqual(cancelled(r.onAfterFailure.events).slice(-1), ["canceled"]);
  assert.equal(r.onAfterFailure.cancels, r.onAfterAbort.cancels + 1);
});

test("flag on: stopping the listening does not cancel speech, and a later abort is reported as canceled", () => {
  assert.equal(r.onStop.cancels, r.onTap.cancels);
  assert.deepEqual(cancelled(r.onStop.events), ["mic_press"]);
  assert.deepEqual(cancelled(r.onAborted.events), ["mic_press", "canceled"]);
});

test("flag on: a tool call in a muted turn drops nothing and reports nothing; the turn stays muted and nothing more is spoken", () => {
  assert.equal(r.onToolMuted.spoken.length, 1); // only the sentence from before the tap
  assert.deepEqual(names(r.onToolMuted.eventsAfterTap, "tts_dropped", "tts_start", "tts_requested"), []);
  assert.deepEqual(muted(r.onToolMuted.events).map((m) => m[1]), ["chunk", "done"]); // muting still took effect on the chunk and at done
});

const ignored = (events) => events.filter((e) => e.event === "mic_press_ignored").map(({ reason, since_send_ms }) => ({ reason, since_send_ms }));
const presses = (events) => events.filter((e) => e.event === "mic_button_press").length;

test("a press 118 ms after a send is ignored: no listening, no mute, no cancel, and the reply goes on", () => {
  assert.deepEqual(ignored(r.quick118.events), [{ reason: "rearm", since_send_ms: 118 }]);
  assert.equal(presses(r.quick118.events), presses(r.quick118.before.events));
  assert.equal(r.quick118.cancels, r.quick118.before.cancels);
  assert.deepEqual(cancelled(r.quick118.events), []);
  assert.deepEqual(muted(r.quick118.events), []);
  assert.equal(r.quick118.text, "Start listening");
  assert.equal(r.quick118.later.spoken.length, 2); // the next chunk was queued and, once the first ended, spoken
  assert.deepEqual(muted(r.quick118.later.events), []);
});

test("the window is MIC_REARM_MS (400): 399 ms after the send is ignored, 400 ms behaves as today (listens, mutes, cancels)", () => {
  assert.deepEqual(ignored(r.quick399.events), [{ reason: "rearm", since_send_ms: 118 }, { reason: "rearm", since_send_ms: 399 }]);
  assert.equal(presses(r.quick399.events), presses(r.quick118.events));
  assert.equal(ignored(r.quick400.events).length, 2); // nothing new ignored
  assert.equal(presses(r.quick400.events), presses(r.quick399.events) + 1);
  assert.equal(r.quick400.text, "Stop listening");
});

test("a press at the end of the window cancels what is spoken and mutes the rest of the reply, exactly as before", () => {
  assert.deepEqual(cancelled(r.quick400.after.events), ["mic_press"]);
  assert.deepEqual(muted(r.quick400.after.events).map((m) => m[1]), ["chunk"]); // the chunk after the press is shown, not spoken
  assert.equal(r.quick400.after.spoken.length, 2); // nothing new was handed to the browser
});

test("a send by auto_silence opens the same window", () => {
  assert.deepEqual(ignored(r.autoQuick.events), [{ reason: "rearm", since_send_ms: 100 }]);
  assert.equal(presses(r.autoQuick.events), 1); // only the press that started the utterance
  assert.equal(r.autoQuick.text, "Start listening");
});

test("with no send, a press is never ignored: the first press, and a press right after an utterance that sent nothing", () => {
  assert.deepEqual(ignored(r.noSendFirst.events), []);
  assert.equal(r.noSendFirst.text, "Stop listening");
  assert.deepEqual(r.noSendAgain.events.filter((e) => e.event === "send_skipped").map((e) => e.reason), ["empty_transcript"]);
  assert.deepEqual(ignored(r.noSendAgain.events), []);
  assert.equal(presses(r.noSendAgain.events), 2);
  assert.equal(r.noSendAgain.text, "Stop listening");
});

test("the window only guards starting to listen: a stop press shortly after a start is a release and is never ignored", () => {
  assert.equal(r.quick400.release.events.filter((e) => e.event === "mic_button_release").length, 2); // the turn's own and this one
  assert.equal(ignored(r.quick400.release.events).length, 2);
  assert.equal(r.quick400.releaseText, "Start listening");
});

test("a press while listening is a release even inside the window: the window guards only the start of listening", () => {
  assert.deepEqual(ignored(r.stopWindow.events), []);
  assert.equal(r.stopWindow.events.filter((e) => e.event === "mic_button_release").length, 2);
  assert.equal(r.stopWindow.text, "Start listening");
});
