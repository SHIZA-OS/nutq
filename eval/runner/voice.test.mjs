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
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { pickVoice, voiceLines } = await import("/src/voice.ts");
    const v = (name, local, def = false, lang = "en-US") => ({ name, lang, localService: local, default: def });
    const list = [v("Google US English", false, true), v("English (America) espeak-ng", true), v("Samantha", true)];
    const many = Array.from({ length: 45 }, (_, i) => v("Voice " + i, i % 2 === 0));
    const frenchLocalFirst = [v("Thomas", true, false, "fr-FR"), v("Google UK English", false), v("Daniel", true, false, "en-GB")];
    const noLocalEnglish = [v("Google US English", false, true), v("Thomas", true, false, "fr-FR")];
    return {
      named: pickVoice(list, "Samantha"),
      namedIgnoresCase: pickVoice(list, "samantha").voice?.name,
      namedMissing: pickVoice(list, "Nobody"),
      partialIsNotAMatch: pickVoice(list, "Sam"),
      namedBeatsAuto: pickVoice(list, "Google US English"),
      auto: pickVoice(list, null),
      autoEmptyName: pickVoice(list, ""),
      autoSkipsNonEnglishAndNetwork: pickVoice(frenchLocalFirst, null),
      autoNoLocalEnglish: pickVoice(noLocalEnglish, null),
      emptyList: pickVoice([], null),
      emptyListNamed: pickVoice([], "Samantha"),
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

test("pickVoice, case 1: a name that matches a voice (ignoring case) picks it, with source param", () => {
  assert.deepEqual([r.named.voice.name, r.named.source], ["Samantha", "param"]);
  assert.equal(r.namedIgnoresCase, "Samantha");
  assert.deepEqual([r.namedBeatsAuto.voice.name, r.namedBeatsAuto.source], ["Google US English", "param"]); // even a network voice, when asked for
});

test("pickVoice, case 2: no name picks the first local English voice, with source auto_local", () => {
  assert.deepEqual([r.auto.voice.name, r.auto.source], ["English (America) espeak-ng", "auto_local"]);
  assert.deepEqual([r.autoEmptyName.voice.name, r.autoEmptyName.source], ["English (America) espeak-ng", "auto_local"]);
  assert.deepEqual([r.autoSkipsNonEnglishAndNetwork.voice.name, r.autoSkipsNonEnglishAndNetwork.source], ["Daniel", "auto_local"]);
});

test("pickVoice, case 3: no local English voice, or a name that matches nothing, is the browser default", () => {
  assert.deepEqual(r.autoNoLocalEnglish, { voice: null, source: "browser_default" });
  assert.deepEqual(r.emptyList, { voice: null, source: "browser_default" });
  assert.deepEqual(r.namedMissing, { voice: null, source: "browser_default" }); // a named voice that is missing does not fall back to auto_local
  assert.deepEqual(r.partialIsNotAMatch, { voice: null, source: "browser_default" });
  assert.deepEqual(r.emptyListNamed, { voice: null, source: "browser_default" });
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
