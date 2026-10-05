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
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
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
  const state = async () => {
    const st = await stateInPage();
    st.pageErrors = [...pageErrors];
    return st;
  };
  const stateInPage = () =>
    page.evaluate(() => ({
      spoken: window.__sp.utterances.map((u) => u.text),
      cancels: window.__sp.cancels,
      pageErrors: [],
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
  // Frames that carry text but are not the reply: logged, never spoken. (A tool_call also drops speech, see below.)
  await on.send({ type: "thinking", content: "Thinking about it. Still thinking here." });
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

  // Markdown in the reply: the card keeps it, the voice gets speakable text, on every path.
  // Plays every utterance the page has been handed, in order, and returns what was spoken.
  const playAll = async (pg) => {
    for (let i = 0; i < 12; i++) {
      if (!(await pg.fire(i, "start"))) break;
      await pg.fire(i, "end");
      await pg.page.waitForTimeout(60);
    }
    return pg.state();
  };
  const md = "**Bold** start here today.\n- item one is an item\n- item two\n";
  // Flag off: the whole reply, once, from the done frame.
  const mdOff = await openPage("");
  await mdOff.send({ type: "chunk", content: md });
  await mdOff.send({ type: "done", full_response: md, tokens_used: 1 });
  r.mdOff = await playAll(mdOff);
  r.mdOff.card = await mdOff.page.evaluate(() => document.getElementById("reply-box").textContent);
  client.destroy();
  await mdOff.page.close();
  // Flag on, with markers and a code fence cut across chunks.
  const mdOn = await openPage("&tts_stream=1");
  for (const c of ["**Bol", "d** start here today.\n- item one is a", "n item\n- item tw", "o is here\n```\ncode line he", "re\n```\nThen an end."]) await mdOn.send({ type: "chunk", content: c });
  await mdOn.send({ type: "done", full_response: "**Bold** start here today.\n- item one is an item\n- item two is here\n```\ncode line here\n```\nThen an end.", tokens_used: 1 });
  r.mdOn = await playAll(mdOn);
  r.mdOn.card = await mdOn.page.evaluate(() => document.getElementById("reply-box").textContent);
  // The full_response fallback (no chunk frames) is cleaned too.
  await mdOn.send({ type: "done", full_response: "# Title\n- one\n- two", tokens_used: 1 });
  r.mdFallback = await playAll(mdOn);
  // A reply that is only code is not spoken, and is reported as empty like a blank one.
  const evBefore = (await mdOn.state()).events.length;
  await mdOn.send({ type: "chunk", content: "```\ncode\n```\n" });
  await mdOn.send({ type: "done", full_response: "```\ncode\n```\n", tokens_used: 1 });
  r.mdCodeOnly = await playAll(mdOn);
  r.mdCodeOnly.events = r.mdCodeOnly.events.slice(evBefore);
  client.destroy();
  await mdOn.page.close();
  // Flag off, only code.
  const codeOff = await openPage("");
  await codeOff.send({ type: "done", full_response: "```\ncode\n```", tokens_used: 1 });
  r.mdCodeOnlyOff = await playAll(codeOff);
  client.destroy();
  await codeOff.page.close();

  // Units that wait while the first plays reach the browser as one utterance; speech_text stays per unit.
  const co = await openPage("&tts_stream=1");
  await co.send({ type: "chunk", content: "First sentence is long enough. Second sentence is long too. Third sentence is also long. " });
  r.coFirst = await co.state(); // only the first is with the browser so far
  await co.fire(0, "start");
  await co.fire(0, "end");
  await co.fire(1, "start");
  await co.fire(1, "end");
  await co.send({ type: "done", full_response: "First sentence is long enough. Second sentence is long too. Third sentence is also long. ", tokens_used: 1 });
  r.coAll = await co.state();
  client.destroy();
  await co.page.close();

  // Tool calls (flag on): text streamed before a tool call is not part of the answer.
  const S1 = "Let me check the weather for you now.";
  const S2 = "I will look that up right away.";
  const PART = "And then I will";
  const POST = "The weather is sunny today.";
  const tool = { type: "tool_call", id: "1", name: "search", args: { q: "A query that is long enough. Really." } }; // its text is never spoken

  // One tool call, nothing audible yet: both units and the unfinished text are dropped, and the post-tool text is spoken
  // clean (the dropped unfinished text is not glued to it).
  const t1 = await openPage("&tts_stream=1");
  await t1.send({ type: "chunk", content: `${S1} ${S2} ${PART}` });
  r.t1Before = await t1.state();
  await t1.send(tool);
  r.t1Dropped = await t1.state();
  await t1.send({ type: "chunk", content: `${POST} ` });
  await t1.fire(1, "start");
  await t1.fire(1, "end");
  await t1.send({ type: "done", full_response: POST, tokens_used: 1 });
  r.t1 = await t1.state();
  client.destroy();
  await t1.page.close();

  // The audible utterance is not cancelled and plays to its end; what waits behind it is dropped; a second tool call drops again.
  const t2 = await openPage("&tts_stream=1");
  await t2.send({ type: "chunk", content: `${S1} ${S2} Third sentence goes right here now. ` });
  await t2.fire(0, "start");
  await t2.send(tool);
  r.t2AfterFirst = await t2.state();
  await t2.fire(0, "end");
  await t2.send({ type: "chunk", content: `${POST} Second part after the call is here. and so on` });
  await t2.fire(1, "start");
  await t2.send(tool);
  r.t2AfterSecond = await t2.state();
  await t2.send({ type: "chunk", content: "Final answer after the second call. " });
  await t2.fire(1, "end");
  await t2.fire(2, "start");
  await t2.fire(2, "end");
  await t2.send({ type: "done", full_response: "Final answer after the second call.", tokens_used: 1 });
  r.t2 = await t2.state();
  client.destroy();
  await t2.page.close();

  // A tool call with nothing queued: nothing to drop, no event, nothing cancelled; the reply goes on as normal.
  const t3 = await openPage("&tts_stream=1");
  await t3.send(tool);
  await t3.send({ type: "chunk", content: `${POST} ` });
  r.t3 = await t3.state();
  client.destroy();
  await t3.page.close();

  // Everything before the tool call dropped and nothing after it: the done fallback speaks full_response once.
  const t4 = await openPage("&tts_stream=1");
  await t4.send({ type: "chunk", content: `${S1} ${S2} ` });
  await t4.send(tool);
  await t4.send({ type: "done", full_response: "Here is the final answer.", tokens_used: 1 });
  r.t4 = await t4.state();
  client.destroy();
  await t4.page.close();

  // The audible pre-tool utterance stays (nothing to drop), nothing comes after the tool call: the fallback still speaks
  // full_response, because the final answer is not in the chunks.
  const t5 = await openPage("&tts_stream=1");
  await t5.send({ type: "chunk", content: `${S1} ` });
  await t5.fire(0, "start");
  await t5.send(tool);
  await t5.send({ type: "done", full_response: "Here is the final answer.", tokens_used: 1 });
  await t5.fire(0, "end"); // the final answer waited behind the audible utterance
  r.t5 = await t5.state();
  client.destroy();
  await t5.page.close();

  // A code fence opened before the tool call must not swallow what comes after it.
  const t7 = await openPage("&tts_stream=1");
  await t7.send({ type: "chunk", content: "Let me show you the command first:\n```bash\nnpm install foo\n" });
  await t7.send(tool);
  await t7.send({ type: "chunk", content: `${POST} ` });
  r.t7 = await t7.state();
  client.destroy();
  await t7.page.close();

  // Only unfinished text before the tool call (no unit closed yet): that is dropped and reported too.
  const t8 = await openPage("&tts_stream=1");
  await t8.send({ type: "chunk", content: PART });
  await t8.send(tool);
  r.t8 = await t8.state();
  client.destroy();
  await t8.page.close();

  // Flag off: a tool call changes nothing; the reply is spoken once at done.
  const t6 = await openPage("");
  await t6.send({ type: "chunk", content: `${S1} ${S2} ${PART}` });
  await t6.send(tool);
  await t6.send({ type: "done", full_response: POST, tokens_used: 1 });
  r.t6 = await t6.state();
  client.destroy();
  await t6.page.close();
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

test("flag on: thinking and plan frames are never spoken", () => {
  const all = r.onDone.spoken.join(" ");
  assert.doesNotMatch(all, /Thinking|query|plan step/i);
  assert.equal(r.onChunk2.events.filter((e) => e.event.startsWith("tts_")).length, 2);
});

test("flag on: tts_start once for the turn, tts_sentence_start per sentence with its index, the tail spoken at done", () => {
  assert.deepEqual(r.onDone.spoken, ["This is the first sentence.", "This is the second one!", "Tail here."]); // the unterminated tail gets a full stop from speakable()
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

test("markdown, flag off: the voice gets speakable text, the card keeps the original", () => {
  assert.deepEqual(r.mdOff.spoken, ["Bold start here today. item one is an item. item two."]);
  assert.equal(r.mdOff.card, "**Bold** start here today.\n- item one is an item\n- item two\n");
});

test("markdown, flag on: markers and a code fence cut across chunks are cleaned per unit, list items are separate, the card keeps the original", () => {
  // the first unit alone, the three that waited behind it merged into one utterance
  assert.deepEqual(r.mdOn.spoken, ["Bold start here today.", "item one is an item. item two is here. Then an end."]);
  assert.match(r.mdOn.card, /^\*\*Bold\*\* start here today\.\n- item one/);
});

test("markdown, flag on: the full_response fallback is cleaned too", () => {
  assert.deepEqual(r.mdFallback.spoken.slice(2), ["Title. one. two."]);
});

test("a reply that is only code is not spoken; it is tts_skipped as empty on both paths", () => {
  assert.equal(r.mdCodeOnly.spoken.length, 3); // nothing new was spoken
  assert.deepEqual(r.mdCodeOnly.events.filter((e) => e.event === "tts_skipped").map((e) => e.reason), ["empty"]);
  assert.deepEqual(r.mdCodeOnlyOff.spoken, []);
  assert.deepEqual(r.mdCodeOnlyOff.events.filter((e) => e.event === "tts_skipped").map((e) => e.reason), ["empty"]);
});

// speech_text { raw_chars, spoken_chars }: per unit handed to the voice, before and after cleaning; no text is logged.
const speechText = (events) => events.filter((e) => e.event === "speech_text").map((e) => [e.raw_chars, e.spoken_chars]);

test("speech_text, flag off: one event for the reply with its length before and after cleaning, and no text", () => {
  const md = "**Bold** start here today.\n- item one is an item\n- item two\n";
  assert.deepEqual(speechText(r.mdOff.events), [[md.length, "Bold start here today. item one is an item. item two.".length]]);
  assert.deepEqual(Object.keys(r.mdOff.events.find((e) => e.event === "speech_text")), ["event", "timestamp_ms", "raw_chars", "spoken_chars"]);
});

test("speech_text, flag on: one event per unit, including units that clean to nothing", () => {
  assert.deepEqual(speechText(r.mdOn.events), [[26, 22], [21, 20], [22, 17], [31, 12]]);
  assert.ok(speechText(r.mdCodeOnly.events).length > 0 && speechText(r.mdCodeOnly.events).every(([, spoken]) => spoken === 0));
  assert.deepEqual(speechText(r.mdCodeOnlyOff.events), [["```\ncode\n```".length, 0]]);
});

test("speech_text, fallback: the full_response is reported as one more unit", () => {
  const events = speechText(r.mdFallback.events);
  assert.deepEqual(events.at(-1), ["# Title\n- one\n- two".length, "Title. one. two.".length]);
});

test("coalescing: the first sentence is spoken alone, the ones that waited are one utterance, with units and chars on tts_sentence_start", () => {
  assert.deepEqual(r.coFirst.spoken, ["First sentence is long enough."]);
  assert.deepEqual(r.coAll.spoken, ["First sentence is long enough.", "Second sentence is long too. Third sentence is also long."]);
  const starts = r.coAll.events.filter((e) => e.event === "tts_sentence_start").map(({ index, units, chars }) => ({ index, units, chars }));
  assert.deepEqual(starts, [{ index: 0, units: 1, chars: 30 }, { index: 1, units: 2, chars: 57 }]);
  assert.deepEqual(r.coAll.events.filter((e) => e.event === "tts_requested").map((e) => e.index), [0, 1, 2]);
  assert.equal(r.coAll.events.filter((e) => e.event === "tts_end").length, 2);
});

test("coalescing: speech_text is still one event per unit, before merging", () => {
  assert.deepEqual(speechText(r.coAll.events), [[30, 30], [28, 28], [28, 28]]);
});

// tts_dropped { reason, units, chars, partial_chars }: a tool call dropped speech that had not been heard.
const dropped = (events) => events.filter((e) => e.event === "tts_dropped").map(({ reason, units, chars, partial_chars }) => ({ reason, units, chars, partial_chars }));
const TS1 = "Let me check the weather for you now.";
const TS2 = "I will look that up right away.";
const TPOST = "The weather is sunny today.";

test("tool call, flag on: the unit with the engine but not audible and the unit that waits are dropped, with the unfinished text; the event says how much", () => {
  assert.deepEqual(r.t1Before.spoken, [TS1]); // handed to the browser, not audible yet
  assert.equal(r.t1Dropped.cancels, 1); // the browser was told to cancel it
  assert.deepEqual(dropped(r.t1Dropped.events), [{ reason: "tool_call", units: 2, chars: TS1.length + TS2.length, partial_chars: "And then I will".length }]);
  assert.equal(r.t1Dropped.events.filter((e) => ["tts_start", "tts_cancelled", "tts_error"].includes(e.event)).length, 0);
});

test("tool call, flag on: what comes after is spoken as itself, the unfinished text is not glued to it, and its tts_start is the turn's first", () => {
  assert.deepEqual(r.t1.spoken, [TS1, TPOST]);
  assert.deepEqual(r.t1.events.filter((e) => e.event === "tts_start").length, 1);
  assert.deepEqual(r.t1.events.filter((e) => e.event === "tts_requested").map((e) => e.index), [0, 1, 2]); // numbering goes on
});

test("tool call, flag on: the audible utterance is not cancelled and plays to its end; what waited behind it is dropped", () => {
  assert.equal(r.t2AfterFirst.cancels, 0);
  assert.deepEqual(dropped(r.t2AfterFirst.events), [{ reason: "tool_call", units: 2, chars: TS2.length + "Third sentence goes right here now.".length, partial_chars: 0 }]);
  assert.equal(r.t2.events.filter((e) => e.event === "tts_cancelled").length, 0);
  assert.equal(r.t2.events.filter((e) => e.event === "tts_end").length, 3);
  assert.doesNotMatch(r.t2.spoken.join(" "), /query/i); // the tool_call frame's own text is never spoken
});

test("two tool calls in one turn: the drop repeats each time, and the speech that survives is the audible ones and the final answer", () => {
  assert.deepEqual(dropped(r.t2AfterSecond.events).slice(1), [{ reason: "tool_call", units: 1, chars: "Second part after the call is here.".length, partial_chars: "and so on".length }]);
  assert.deepEqual(r.t2.spoken, [TS1, TPOST, "Final answer after the second call."]);
});

test("tool call with nothing queued: no tts_dropped, nothing cancelled, and the reply is spoken as normal", () => {
  assert.deepEqual(dropped(r.t3.events), []);
  assert.equal(r.t3.cancels, 0);
  assert.deepEqual(r.t3.spoken, [TPOST]);
});

test("done fallback after a full drop: everything before the tool call was dropped and nothing came after, so full_response is spoken once", () => {
  assert.deepEqual(r.t4.spoken, [TS1, "Here is the final answer."]);
  assert.equal(dropped(r.t4.events).length, 1);
  assert.equal(r.t4.events.filter((e) => e.event === "tts_requested").length, 3);
});

test("done fallback when the pre-tool utterance was audible and so not dropped: nothing came after the tool call, so full_response is still spoken", () => {
  assert.deepEqual(r.t5.spoken, [TS1, "Here is the final answer."]);
  assert.deepEqual(dropped(r.t5.events), []); // nothing was dropped
});

test("tool call, flag off: unchanged. Nothing is dropped or cancelled, and the reply is spoken once from done", () => {
  assert.deepEqual(r.t6.spoken, [TPOST]);
  assert.deepEqual(dropped(r.t6.events), []);
  assert.equal(r.t6.cancels, 0);
  assert.deepEqual(r.t6.pageErrors, []); // the flag-off path does not even try to drop
});

test("tool call: a code fence open in the dropped text does not swallow the speech after the call", () => {
  assert.equal(r.t7.spoken.at(-1), TPOST);
  assert.equal(dropped(r.t7.events).length, 1);
});

test("tool call with only unfinished text buffered: it is dropped and reported with units 0", () => {
  assert.deepEqual(dropped(r.t8.events), [{ reason: "tool_call", units: 0, chars: 0, partial_chars: "And then I will".length }]);
  assert.equal(r.t8.cancels, 0);
});
