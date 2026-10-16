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
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
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
    const setup = (list, wanted, getSaved) => {
      const spoken = [];
      const calls = [];
      const synth = { getVoices: () => list, speak: (u) => spoken.push(u), cancel: () => calls.push("cancel") };
      const engine = browserEngine(synth, wanted, getSaved);
      const events = [];
      const speak = (text) => engine.speak(text, (info) => events.push(["start", info]), () => events.push(["end"]), (code) => events.push(["error", code]));
      return { engine, spoken, calls, events, speak };
    };
    const out = {};

    const used = (u) => ({ voice: u.voice?.name ?? null, lang: u.lang ?? null });

    let t = setup(voices, null);
    t.speak("Hello there.");
    out.noVoice = { name: t.engine.name, text: t.spoken[0].text, ...used(t.spoken[0]) };
    t.spoken[0].onstart();
    t.spoken[0].onend();
    out.noVoiceEvents = t.events;

    t = setup(voices, "samantha");
    t.speak("Hi.");
    out.named = used(t.spoken[0]);
    t.spoken[0].onstart();
    out.namedStart = t.events;

    t = setup(voices, "Nobody"); // a name that matches nothing: the ranked voice
    t.speak("Hi.");
    t.spoken[0].onstart();
    out.missing = { ...used(t.spoken[0]), events: t.events };

    let saved = null; // the menu's saved voice is read at every utterance, so a change applies from the next one
    t = setup(voices, null, () => saved);
    t.speak("One.");
    saved = "Samantha";
    t.speak("Two.");
    saved = "Nobody"; // a saved name that is not listed any more is ignored
    t.speak("Three.");
    t.spoken[1].onstart();
    out.saved = { voices: t.spoken.map((u) => u.voice?.name ?? null), events: t.events };

    t = setup(voices, "samantha", () => "Google US English"); // ?voice= wins over a saved voice
    t.speak("Hi.");
    out.paramBeatsSaved = used(t.spoken[0]);

    const german = { name: "Anna", lang: "de-DE", localService: true, default: true };
    t = setup([german], null); // no English voice: no voice is set, lang en-US asked, the default voice named as the best guess
    t.speak("Hi.");
    t.spoken[0].onstart();
    out.noEnglish = { ...used(t.spoken[0]), events: t.events };

    t = setup([], null); // voices not loaded: nothing to name
    t.speak("Hi.");
    t.spoken[0].onstart();
    out.noVoices = { ...used(t.spoken[0]), events: t.events };

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

test("the browser engine is named browser and speaks the text it is given with the best English voice (no lang needed)", () => {
  assert.deepEqual(r.noVoice, { name: "browser", text: "Hello there.", voice: "Google US English", lang: null });
});

test("lang is en-US only when no voice was chosen (no English voice, or no voices): a chosen voice keeps its own language", () => {
  assert.deepEqual(r.named, { voice: "Samantha", lang: null });
  assert.deepEqual(r.missing, { voice: "Google US English", lang: null, events: [["start", { voice: "Google US English", local_service: false, voice_source: "ranked" }]] });
  assert.equal(r.noEnglish.voice, null);
  assert.equal(r.noEnglish.lang, "en-US");
  assert.equal(r.noVoices.voice, null);
  assert.equal(r.noVoices.lang, "en-US");
});

test("a saved voice is read at every utterance and ignored when it is not listed; ?voice= wins over it", () => {
  assert.deepEqual(r.saved.voices, ["Google US English", "Samantha", "Google US English"]);
  assert.deepEqual(r.saved.events, [["start", { voice: "Samantha", local_service: true, voice_source: "saved" }]]);
  assert.equal(r.paramBeatsSaved.voice, "Samantha");
});

test("onStart carries the tts_start fields: the voice, whether it is local and where the name came from", () => {
  assert.deepEqual(r.noVoiceEvents, [["start", { voice: "Google US English", local_service: false, voice_source: "ranked" }], ["end"]]);
  assert.deepEqual(r.namedStart, [["start", { voice: "Samantha", local_service: true, voice_source: "param" }]]);
  // No voice chosen: the voice flagged default is the best guess, and none flagged or none listed is null.
  assert.deepEqual(r.noEnglish.events, [["start", { voice: "Anna", local_service: true, voice_source: "lang_only" }]]);
  assert.deepEqual(r.noVoices.events, [["start", { voice: null, local_service: null, voice_source: "lang_only" }]]);
});

test("onError carries the browser's error code, undefined if it gave none", () => {
  assert.deepEqual(r.errors, [["error", "synthesis-failed"], ["error", undefined]]);
});

test("cancel stops the browser's speech", () => assert.deepEqual(r.cancel, ["cancel"]));
