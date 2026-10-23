// Tests src/voice.ts (the voice list log lines, speechText and ttsErrorEvent; picking a voice is in voice-pick.test.mjs) in Node. Runs with the rest of the suite via `npm test`.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./load-ts.mjs";

let r;

before(async () => {
  r = structuredClone(await (async () => {
    const { speechText, ttsErrorEvent, voiceLines } = await loadTs("voice");
    const v = (name, local, def = false, lang = "en-US") => ({ name, lang, localService: local, default: def });
    const list = [v("Google US English", false, true), v("English (America) espeak-ng", true), v("Samantha", true)];
    const many = Array.from({ length: 45 }, (_, i) => v("Voice " + i, i % 2 === 0));
    return {
      speech: ["", " ", "\n\t  ", "\u00a0", "hi", "  Hi there.\n", "OK."].map((t) => speechText(t)),
      errors: ["canceled", "interrupted", "synthesis-failed", "audio-busy", "not-allowed", undefined].map((c) => ttsErrorEvent(c)),
      lines: voiceLines(list),
      manyLines: voiceLines(many, 40),
      none: voiceLines([]),
    };
  })());
});

test("voiceLines gives a summary and one line per voice with local or network and the default", () => {
  assert.deepEqual(r.lines, [
    "Voices: 3 (2 local, 1 network). Pick one with ?voice=<exact name>.",
    "  Google US English | en-US | network | default",
    "  English (America) espeak-ng | en-US | local",
    "  Samantha | en-US | local",
  ]);
});

test("voiceLines caps a long list and says how many were left out", () => {
  assert.equal(r.manyLines.length, 1 + 40 + 1);
  assert.equal(r.manyLines[0], "Voices: 45 (23 local, 22 network). Pick one with ?voice=<exact name>.");
  assert.equal(r.manyLines.at(-1), "  ... and 5 more");
});

test("an empty list still gives the summary line", () => assert.deepEqual(r.none, ["Voices: 0 (0 local, 0 network). Pick one with ?voice=<exact name>."]));

test("speechText trims the reply, and is null for empty or whitespace-only text (including a non-breaking space)", () => {
  assert.deepEqual(r.speech, [null, null, null, null, "hi", "Hi there.", "OK."]);
});

test("ttsErrorEvent: canceled and interrupted are tts_cancelled, every other error code (or none) is tts_error", () => {
  assert.deepEqual(r.errors, [
    { event: "tts_cancelled", fields: { reason: "canceled" } },
    { event: "tts_cancelled", fields: { reason: "interrupted" } },
    { event: "tts_error", fields: { message: "synthesis-failed" } },
    { event: "tts_error", fields: { message: "audio-busy" } },
    { event: "tts_error", fields: { message: "not-allowed" } },
    { event: "tts_error", fields: { message: "unknown" } },
  ]);
});
