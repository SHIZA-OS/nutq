// Tests src/mic-constraints.ts in a headless Chrome page served by Vite: the constraint choice for
// every combination of eval mode and ?rawmic=1, and that Chrome actually applies the raw constraints
// (fake capture device, so no real microphone is involved). Runs with the rest of the suite via
// `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-mic-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { micConstraints } = await import("/src/mic-constraints.ts");
    const settings = async (c) => {
      const stream = await navigator.mediaDevices.getUserMedia(c);
      const s = stream.getAudioTracks()[0].getSettings();
      stream.getTracks().forEach((t) => t.stop());
      return { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl };
    };
    return {
      normal: micConstraints(false, false),
      rawOutsideEval: micConstraints(false, true),
      evalDefault: micConstraints(true, false),
      raw: micConstraints(true, true),
      rawApplied: await settings(micConstraints(true, true)),
      defaultApplied: await settings(micConstraints(true, false)),
    };
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

const on = { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true, sampleRate: 16000 };

test("normal sessions, and eval sessions without rawmic, keep the processing on", () => {
  assert.deepEqual(r.normal.audio, on);
  assert.deepEqual(r.evalDefault.audio, on);
});

test("rawmic is ignored outside eval mode", () => assert.deepEqual(r.rawOutsideEval.audio, on));

test("rawmic in eval mode turns off echo cancellation, noise suppression and auto gain, and keeps the rest", () => {
  assert.deepEqual(r.raw.audio, { channelCount: 1, echoCancellation: false, autoGainControl: false, noiseSuppression: false, sampleRate: 16000 });
});

test("Chrome applies the raw constraints (and the default ones are not all off)", () => {
  assert.deepEqual(r.rawApplied, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  assert.notDeepEqual(r.defaultApplied, r.rawApplied);
});
