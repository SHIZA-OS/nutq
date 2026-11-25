// Hands-free mode in the real page (headless Chrome, stub gateway): the loop listening, waiting, speaking and listening again; the
// idle stop; a tap; the toggle; a closed socket; the turn endings that do not reopen the mic; and that with the toggle off nothing
// of it shows. The Transcriber is the real one with a stand-in model and VAD, the microphone a stand-in made of real WebAudio
// tracks (hands-free-harness.mjs). The page's clock is the harness's frozen one unless a test says otherwise; the loop's delays are
// real timers (300 ms guard, 10 s idle).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, eventsOf } from "./page-harness.mjs";
import { answer, finishSpeech, mic, openHandsFree, say, waitHint, waitMessages } from "./hands-free-harness.mjs";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});

const HF = "listen=hands-free&silence=800";
const WAIT = "Waiting for the answer";
const LOOP_HINTS = ["Starting the microphone…", "Listening", WAIT, "Speaking the answer", "Getting ready to listen"];
const hints = (p) => p.page.evaluate(() => window.__hints.filter((x, i, a) => x !== a[i - 1])); // consecutive repeats dropped
const log = (p) => p.page.evaluate(() => document.getElementById("log").textContent);
const events = async (p, name) => eventsOf((await p.state()).events, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closeSocket = (p) => h.sockets[p.conn].destroy();

test("three turns in a row: listening, waiting, speaking, listening again, with the mic closed in between", async () => {
  const p = await openHandsFree(h, HF);
  await p.mic(); // the one tap that starts the loop
  await waitHint(p, "Listening");
  for (let i = 1; i <= 3; i++) {
    await say(p, `question ${i}`);
    await waitMessages(h, p, i);
    await waitHint(p, WAIT);
    assert.equal((await mic(p)).live, 0, `turn ${i}: the mic is closed while waiting`);
    await p.send({ type: "chunk", content: "Here is the answer." });
    await p.send({ type: "done", full_response: "Here is the answer.", tokens_used: 1 });
    await waitHint(p, "Speaking the answer");
    assert.equal((await mic(p)).live, 0, `turn ${i}: the mic is closed while speaking`);
    await finishSpeech(p);
    await waitHint(p, "Listening");
    assert.equal((await mic(p)).live, 1, `turn ${i}: the mic is live again`);
  }
  const m = await mic(p);
  assert.deepEqual([m.tracks, m.calls, m.live], [4, 4, 1], "one start per listening run, never a stream kept open across a turn");
  assert.deepEqual(
    (await hints(p)).filter((x) => LOOP_HINTS.includes(x)),
    ["Starting the microphone…", "Listening", ...Array(3).fill([WAIT, "Speaking the answer", "Getting ready to listen", "Starting the microphone…", "Listening"]).flat()],
  );
  assert.deepEqual(h.messages(p.conn).map((x) => x.content.replace(/^.*?(question \d)$/s, "$1")), ["question 1", "question 2", "question 3"]);
  assert.equal((await events(p, "listen_reopen")).length, 3);
  assert.equal((await events(p, "listen_mode")).length, 1);
});

test("Listening is shown only once the mic is live; in tap mode the pill is set earlier, as before", async () => {
  const hf = await openHandsFree(h, HF);
  await hf.page.evaluate(() => { window.__startGate = new Promise((r) => (window.__openStart = r)); }); // not returned: evaluate would wait for it
  await hf.mic(); // the stand-in transcriber's start() is held: the stream is attached, start() has not resolved
  let m = await mic(hf);
  assert.equal(m.hint, "Starting the microphone…");
  assert.notEqual(m.pill, "listening…");
  await hf.page.evaluate(() => window.__openStart());
  await waitHint(hf, "Listening");
  assert.equal((await mic(hf)).pill, "listening…");

  const tap = await openHandsFree(h, ""); // toggle off: the existing timing, kept on purpose in this change
  await tap.page.evaluate(() => { window.__startGate = new Promise((r) => (window.__openStart = r)); });
  await tap.mic();
  m = await mic(tap);
  assert.equal(m.pill, "listening…", "tap mode: the pill comes from onTranscribeStarted, before start() resolves");
  assert.equal(m.hint, "Tap to start listening");
});

test("idle: 10 s with no speech stops listening, says so, and the next tap restarts the loop", async () => {
  const p = await openHandsFree(h, HF);
  await p.mic();
  await waitHint(p, "Listening");
  await waitHint(p, "Stopped listening. Tap to talk.", 13000);
  const m = await mic(p);
  assert.equal(m.live, 0);
  assert.equal(m.switch, "true", "hands-free stays on");
  assert.equal(h.messages(p.conn).length, 0, "nothing was said, nothing is sent");
  assert.equal((await events(p, "listen_idle_stop")).length, 1);
  await p.mic();
  await waitHint(p, "Listening");
  assert.equal((await mic(p)).live, 1);
});

test("a tap while listening: with speech it sends and the loop goes on; with nothing it stops the loop", async () => {
  const a = await openHandsFree(h, HF);
  await a.mic();
  await waitHint(a, "Listening");
  await a.page.evaluate(() => {
    window.__commitOnStop = true;
    window.__texts = ["hello there"];
  });
  await a.mic(); // the stop commits "hello there" and sends it, like a tap-mode release
  await waitMessages(h, a, 1);
  await waitHint(a, WAIT);
  await answer(a);
  await waitHint(a, "Listening");
  assert.equal((await mic(a)).live, 1);

  const b = await openHandsFree(h, HF);
  await b.mic();
  await waitHint(b, "Listening");
  await b.mic(); // nothing was captured
  await sleep(1000);
  const m = await mic(b);
  assert.deepEqual([h.messages(b.conn).length, m.live, m.calls, m.hint], [0, 0, 1, "Tap to start listening"]);
  assert.equal((await events(b, "listen_reopen")).length, 0);
});

test("toggling off mid-turn: no reopen; toggling off while listening: the open mic carries on in tap mode", async () => {
  const a = await openHandsFree(h, HF);
  await a.mic();
  await waitHint(a, "Listening");
  await say(a, "question one");
  await waitMessages(h, a, 1);
  await waitHint(a, WAIT);
  await a.page.click("#hands-free-switch");
  assert.equal((await mic(a)).switch, "false");
  await answer(a);
  await sleep(1000);
  const m = await mic(a);
  assert.deepEqual([m.calls, m.live, m.hint], [1, 0, "Tap to start listening"]);
  assert.equal((await events(a, "listen_reopen")).length, 0);
  assert.deepEqual((await events(a, "listen_mode")).map((e) => e.on), [true, false]);

  const b = await openHandsFree(h, HF);
  await b.mic();
  await waitHint(b, "Listening");
  await b.page.click("#hands-free-switch");
  let n = await mic(b);
  assert.deepEqual([n.live, n.switch], [1, "false"], "the mic stays open");
  await b.page.evaluate(() => {
    window.__commitOnStop = true;
    window.__texts = ["hello there"];
  });
  await b.advance(5000);
  await b.mic(); // tap mode: a release sends
  await waitMessages(h, b, 1);
  await answer(b);
  await sleep(1000);
  n = await mic(b);
  assert.deepEqual([n.calls, n.live], [1, 0], "and nothing reopens it");
});

test("a socket that closes while listening stops the mic without sending, with no Cannot send message", async () => {
  const p = await openHandsFree(h, HF);
  await p.mic();
  await waitHint(p, "Listening");
  await p.page.evaluate(() => {
    window.__commitOnStop = true;
    window.__texts = ["said just before"];
    window.__tcb.onSpeechStart(0); // speech is in progress when the socket goes
  });
  closeSocket(p);
  await p.page.waitForFunction(() => window.__mic.tracks.every((t) => t.readyState === "ended"), null, { timeout: 5000 });
  await sleep(300);
  const text = await log(p);
  assert.equal(h.messages(p.conn).length, 0);
  assert.doesNotMatch(text, /Cannot send/);
  assert.match(text, /Stopped listening, nothing sent/);
  const m = await mic(p);
  assert.deepEqual([m.live, m.switch], [0, "true"], "the toggle stays on, the loop is off");
  assert.doesNotMatch(m.hint, /paused/, "a closed connection has its own messages: it is not reported as an agent or microphone pause");
  assert.equal((await events(p, "listen_reopen")).length, 0);
});

test("a socket that closes while waiting for the answer turns the loop off", async () => {
  const p = await openHandsFree(h, HF);
  await p.mic();
  await waitHint(p, "Listening");
  await say(p, "question one");
  await waitMessages(h, p, 1);
  await waitHint(p, WAIT);
  closeSocket(p);
  await p.page.waitForFunction(() => document.getElementById("conn-status").textContent === "disconnected", null, { timeout: 5000 });
  await sleep(800);
  const m = await mic(p);
  assert.deepEqual([m.calls, m.live], [1, 0]);
  assert.notEqual(m.hint, WAIT);
});

const PAUSED_AGENT = "Hands-free paused: the agent returned an error. Tap to try again.";
const PAUSED_MIC = "Hands-free paused: the microphone stopped. Tap to try again.";

test("aborted and every terminal error turn the loop off, say so, show no reopen, and a tap starts it again", async () => {
  for (const frame of [{ type: "aborted" }, ...["PROVIDER_ERROR", "AUTH_ERROR", "AGENT_ERROR"].map((code) => ({ type: "error", code, message: "no" }))]) {
    const p = await openHandsFree(h, HF);
    await p.mic();
    await waitHint(p, "Listening");
    await say(p, "question one");
    await waitMessages(h, p, 1);
    await waitHint(p, WAIT);
    await p.send(frame);
    await sleep(900);
    const m = await mic(p);
    const what = frame.code ?? frame.type;
    assert.deepEqual([m.calls, m.live, m.hint, m.switch], [1, 0, PAUSED_AGENT, "true"], what);
    assert.equal((await events(p, "listen_reopen")).length, 0, what);
    await p.advance(5000); // past the re-arm window of the send
    await p.mic();
    await waitHint(p, "Listening");
  }
});

test("a microphone that fails to start pauses the loop with its specific hint; a transcriber error, which has none, says the microphone stopped", async () => {
  const a = await openHandsFree(h, HF);
  await a.page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });
  await a.mic();
  const BLOCKED = "Hands-free paused: Microphone access is blocked. Allow the microphone for this site in your browser, then tap the button again.";
  await a.page.waitForFunction((t) => document.getElementById("mic-hint").textContent === t, BLOCKED, { timeout: 4000 });
  let m = await mic(a);
  assert.deepEqual([m.pill, m.switch, m.live], ["microphone unavailable", "true", 0]);

  const b = await openHandsFree(h, HF);
  await b.mic();
  await waitHint(b, "Listening");
  await b.page.evaluate(() => window.__tcb.onError("boom")); // the transcriber reports an error; the mic itself carries on in tap mode
  await b.page.waitForFunction((t) => document.getElementById("mic-hint").textContent === t, PAUSED_MIC, { timeout: 4000 });
  m = await mic(b);
  assert.deepEqual([m.switch, m.live], ["true", 1]);
  await sleep(600);
  assert.equal((await mic(b)).hint, PAUSED_MIC);
  assert.equal((await events(b, "listen_reopen")).length, 0);
});

test("a tap while waiting is the mute: the mic opens at once, the utterance is held and goes out when the turn ends", async () => {
  const p = await openHandsFree(h, HF);
  await p.mic();
  await waitHint(p, "Listening");
  await say(p, "question one");
  await waitMessages(h, p, 1);
  await waitHint(p, WAIT);
  await p.send({ type: "chunk", content: "Part of the answer. " });
  await p.advance(5000);
  await p.mic(); // the tap
  await waitHint(p, "Listening", 3000);
  assert.equal((await events(p, "listen_reopen")).length, 1);
  assert.ok((await p.state()).cancels >= 1, "the reply being spoken was cancelled");
  await say(p, "second words");
  await p.page.waitForFunction(() => document.getElementById("mic-hint").textContent === "Will send when the answer finishes", null, { timeout: 5000 });
  assert.equal(h.messages(p.conn).length, 1, "held, not sent mid-turn");
  await p.send({ type: "done", full_response: "Part of the answer. ", tokens_used: 1 });
  await waitMessages(h, p, 2);
  assert.match(h.messages(p.conn)[1].content, /second words$/);
  await waitHint(p, WAIT);
  await answer(p, "Second answer.");
  await waitHint(p, "Listening");
});

test("a noise result keeps listening: nothing is sent and the mic is started again", async () => {
  const p = await openHandsFree(h, HF);
  await p.mic();
  await waitHint(p, "Listening");
  await p.page.evaluate(() => {
    window.__commitOnStop = false; // the stop commits nothing
    window.__tcb.onSpeechStart(0);
    window.__tcb.onSpeechEnd();
  });
  await p.page.waitForFunction(() => window.__mic.calls === 2, null, { timeout: 6000 });
  await waitHint(p, "Listening");
  assert.equal(h.messages(p.conn).length, 0);
  assert.equal((await events(p, "send_skipped")).length, 1);
  assert.equal((await mic(p)).live, 1);
});

test("the 60 s reply timeout turns the loop off", async () => {
  const p = await openHandsFree(h, HF);
  await p.mic();
  await waitHint(p, "Listening");
  await say(p, "question one");
  await waitMessages(h, p, 1);
  await waitHint(p, WAIT);
  await p.page.evaluate(() => window.__fireLong()); // the reply timer, kept by the harness instead of waiting 60 s
  await sleep(900);
  const m = await mic(p);
  assert.deepEqual([m.calls, m.live], [1, 0]);
  assert.notEqual(m.hint, WAIT);
  assert.equal(m.switch, "true");
});

test("?tts_stream=0: the loop reopens when the whole-reply utterance ends", async () => {
  const p = await openHandsFree(h, `${HF}&tts_stream=0`);
  await p.mic();
  await waitHint(p, "Listening");
  await say(p, "question one");
  await waitMessages(h, p, 1);
  await p.send({ type: "chunk", content: "Here is the answer." });
  await p.send({ type: "done", full_response: "Here is the answer.", tokens_used: 1 });
  await waitHint(p, "Speaking the answer");
  assert.equal((await mic(p)).live, 0);
  await sleep(700);
  assert.equal((await mic(p)).hint, "Speaking the answer", "not before the utterance has ended");
  await finishSpeech(p);
  await waitHint(p, "Listening");
});

// The speaking watchdog (src/listen-loop.ts): the engine's own speaking/pending flags, looked at on the loop's timer while it is speaking.
test("a speech engine that never reports the end still reopens the mic, in both speech modes, and the next turn works", async () => {
  for (const query of [HF, `${HF}&tts_stream=0`]) {
    const p = await openHandsFree(h, query, { real: true }); // the real clock: the watchdog's looks repeat, and a frozen clock would stretch them
    await p.mic();
    await waitHint(p, "Listening");
    await say(p, "question one");
    await waitMessages(h, p, 1);
    await p.send({ type: "chunk", content: "Here is the answer." });
    await p.send({ type: "done", full_response: "Here is the answer.", tokens_used: 1 });
    await waitHint(p, "Speaking the answer");
    const since = Date.now();
    await p.page.evaluate(() => { window.__synth.speaking = false; }); // the engine goes quiet and never fires onend
    await sleep(1000);
    assert.equal((await mic(p)).hint, "Speaking the answer", `${query}: not before the quiet time is up`);
    await waitHint(p, "Listening", 6000);
    const waited = Date.now() - since;
    assert.ok(waited >= 1500 + 300, `${query}: reopened after ${waited} ms, under the quiet time and the guard`);
    assert.match(await log(p), /nothing speaking or pending for 1500 ms/);
    assert.equal((await events(p, "listen_reopen")).length, 1);
    assert.equal((await mic(p)).live, 1);
    await say(p, "question two"); // the queue was reset by the reopen, so the next answer is spoken and ends normally
    await waitMessages(h, p, 2);
    await p.send({ type: "chunk", content: "Second answer." });
    await p.send({ type: "done", full_response: "Second answer.", tokens_used: 1 });
    await waitHint(p, "Speaking the answer");
    await finishSpeech(p);
    await waitHint(p, "Listening");
  }
});

test("an engine that is still speaking, or has something pending, does not reopen the mic however long it takes", async () => {
  const p = await openHandsFree(h, HF, { real: true });
  await p.mic();
  await waitHint(p, "Listening");
  await say(p, "question one");
  await waitMessages(h, p, 1);
  await p.send({ type: "chunk", content: "A long answer." });
  await p.send({ type: "done", full_response: "A long answer.", tokens_used: 1 });
  await waitHint(p, "Speaking the answer");
  await sleep(3500); // well past the quiet time, the engine still speaking
  assert.deepEqual([(await mic(p)).hint, (await mic(p)).calls], ["Speaking the answer", 1]);
  await p.page.evaluate(() => { window.__synth.speaking = false; window.__synth.pending = true; }); // between two utterances: pending only
  await sleep(2500);
  assert.deepEqual([(await mic(p)).hint, (await mic(p)).calls], ["Speaking the answer", 1]);
  await p.page.evaluate(() => { window.__synth.pending = false; });
  await finishSpeech(p); // the end arrives in the usual way
  await waitHint(p, "Listening");
  assert.ok(!(await log(p)).includes("nothing speaking or pending"), "the watchdog did not fire");
});

test("the switch: kept in local storage under listen, set by ?listen=hands-free, and working with storage blocked", async () => {
  const a = await openHandsFree(h, "");
  assert.equal((await mic(a)).switch, "false");
  await a.page.click("#hands-free-switch");
  assert.equal((await mic(a)).switch, "true");
  assert.equal(await a.page.evaluate(() => localStorage.getItem("listen")), "hands-free");
  await a.page.reload();
  assert.equal(await a.page.evaluate(() => document.getElementById("hands-free-switch").getAttribute("aria-checked")), "true");
  await a.page.click("#hands-free-switch");
  assert.equal(await a.page.evaluate(() => localStorage.getItem("listen")), null);

  const b = await openHandsFree(h, "listen=hands-free");
  assert.equal((await mic(b)).switch, "true");
  assert.equal(await b.page.evaluate(() => localStorage.getItem("listen")), null, "the param does not write the saved choice");

  const c = await h.openPage("", {
    init: { content: `(${() => { for (const n of ["localStorage", "sessionStorage"]) Object.defineProperty(window, n, { get: () => { throw new DOMException("blocked", "SecurityError"); } }); window.__errors = []; addEventListener("error", (e) => window.__errors.push(String(e.message))); }})()` },
  });
  await c.page.click("#hands-free-switch");
  assert.equal(await c.page.evaluate(() => document.getElementById("hands-free-switch").getAttribute("aria-checked")), "true");
  assert.deepEqual(await c.page.evaluate(() => window.__errors), []);
});

test("with the toggle off nothing of the loop shows: a whole tap-mode turn, no loop hint, no reopen, no event", async () => {
  const p = await openHandsFree(h, "silence=800");
  await p.page.evaluate(() => {
    window.__commitOnStop = true;
    window.__texts = ["hello there"];
  });
  await p.mic();
  assert.equal((await mic(p)).live, 1);
  await p.mic(); // release sends
  await waitMessages(h, p, 1);
  await answer(p);
  await sleep(1200);
  const m = await mic(p);
  assert.deepEqual([m.calls, m.live, m.switch, m.hint], [1, 0, "false", "Tap to start listening"]);
  assert.deepEqual((await hints(p)).filter((x) => LOOP_HINTS.includes(x)), []);
  assert.deepEqual((await p.state()).events.map((e) => e.event).filter((e) => e.startsWith("listen_")), []);
});
