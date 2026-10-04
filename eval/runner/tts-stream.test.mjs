// Tests ?tts_stream=1 in main.ts against a local stub gateway (a minimal WebSocket server, no ZeroClaw) and the real
// page in headless Chrome. speechSynthesis.speak and cancel are replaced in the page by recorders, and the test
// fires the utterance callbacks itself, so nothing is spoken and the timing is exact. The eval events are read from
// the log panel. A message cannot be sent without a microphone and the speech model, so a turn in flight, a failure
// error and the reply timeout are not driven here (see docs/PROGRESS.md). Runs with the rest of the suite via `npm test`.

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
let off; // the page without the flag
let on; // the page with ?tts_stream=1
const r = {};

const frame = (obj) => {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
};

// One page on the stub gateway. The page's utterance callbacks are fired by `fire`; `events` are the eval events so
// far, `spoken` the texts the page asked the browser to speak, `cancels` the speechSynthesis.cancel() calls.
async function openPage(query) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__sp = { utterances: [], cancels: 0 };
    window.speechSynthesis.speak = (u) => window.__sp.utterances.push(u);
    window.speechSynthesis.cancel = () => window.__sp.cancels++;
  });
  await page.goto(`${vite.url}?eval=1&model=zzz${query}`); // an invalid model name: nothing is downloaded
  await page.fill("#ws-url", `ws://127.0.0.1:${server.address().port}/ws/chat`);
  await page.fill("#agent-alias", "stub");
  await page.fill("#auth-token", "stub-token");
  await page.click("#connect-btn");
  await page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("connected"), null, { timeout: 15000 });
  const send = async (obj) => {
    client.write(frame(obj));
    await page.waitForTimeout(150);
  };
  const state = () =>
    page.evaluate(() => ({
      spoken: window.__sp.utterances.map((u) => u.text),
      cancels: window.__sp.cancels,
      events: [...document.getElementById("log").textContent.matchAll(/EVENT (\{.*\})/g)].map((m) => JSON.parse(m[1])),
    }));
  // Fires a callback of the i-th utterance. Returns false, and does nothing, if the page never spoke it: a behavior that
  // stopped speaking must fail the test that expects the speech, not throw in the setup that drives the page.
  const fire = (i, kind, code) =>
    page.evaluate(([i, kind, code]) => {
      const u = window.__sp.utterances[i];
      if (!u) return false;
      if (kind === "start") u.onstart({});
      else if (kind === "end") u.onend({});
      else u.onerror({ error: code });
      return true;
    }, [i, kind, code]);
  return { page, send, state, fire };
}

// The tts events of a page, as [name, index]: enough to see the order without the timestamps.
const tts = (events) => events.filter((e) => e.event.startsWith("tts_") || e.event === "done_received").map((e) => [e.event, e.index ?? null]);

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
  context = await chromium.launchPersistentContext(makeTempDir("nutq-ttsstream-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  // Flag off: nothing is spoken until done, then the whole reply once, from full_response.
  off = await openPage("");
  await off.send({ type: "chunk", content: "This is the first sentence. This is the second one! " });
  r.offAfterChunks = await off.state();
  await off.send({ type: "done", full_response: "Full reply from done.", tokens_used: 1 });
  await off.fire(0, "start");
  await off.fire(0, "end");
  r.offAfterDone = await off.state();
  client.destroy();
  await off.page.close();

  // Flag on: sentences are queued as they close and spoken one at a time.
  on = await openPage("&tts_stream=1");
  await on.send({ type: "chunk", content: "This is the first sentence. This is the sec" });
  r.onChunk1 = await on.state(); // the first sentence is closed and spoken; the second is not closed yet
  await on.send({ type: "chunk", content: "ond one! Tail here" });
  // Frames that carry text but are not the reply: logged, never spoken.
  await on.send({ type: "thinking", content: "Thinking about it. Still thinking here." });
  await on.send({ type: "tool_call", id: "1", name: "search", args: { q: "A query that is long enough. Really." } });
  await on.send({ type: "plan", entries: [{ content: "A plan step that is long enough. Second step here." }] });
  r.onChunk2 = await on.state(); // the second is closed and queued behind the first
  await on.fire(0, "start");
  await on.fire(0, "end");
  await on.fire(1, "start");
  await on.fire(1, "end");
  await on.send({ type: "done", full_response: "This is the first sentence. This is the second one! Tail here", tokens_used: 1 });
  await on.fire(2, "start");
  await on.fire(2, "end");
  r.onDone = await on.state();

  // A full_response that differs from the chunks: the chunks are spoken, the mismatch is reported, nothing is re-spoken.
  const before = (await on.state()).events.length;
  await on.send({ type: "chunk", content: "Only a short reply that is long enough." });
  await on.send({ type: "done", full_response: "Different text entirely.", tokens_used: 1 });
  await on.fire(3, "start");
  await on.fire(3, "end");
  r.onMismatch = await on.state();
  r.onMismatch.events = r.onMismatch.events.slice(before);

  // An empty reply is skipped as it is with the flag off.
  const before2 = (await on.state()).events.length;
  await on.send({ type: "done", full_response: "", tokens_used: 1 });
  await on.send({ type: "chunk", content: "   " });
  await on.send({ type: "done", full_response: "   ", tokens_used: 1 });
  r.onEmpty = await on.state();
  r.onEmpty.events = r.onEmpty.events.slice(before2);

  // A turn with no chunk frames, or none that closed a sentence into the queue: full_response is spoken once, trimmed,
  // through the same queue, and the mismatch is still reported.
  const before4 = (await on.state()).events.length;
  await on.send({ type: "done", full_response: "No chunk frames came before this.", tokens_used: 1 });
  await on.fire(4, "start");
  await on.fire(4, "end");
  await on.send({ type: "done", full_response: "  Padded reply, spoken trimmed.\n", tokens_used: 1 });
  await on.fire(5, "start");
  await on.fire(5, "end");
  r.onFallback = await on.state();
  r.onFallback.events = r.onFallback.events.slice(before4);

  // An aborted turn cancels the queue: one tts_cancelled, no more speech, and the cancelled sentence's late end is ignored.
  const spokenBefore = (await on.state()).spoken.length;
  await on.send({ type: "chunk", content: "A long enough sentence is here. And another long sentence here. " });
  await on.fire(spokenBefore, "start");
  const beforeAbort = await on.state();
  await on.send({ type: "aborted" });
  await on.fire(spokenBefore, "end"); // a browser that reports the cancelled utterance late
  r.onAbort = await on.state();
  r.onAbort.eventsAfterAbort = r.onAbort.events.slice(beforeAbort.events.length);
  r.onAbort.spokenAfterAbort = r.onAbort.spoken.length - beforeAbort.spoken.length;
  r.onAbort.cancelsAdded = r.onAbort.cancels - beforeAbort.cancels;

  // The next turn starts clean: index 0 again, and tts_start again.
  const before3 = (await on.state()).events.length;
  await on.send({ type: "chunk", content: "A fresh sentence after the abort. " });
  await on.fire(r.onAbort.spoken.length, "start");
  r.onNext = (await on.state()).events.slice(before3);

  // A closed socket cancels the queue.
  await on.send({ type: "chunk", content: "Yet another long sentence to speak. And one more after it. " });
  const beforeClose = await on.state();
  client.destroy();
  await on.page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("disconnected"), null, { timeout: 15000 });
  await on.page.waitForTimeout(150);
  r.onClose = await on.state();
  r.onClose.eventsAfterClose = r.onClose.events.slice(beforeClose.events.length).filter((e) => e.event.startsWith("tts_"));
  r.onClose.cancelsAdded = r.onClose.cancels - beforeClose.cancels;
});

after(async () => {
  await context?.close();
  vite?.child.kill();
  client?.destroy();
  server?.close();
});

test("flag off: nothing is spoken until done, then the whole reply once from full_response, as before", () => {
  assert.deepEqual(r.offAfterChunks.spoken, []);
  assert.deepEqual(r.offAfterDone.spoken, ["Full reply from done."]);
  assert.deepEqual(tts(r.offAfterDone.events), [["done_received", null], ["tts_start", null], ["tts_end", null]]);
});

test("flag off: tts_start keeps voice, local_service and voice_source, in that order, and gains engine", () => {
  const start = r.offAfterDone.events.find((e) => e.event === "tts_start");
  assert.deepEqual(Object.keys(start), ["event", "timestamp_ms", "voice", "local_service", "voice_source", "engine"]);
  assert.equal(start.voice_source, "browser_default");
  assert.equal(start.engine, "browser");
});

test("flag on: a sentence is spoken as soon as it closes, and the next waits for it", () => {
  assert.deepEqual(r.onChunk1.spoken, ["This is the first sentence."]);
  assert.deepEqual(tts(r.onChunk1.events), [["tts_requested", 0]]);
  assert.deepEqual(r.onChunk2.spoken, ["This is the first sentence."]); // the second is queued, not yet spoken
  assert.deepEqual(tts(r.onChunk2.events), [["tts_requested", 0], ["tts_requested", 1]]);
});

test("flag on: thinking, tool_call and plan frames are never spoken", () => {
  const all = r.onDone.spoken.join(" ");
  assert.doesNotMatch(all, /Thinking|query|plan step/i);
  assert.equal(r.onChunk2.events.filter((e) => e.event.startsWith("tts_")).length, 2);
});

test("flag on: tts_start once for the turn, tts_sentence_start per sentence with its index, the tail spoken at done", () => {
  assert.deepEqual(r.onDone.spoken, ["This is the first sentence.", "This is the second one!", "Tail here"]);
  assert.deepEqual(tts(r.onDone.events), [
    ["tts_requested", 0],
    ["tts_requested", 1],
    ["tts_start", null],
    ["tts_sentence_start", 0],
    ["tts_end", null],
    ["tts_sentence_start", 1],
    ["tts_end", null],
    ["done_received", null],
    ["tts_requested", 2],
    ["tts_sentence_start", 2],
    ["tts_end", null],
  ]);
  const start = r.onDone.events.find((e) => e.event === "tts_start");
  assert.deepEqual(Object.keys(start), ["event", "timestamp_ms", "voice", "local_service", "voice_source", "engine"]);
  assert.equal(r.onDone.events.filter((e) => e.event === "tts_text_mismatch").length, 0);
});

test("flag on: a full_response that differs from the chunks is reported, the chunks are spoken, nothing is spoken again", () => {
  assert.deepEqual(r.onMismatch.spoken.slice(3), ["Only a short reply that is long enough."]);
  assert.deepEqual(
    r.onMismatch.events.filter((e) => e.event === "tts_text_mismatch").map(({ chunks_chars, full_response_chars }) => ({ chunks_chars, full_response_chars })),
    [{ chunks_chars: "Only a short reply that is long enough.".length, full_response_chars: "Different text entirely.".length }],
  );
});

test("flag on: an empty or whitespace-only reply is tts_skipped as with the flag off, and nothing is spoken", () => {
  assert.equal(r.onEmpty.spoken.length, 4); // nothing new was spoken
  assert.deepEqual(
    r.onEmpty.events.filter((e) => e.event.startsWith("tts_")).map((e) => [e.event, e.reason ?? null]),
    [["tts_skipped", "empty"], ["tts_skipped", "empty"]],
  );
});

test("flag on: a turn at done with no sentence queued speaks full_response once, trimmed, through the queue, and still reports the mismatch", () => {
  assert.deepEqual(
    r.onFallback.spoken.slice(4),
    ["No chunk frames came before this.", "Padded reply, spoken trimmed."],
    "with no sentence queued at done, full_response should be spoken once, trimmed, through the queue",
  );
  assert.deepEqual(
    r.onFallback.events.filter((e) => e.event.startsWith("tts_")).map((e) => [e.event, e.index ?? null]),
    [
      ["tts_requested", 0],
      ["tts_text_mismatch", null],
      ["tts_start", null],
      ["tts_sentence_start", 0],
      ["tts_end", null],
      ["tts_requested", 0],
      ["tts_text_mismatch", null],
      ["tts_start", null],
      ["tts_sentence_start", 0],
      ["tts_end", null],
    ],
  );
});

test("flag on: an aborted turn cancels the queue once, speaks nothing more, and ignores the cancelled sentence's late end", () => {
  assert.equal(r.onAbort.cancelsAdded, 1);
  assert.equal(r.onAbort.spokenAfterAbort, 0);
  assert.deepEqual(
    r.onAbort.eventsAfterAbort.map((e) => [e.event, e.reason ?? null]),
    [["tts_cancelled", "canceled"], ["turn_aborted", null]],
  );
});

test("flag on: the turn after an abort starts clean, with index 0 and a new tts_start", () => {
  assert.deepEqual(r.onNext.filter((e) => e.event.startsWith("tts_")).map((e) => [e.event, e.index ?? null]), [
    ["tts_requested", 0],
    ["tts_start", null],
    ["tts_sentence_start", 0],
  ]);
});

test("flag on: a closed socket cancels the queue", () => {
  assert.equal(r.onClose.cancelsAdded, 1);
  assert.deepEqual(r.onClose.eventsAfterClose.map((e) => [e.event, e.reason ?? null]), [["tts_cancelled", "canceled"]]);
});
