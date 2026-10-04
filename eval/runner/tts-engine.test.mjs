// Tests src/tts-engine.ts, the browser engine, in a headless Chrome page served by Vite (the real module). The
// speechSynthesis object and the utterance class are fakes, so nothing is spoken and no voices are needed. Runs
// with the rest of the suite via `npm test`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-ttsengine-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { browserEngine } = await import("/src/tts-engine.ts");
    // A plain class: the real SpeechSynthesisUtterance refuses a voice that is not a real SpeechSynthesisVoice.
    globalThis.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
        this.voice = null;
      }
    };
    const v = (name, localService, def = false) => ({ name, lang: "en-US", localService, default: def });
    const voices = [v("Google US English", false, true), v("Samantha", true)];
    const setup = (list, wanted) => {
      const spoken = [];
      const calls = [];
      const synth = { getVoices: () => list, speak: (u) => spoken.push(u), cancel: () => calls.push("cancel") };
      const engine = browserEngine(synth, wanted);
      const events = [];
      const speak = (text) => engine.speak(text, (info) => events.push(["start", info]), () => events.push(["end"]), (code) => events.push(["error", code]));
      return { engine, spoken, calls, events, speak };
    };
    const out = {};

    let t = setup(voices, null);
    t.speak("Hello there.");
    out.noVoice = { name: t.engine.name, text: t.spoken[0].text, voice: t.spoken[0].voice, lang: t.spoken[0].lang };
    t.spoken[0].onstart();
    t.spoken[0].onend();
    out.noVoiceEvents = t.events;

    t = setup(voices, "samantha");
    t.speak("Hi.");
    out.named = { voice: t.spoken[0].voice?.name ?? null, lang: t.spoken[0].lang ?? null };
    t.spoken[0].onstart();
    out.namedStart = t.events;

    t = setup(voices, "Nobody");
    t.speak("Hi.");
    t.spoken[0].onstart();
    out.missing = { voice: t.spoken[0].voice, lang: t.spoken[0].lang, events: t.events };

    t = setup([v("Only", true)], null); // no voice flagged default: nothing to name
    t.speak("Hi.");
    t.spoken[0].onstart();
    out.noDefault = t.events;

    t = setup(voices, null);
    t.speak("One.");
    t.spoken[0].onerror({ error: "synthesis-failed" });
    t.speak("Two.");
    t.spoken[1].onerror({ error: undefined });
    out.errors = t.events;

    t = setup(voices, null);
    t.engine.cancel();
    out.cancel = t.calls;
    return out;
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("the browser engine is named browser, speaks the text it is given and leaves the voice to the browser, asking for en-US", () => {
  assert.deepEqual(r.noVoice, { name: "browser", text: "Hello there.", voice: null, lang: "en-US" });
});

test("lang is en-US only when no voice was chosen: a voice that matched (?voice=) keeps its own language, a name that matched nothing gets en-US", () => {
  assert.deepEqual(r.named, { voice: "Samantha", lang: null });
  assert.equal(r.missing.lang, "en-US");
});

test("onStart carries the tts_start fields: the voice, whether it is local and where the name came from", () => {
  // No voice chosen: the voice flagged default is the best guess.
  assert.deepEqual(r.noVoiceEvents, [["start", { voice: "Google US English", local_service: false, voice_source: "browser_default" }], ["end"]]);
  assert.deepEqual(r.namedStart, [["start", { voice: "Samantha", local_service: true, voice_source: "param" }]]);
  assert.equal(r.missing.voice, null);
  assert.deepEqual(r.missing.events, [["start", { voice: "Google US English", local_service: false, voice_source: "browser_default" }]]);
  assert.deepEqual(r.noDefault, [["start", { voice: null, local_service: null, voice_source: "browser_default" }]]);
});

test("onError carries the browser's error code, undefined if it gave none", () => {
  assert.deepEqual(r.errors, [["error", "synthesis-failed"], ["error", undefined]]);
});

test("cancel stops the browser's speech", () => assert.deepEqual(r.cancel, ["cancel"]));
