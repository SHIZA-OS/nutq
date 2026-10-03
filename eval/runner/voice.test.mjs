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
    // Rule 1: the browser default is local, so it wins even over a better language match
    const defLocal = [v("Thomas", true, true, "fr-FR"), v("Daniel", true, false, "en-GB"), v("Samantha", true, false, "en-US")];
    // Rule 2: the default is a network voice; the exact language match is not the first local voice
    const exact = [v("Google US English", false, true), v("Daniel", true, false, "en-GB"), v("Samantha", true, false, "en-US"), v("Alex", true, false, "en-US")];
    // Rule 3: no exact match; the first local voice with the same base language
    const base = [v("Google UK English", false, true), v("Thomas", true, false, "fr-FR"), v("Daniel", true, false, "en-GB"), v("Karen", true, false, "en-AU")];
    // Otherwise: the default is a network voice and no local voice has the language
    const noMatch = [v("Google US English", false, true), v("Thomas", true, false, "fr-FR"), v("Netz", false, false, "en-US")];
    const underscore = [v("Google", false, true), v("Daniel", true, false, "en_GB"), v("Samantha", true, false, "en_US")];
    return {
      named: name(pickVoice(named, "Samantha", "en-US")),
      namedIgnoresCase: name(pickVoice(named, "samantha", "en-US")),
      namedNetworkWhenAsked: name(pickVoice(named, "Google US English", "en-US")),
      namedMissing: name(pickVoice(named, "Nobody", "en-US")),
      partialIsNotAMatch: name(pickVoice(named, "Sam", "en-US")),
      rule1: name(pickVoice(defLocal, null, "en-US")),
      rule1EmptyName: name(pickVoice(defLocal, "", "en-US")),
      rule2: name(pickVoice(exact, null, "en-US")),
      rule2CaseAndUnderscore: name(pickVoice(underscore, null, "EN-us")),
      rule3: name(pickVoice(base, null, "en-US")),
      rule3LanguageWithoutRegion: name(pickVoice(base, null, "en")),
      noMatch: name(pickVoice(noMatch, null, "en-US")),
      noLanguage: name(pickVoice(exact, null, "")),
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

test("pickVoice: a name that matches a voice (ignoring case) picks it, with source param, even a network voice", () => {
  assert.deepEqual(r.named, ["Samantha", "param"]);
  assert.deepEqual(r.namedIgnoresCase, ["Samantha", "param"]);
  assert.deepEqual(r.namedNetworkWhenAsked, ["Google US English", "param"]);
});

test("pickVoice rule 1: no name and the browser default voice is local: that voice, auto_local", () => {
  assert.deepEqual(r.rule1, ["Thomas", "auto_local"]); // wins over the en-US match
  assert.deepEqual(r.rule1EmptyName, ["Thomas", "auto_local"]);
});

test("pickVoice rule 2: the default is not local: the first local voice whose lang equals navigator.language", () => {
  assert.deepEqual(r.rule2, ["Samantha", "auto_local"]); // not Daniel (en-GB), not the network default
  assert.deepEqual(r.rule2CaseAndUnderscore, ["Samantha", "auto_local"]); // "EN-us" matches "en_US"
});

test("pickVoice rule 3: no exact match: the first local voice with the same base language", () => {
  assert.deepEqual(r.rule3, ["Daniel", "auto_local"]); // en-GB comes before en-AU, and is not the network default
  assert.deepEqual(r.rule3LanguageWithoutRegion, ["Daniel", "auto_local"]); // navigator.language "en"
});

test("pickVoice otherwise: the browser default, with source browser_default", () => {
  assert.deepEqual(r.noMatch, [null, "browser_default"]); // the only en-US voice is a network voice
  assert.deepEqual(r.noLanguage, [null, "browser_default"]);
  assert.deepEqual(r.emptyList, [null, "browser_default"]);
  assert.deepEqual(r.namedMissing, [null, "browser_default"]); // a missing name does not fall back to auto_local
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
