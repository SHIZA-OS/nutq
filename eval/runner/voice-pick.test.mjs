// Tests src/voice-pick.ts, the voice ranking and selection. No browser and no Vite: the module is pure, so it is compiled
// from TypeScript here and imported. Every voice list below is ILLUSTRATIVE, written to show the shape of each browser's list;
// none is a captured real list. Runs with the rest of the suite via `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../../src/voice-pick.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText;
const { rankVoices, isRobotic, selectVoice } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const v = (name, lang, extra = {}) => ({ name, lang, voiceURI: name, localService: true, default: false, ...extra });
const names = (list) => list.map((x) => x.name);
const pick = (voices, pref = {}) => {
  const s = selectVoice(voices, pref);
  return [s.voice?.name ?? null, s.source];
};

// Illustrative: Chrome-like, Google voices (network), English default.
const chrome = [
  v("Google US English", "en-US", { localService: false, default: true }),
  v("Google UK English Female", "en-GB", { localService: false }),
  v("Google Deutsch", "de-DE", { localService: false }),
  v("Google español", "es-ES", { localService: false }),
];
// Illustrative: Firefox on Linux-like, espeak voices with "+variant" siblings, reported as network, non-English default.
const firefox = [
  v("Afrikaans", "af", { localService: false, default: true }),
  v("English (America)+klatt2", "en-US", { localService: false }),
  v("English (America)", "en-US", { localService: false }),
  v("English (America)+f3", "en-US", { localService: false }),
  v("English (Great Britain)", "en-GB", { localService: false }),
  v("English (Great Britain)+f3", "en-GB", { localService: false }),
  v("German", "de", { localService: false }),
];
// Illustrative: Edge-like, Microsoft voices with Natural and Online in the names, one plain local voice flagged default.
const edge = [
  v("Microsoft Zira - English (United States)", "en-US", { default: true }),
  v("Microsoft Aria Online (Natural) - English (United States)", "en-US", { localService: false }),
  v("Microsoft Jenny Online (Natural) - English (United States)", "en-US", { localService: false }),
  v("Microsoft Libby Online (Natural) - English (United Kingdom)", "en-GB", { localService: false }),
  v("Microsoft Katja Online (Natural) - German (Germany)", "de-DE", { localService: false }),
];
// Illustrative: Safari-like, local system voices, one Enhanced.
const safari = [
  v("Alex", "en-US", { default: true }),
  v("Samantha", "en-US"),
  v("Daniel", "en-GB"),
  v("Ava (Enhanced)", "en-US"),
  v("Anna", "de-DE"),
];
const noEnglish = [v("Anna", "de-DE", { default: true }), v("Thomas", "fr-FR")];
const FIXTURES = { chrome, firefox, edge, safari, noEnglish, empty: [] };

test("Chrome-like: the Google US English voice, ranked", () => {
  assert.deepEqual(pick(chrome), ["Google US English", "ranked"]);
  assert.deepEqual(names(rankVoices(chrome)), ["Google US English", "Google UK English Female"]);
  assert.equal(isRobotic(chrome), false);
});

test("Firefox-Linux-like: the plain American voice, never a +variant, and the robotic flag is on (network voices do not hide it)", () => {
  assert.deepEqual(pick(firefox), ["English (America)", "ranked"]);
  assert.deepEqual(names(rankVoices(firefox)), ["English (America)", "English (Great Britain)"]);
  assert.equal(isRobotic(firefox), true);
});

test("Edge-like: a Natural Online voice beats the plain local default, first listed wins a tie", () => {
  assert.deepEqual(pick(edge), ["Microsoft Aria Online (Natural) - English (United States)", "ranked"]);
  assert.deepEqual(names(rankVoices(edge)).slice(0, 3), [
    "Microsoft Aria Online (Natural) - English (United States)",
    "Microsoft Jenny Online (Natural) - English (United States)",
    "Microsoft Libby Online (Natural) - English (United Kingdom)",
  ]);
  assert.equal(isRobotic(edge), false);
});

test("Safari-like: the Enhanced voice beats the browser default", () => {
  assert.deepEqual(pick(safari), ["Ava (Enhanced)", "ranked"]);
  assert.equal(isRobotic(safari), false);
});

test("no English voice, and an empty list: no voice, lang only, no robotic hint", () => {
  assert.deepEqual(pick(noEnglish), [null, "lang_only"]);
  assert.deepEqual(pick([]), [null, "lang_only"]);
  assert.deepEqual(rankVoices(noEnglish), []);
  assert.equal(isRobotic(noEnglish), false);
  assert.equal(isRobotic([]), false);
});

test("a +variant voice is never chosen while a plain English voice exists, even first in the list and flagged default", () => {
  const variantFirst = [v("English (America)+klatt2", "en-US", { default: true }), v("English (America)", "en-US")];
  assert.deepEqual(pick(variantFirst), ["English (America)", "ranked"]);
  // a variant with no plain sibling of its own base still loses to any plain English voice
  const orphan = [v("English (Scotland)+f2", "en-GB", { default: true }), v("English (America)", "en-US")];
  assert.deepEqual(pick(orphan), ["English (America)", "ranked"]);
});

test("across every fixture, no ranked or saved or automatic choice is a +variant when a plain English voice exists", () => {
  for (const [label, voices] of Object.entries(FIXTURES)) {
    const english = voices.filter((x) => x.lang.toLowerCase().startsWith("en"));
    if (!english.some((x) => !x.name.includes("+"))) continue;
    for (const x of rankVoices(voices)) assert.ok(!x.name.includes("+"), `${label}: ranked has ${x.name}`);
    for (const saved of [null, ...voices.map((x) => x.name)]) {
      const s = selectVoice(voices, { saved });
      assert.ok(!(s.voice?.name ?? "").includes("+"), `${label}: saved ${saved} gave ${s.voice?.name}`);
    }
  }
});

test("only variants exist: one of them is used, and the list is robotic", () => {
  const onlyVariants = [v("English (America)+klatt2", "en-US"), v("English (America)+f3", "en-US")];
  assert.deepEqual(pick(onlyVariants), ["English (America)+klatt2", "ranked"]);
  assert.equal(isRobotic(onlyVariants), true);
});

test("English is lang starting with en, in either case and with a dash or an underscore", () => {
  const list = [v("A", "en_US"), v("B", "EN-gb"), v("C", "en"), v("D", "de-DE"), v("E", "fr-EN")];
  assert.deepEqual(names(rankVoices(list)), ["A", "B", "C"]);
});

test("ranking: quality name first, then en-US, en-GB, other English, then the browser default, then list order", () => {
  const list = [v("Plain AU", "en-AU"), v("Plain GB", "en-GB"), v("Plain US", "en-US"), v("Google AU", "en-AU"), v("Plain US default", "en-US", { default: true }), v("Plain US later", "en-US")];
  assert.deepEqual(names(rankVoices(list)), ["Google AU", "Plain US default", "Plain US", "Plain US later", "Plain GB", "Plain AU"]);
  for (const word of ["Natural", "Neural", "Online", "Google", "Enhanced", "Premium"]) {
    assert.equal(rankVoices([v("Plain", "en-US"), v(`X ${word}`, "en-GB")])[0].name, `X ${word}`, word);
  }
});

test("robotic needs every English voice to look like espeak; the name or the URI saying espeak counts", () => {
  assert.equal(isRobotic([v("English", "en-US", { voiceURI: "urn:x:espeak-ng:en" }), v("English GB", "en-GB", { voiceURI: "ESPEAK" })]), true);
  assert.equal(isRobotic([v("English (espeak-ng)", "en-US")]), true);
  assert.equal(isRobotic([v("English (America)", "en-US"), v("English (America)+f3", "en-US"), v("Samantha", "en-US")]), false);
  assert.equal(isRobotic([v("English (America)", "en-US")]), false); // no variant, no espeak in the text: not known to be robotic
});

test("selection order: ?voice= (any language, ignoring case), then a saved voice, then ranked", () => {
  assert.deepEqual(pick(safari, { param: "anna", saved: "Samantha" }), ["Anna", "param"]);
  assert.deepEqual(pick(safari, { param: "Nobody", saved: "Samantha" }), ["Samantha", "saved"]);
  assert.deepEqual(pick(safari, { param: "", saved: "" }), ["Ava (Enhanced)", "ranked"]);
  assert.deepEqual(pick(safari, { param: null, saved: null }), ["Ava (Enhanced)", "ranked"]);
});

test("a saved voice must still be among the ranked English voices, otherwise it is ignored", () => {
  assert.deepEqual(pick(safari, { saved: "Anna" }), ["Ava (Enhanced)", "ranked"]); // not English
  assert.deepEqual(pick(safari, { saved: "Gone" }), ["Ava (Enhanced)", "ranked"]); // no longer listed
  assert.deepEqual(pick(firefox, { saved: "English (America)+klatt2" }), ["English (America)", "ranked"]); // a variant the rule drops
  assert.deepEqual(pick([], { saved: "Samantha" }), [null, "lang_only"]); // voices not loaded yet
});

test("selectVoice returns the ranked list with the choice", () => {
  assert.deepEqual(names(selectVoice(edge, {}).ranked), names(rankVoices(edge)));
  assert.deepEqual(selectVoice(noEnglish, {}).ranked, []);
});
