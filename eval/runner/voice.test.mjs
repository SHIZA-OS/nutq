// Tests src/voice.ts (voice picking and the voice list log lines) in a headless Chrome page served by
// Vite. Runs with the rest of the suite via `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-voice-"), {
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { pickVoice, speechText, ttsErrorEvent, voiceLines } = await import("/src/voice.ts");
    const v = (name, local, def = false, lang = "en-US") => ({ name, lang, localService: local, default: def });
    const list = [v("Google US English", false, true), v("English (America) espeak-ng", true), v("Samantha", true)];
    const many = Array.from({ length: 45 }, (_, i) => v("Voice " + i, i % 2 === 0));
    const name = (c) => [c.voice?.name ?? null, c.source];
    // Local English voices and a local default are all around, and none of them is picked without a name.
    const local = [v("Afrikaans espeak-ng", true, true, "af"), v("English (America) espeak-ng", true, false, "en-US"), v("Samantha", true, false, "en-US")];
    return {
      named: name(pickVoice(list, "Samantha")),
      namedIgnoresCase: name(pickVoice(list, "samantha")),
      namedNetworkWhenAsked: name(pickVoice(list, "Google US English")),
      namedMissing: name(pickVoice(list, "Nobody")),
      partialIsNotAMatch: name(pickVoice(list, "Sam")),
      noName: name(pickVoice(list, null)),
      emptyName: name(pickVoice(list, "")),
      noNameWithLocalVoices: name(pickVoice(local, null)),
      emptyList: name(pickVoice([], null)),
      emptyListNamed: name(pickVoice([], "Samantha")),
      speech: ["", " ", "\n\t  ", "\u00a0", "hi", "  Hi there.\n", "OK."].map((t) => speechText(t)),
      errors: ["canceled", "interrupted", "synthesis-failed", "audio-busy", "not-allowed", undefined].map((c) => ttsErrorEvent(c)),
      lines: voiceLines(list),
      manyLines: voiceLines(many, 40),
      none: voiceLines([]),
    };
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("pickVoice: a name that matches a voice (ignoring case) picks it, with source param, even a network voice", () => {
  assert.deepEqual(r.named, ["Samantha", "param"]);
  assert.deepEqual(r.namedIgnoresCase, ["Samantha", "param"]);
  assert.deepEqual(r.namedNetworkWhenAsked, ["Google US English", "param"]);
});

test("pickVoice: no name is the browser default, even when local English voices exist (nothing is picked automatically)", () => {
  assert.deepEqual(r.noName, [null, "browser_default"]);
  assert.deepEqual(r.emptyName, [null, "browser_default"]);
  assert.deepEqual(r.noNameWithLocalVoices, [null, "browser_default"]);
  assert.deepEqual(r.emptyList, [null, "browser_default"]);
});

test("pickVoice: a name that matches nothing (or only part of a name) is the browser default", () => {
  assert.deepEqual(r.namedMissing, [null, "browser_default"]);
  assert.deepEqual(r.partialIsNotAMatch, [null, "browser_default"]);
  assert.deepEqual(r.emptyListNamed, [null, "browser_default"]);
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
