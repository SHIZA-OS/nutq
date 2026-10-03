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
    const v = (name, local, def = false) => ({ name, lang: "en-US", localService: local, default: def });
    const list = [v("Google US English", false, true), v("English (America) espeak-ng", true), v("Samantha", true)];
    const many = Array.from({ length: 45 }, (_, i) => v("Voice " + i, i % 2 === 0));
    return {
      exact: pickVoice(list, "Samantha")?.name,
      caseInsensitive: pickVoice(list, "samantha")?.name,
      missing: pickVoice(list, "Nobody"),
      noName: pickVoice(list, null),
      emptyName: pickVoice(list, ""),
      emptyList: pickVoice([], "Samantha"),
      partialIsNotAMatch: pickVoice(list, "Sam"),
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

test("pickVoice matches the exact name ignoring case, and nothing else", () => {
  assert.equal(r.exact, "Samantha");
  assert.equal(r.caseInsensitive, "Samantha");
  assert.equal(r.missing, null);
  assert.equal(r.noName, null);
  assert.equal(r.emptyName, null);
  assert.equal(r.emptyList, null);
  assert.equal(r.partialIsNotAMatch, null);
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
