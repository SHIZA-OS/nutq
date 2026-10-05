// The public defaults, and the opt-outs that bring back the old behaviour exactly. With no URL parameters the page uses the
// text-dependent end of turn, asks for a spoken-style answer (reply voice) and speaks it sentence by sentence (tts_stream on).
// ?silence=<ms>, ?reply=short and ?tts_stream=0 each restore what was the default before. Real page in headless Chrome against
// the stub gateway of page-harness.mjs; the unit-level pins (waitFromParams, replyPrefix) are in endpoint.test.mjs and
// speech-text.test.mjs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, eventsOf } from "./page-harness.mjs";

let h;
const r = {};
// The prefix every run sent before ?reply= existed, byte for byte (speech-text.test.mjs pins the same string).
const OLD_SHORT_PREFIX = "Respond in 1-2 short, complete sentences, suitable for being spoken aloud. Be concise but don't cut off mid-thought.\n\n";
const SENTENCE = "A long enough sentence is here. ";

// One utterance, a reply chunk, and the end of the turn's endpoint: what the page did with each default.
async function scenario(query) {
  const p = await h.openPage(query);
  await p.commitOnStop();
  await p.texts("hello there");
  await p.utterance();
  const msgs = h.messages(p.conn);
  const sent = eventsOf((await p.state()).events, "ws_message_sent").at(-1);
  await p.send({ type: "chunk", content: SENTENCE });
  const afterChunk = await p.state();
  await p.send({ type: "done", full_response: SENTENCE, tokens_used: 1 });
  const afterDone = await p.state();
  // The end of turn: text that ends a sentence, then the speech end; the page logs the wait it armed (semantic only).
  await p.mic(); // listening again, so there is a turn whose end can be armed
  await p.page.evaluate(() => {
    window.__tcb.onSpeechStart(4);
    window.__tcb.onTranscriptionCommitted("Thank you.");
    window.__tcb.onSpeechEnd();
  });
  await p.page.waitForTimeout(150);
  const armed = eventsOf((await p.state()).events, "endpoint").map(({ hint, wait_ms }) => ({ hint, wait_ms }));
  return { content: msgs[0].content, style: sent.reply_style, afterChunk, afterDone, armed };
}

before(async () => {
  h = await startHarness();
  r.defaults = await scenario("");
  r.silence = await scenario("silence=5000");
  r.short = await scenario("reply=short");
  r.off = await scenario("tts_stream=0");
  r.old = await scenario("endpoint=semantic&reply=voice&tts_stream=1"); // the settings the demo URL used to carry
});

after(async () => {
  await h?.close();
});

const requested = (s) => eventsOf(s.events, "tts_requested").length;

test("no parameters: the text-dependent wait, the voice reply style and sentence streaming", () => {
  const d = r.defaults;
  assert.deepEqual(d.armed, [{ hint: "done", wait_ms: 1000 }]);
  assert.equal(d.style, "voice");
  assert.notEqual(d.content, OLD_SHORT_PREFIX + "hello there");
  assert.ok(d.content.endsWith("hello there"));
  assert.equal(requested(d.afterChunk), 1); // the sentence was queued as it closed
  assert.deepEqual(eventsOf(d.afterDone.events, "tts_text_mismatch"), []);
});

test("?silence=5000 is the old fixed default: no text-dependent wait is armed", () => {
  assert.deepEqual(r.silence.armed, []);
  assert.equal(r.silence.style, "voice"); // the other defaults are untouched
  assert.equal(requested(r.silence.afterChunk), 1);
});

test("?reply=short sends exactly the old short prefix and reports reply_style short", () => {
  assert.equal(r.short.content, OLD_SHORT_PREFIX + "hello there");
  assert.equal(r.short.style, "short");
  assert.deepEqual(r.short.armed, [{ hint: "done", wait_ms: 1000 }]);
});

test("?tts_stream=0 is the old flow: nothing queued per sentence, the reply is spoken once, at done, from full_response", () => {
  const o = r.off;
  assert.equal(requested(o.afterChunk), 0);
  assert.deepEqual(o.afterChunk.spoken, []);
  assert.deepEqual(o.afterDone.spoken, [SENTENCE.trim()]);
  assert.equal(requested(o.afterDone), 0);
  assert.equal(o.style, "voice");
});

test("the old demo settings (?endpoint=semantic&reply=voice&tts_stream=1) are the defaults now: harmless, same behaviour", () => {
  assert.deepEqual(r.old.armed, r.defaults.armed);
  assert.equal(r.old.style, "voice");
  assert.equal(r.old.content, r.defaults.content);
  assert.equal(requested(r.old.afterChunk), 1);
});
