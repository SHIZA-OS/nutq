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
    const name = (c) => [c.voice?.name ?? null, c.source];
    // A named voice (?voice=), whatever the language and the default
    const named = [v("Google US English", false, true), v("Samantha", true), v("Thomas", true, false, "fr-FR")];
    // Rule 1: the browser default is local and English, so it wins even over an exact language match
    const defLocal = [v("Daniel", true, true, "en-GB"), v("Samantha", true, false, "en-US")];
    // The Afrikaans case: the default is local but not English, so it is skipped, and rule 2 finds en-US
    const afrikaansDefault = [v("Afrikaans espeak-ng", true, true, "af"), v("Daniel", true, false, "en-GB"), v("English (America) espeak-ng", true, false, "en-US")];
    // A network English default is skipped too (rule 1 is local only)
    const networkDefault = [v("Google US English", false, true), v("Daniel", true, false, "en-GB"), v("Samantha", true, false, "en-US"), v("Alex", true, false, "en-US")];
    // Rule 2 with an English navigator.language other than en-US: that exact tag
    const regional = [v("Afrikaans espeak-ng", true, true, "af"), v("Samantha", true, false, "en-US"), v("Daniel", true, false, "en-GB")];
    // Rule 3: no voice has the target exactly; the first local English voice (not French, not network)
    const anyEnglish = [v("Afrikaans espeak-ng", true, true, "af"), v("Thomas", true, false, "fr-FR"), v("Netz", false, false, "en-US"), v("Karen", true, false, "en-AU"), v("Daniel", true, false, "en-GB")];
    // Rule 4: nothing local and English
    const noEnglish = [v("Afrikaans espeak-ng", true, true, "af"), v("Thomas", true, false, "fr-FR"), v("Google US English", false, false, "en-US")];
    const underscore = [v("Afrikaans", true, true, "af"), v("Daniel", true, false, "en_GB"), v("Samantha", true, false, "en_US")];
    return {
      named: name(pickVoice(named, "Samantha", "en-US")),
      namedIgnoresCase: name(pickVoice(named, "samantha", "en-US")),
      namedNetworkWhenAsked: name(pickVoice(named, "Google US English", "en-US")),
      namedMissing: name(pickVoice(named, "Nobody", "en-US")),
      partialIsNotAMatch: name(pickVoice(named, "Sam", "en-US")),
      rule1: name(pickVoice(defLocal, null, "en-US")),
      rule1EmptyName: name(pickVoice(defLocal, "", "en-US")),
      afrikaans: name(pickVoice(afrikaansDefault, null, "en-US")),
      networkDefault: name(pickVoice(networkDefault, null, "en-US")),
      rule2: name(pickVoice(regional, null, "en-US")),
      rule2Regional: name(pickVoice(regional, null, "en-GB")),
      rule2CaseAndUnderscore: name(pickVoice(underscore, null, "EN-us")),
      nonEnglishLanguageStillEnglish: name(pickVoice(regional, null, "fr-FR")),
      germanLanguageUsesEnUS: name(pickVoice(regional, null, "de-DE")),
      noLanguageUsesEnUS: name(pickVoice(regional, null, "")),
      rule3: name(pickVoice(anyEnglish, null, "en-US")),
      rule3RegionalTargetMissing: name(pickVoice(anyEnglish, null, "en-NZ")),
      rule4: name(pickVoice(noEnglish, null, "en-US")),
      emptyList: name(pickVoice([], null, "en-US")),
      emptyListNamed: name(pickVoice([], "Samantha", "en-US")),
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

test("pickVoice rule 1: the browser default voice, if it is local and English", () => {
  assert.deepEqual(r.rule1, ["Daniel", "auto_local"]); // wins over the exact en-US match
  assert.deepEqual(r.rule1EmptyName, ["Daniel", "auto_local"]);
});

test("pickVoice skips a default that is local but not English (the Afrikaans case), or English but not local", () => {
  assert.deepEqual(r.afrikaans, ["English (America) espeak-ng", "auto_local"]);
  assert.deepEqual(r.networkDefault, ["Samantha", "auto_local"]); // the first local en-US voice, not the network default
});

test("pickVoice rule 2: the first local voice whose lang equals the target exactly", () => {
  assert.deepEqual(r.rule2, ["Samantha", "auto_local"]);
  assert.deepEqual(r.rule2Regional, ["Daniel", "auto_local"]); // navigator.language en-GB is the target
  assert.deepEqual(r.rule2CaseAndUnderscore, ["Samantha", "auto_local"]); // "EN-us" matches "en_US"
});

test("pickVoice: a navigator.language that is not English still yields an English voice (the target is en-US)", () => {
  assert.deepEqual(r.nonEnglishLanguageStillEnglish, ["Samantha", "auto_local"]); // fr-FR
  assert.deepEqual(r.germanLanguageUsesEnUS, ["Samantha", "auto_local"]); // de-DE
  assert.deepEqual(r.noLanguageUsesEnUS, ["Samantha", "auto_local"]); // empty
});

test("pickVoice rule 3: no exact match: the first local voice whose base language is en", () => {
  assert.deepEqual(r.rule3, ["Karen", "auto_local"]); // not the French voice, not the network en-US voice
  assert.deepEqual(r.rule3RegionalTargetMissing, ["Karen", "auto_local"]);
});

test("pickVoice rule 4: no local English voice: the browser default, with source browser_default", () => {
  assert.deepEqual(r.rule4, [null, "browser_default"]);
  assert.deepEqual(r.emptyList, [null, "browser_default"]);
});

test("pickVoice: a name picks that voice (param), and a missing name is the browser default, not auto_local", () => {
  assert.deepEqual(r.named, ["Samantha", "param"]);
  assert.deepEqual(r.namedIgnoresCase, ["Samantha", "param"]);
  assert.deepEqual(r.namedNetworkWhenAsked, ["Google US English", "param"]);
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
