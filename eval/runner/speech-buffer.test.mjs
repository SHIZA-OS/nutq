// Tests the real SpeechBuffer (src/vendor/transcriber.ts) commit gate in a headless Chrome
// page served by Vite: the 64 frame pause-commit minimum counts recorded frames only, while
// the 128 frame cap counts everything in the buffer, pre-roll included. Runs with the rest of
// the suite via `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-specbuf-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { SpeechBuffer } = await import("/src/vendor/transcriber.ts");
    const frame = () => new Float32Array(512);
    // Fill like Transcriber.onSpeechStart / onFrameProcessed do: `pre` pre-roll frames, then
    // `recorded` frames with speech probability `p` (0 = a pause, so the EMA is under 0.5).
    // Returns the frame counts at which shouldCommit() first turned true, or null.
    const run = (pre, recorded, p) => {
      const b = new SpeechBuffer(false);
      if (pre) b.prepend(Array.from({ length: pre }, frame));
      let recordedFrames = 0;
      for (; recordedFrames < recorded; recordedFrames++) {
        b.updateEMA({ isSpeech: p });
        b.set(frame());
        if (b.shouldCommit()) return { recorded: recordedFrames + 1, total: pre + recordedFrames + 1 };
      }
      return null;
    };
    return {
      noPreRoll: run(0, 200, 0),
      withPreRoll: run(4, 200, 0),
      cap: run(4, 200, 1),
      capNoPreRoll: run(0, 200, 1),
    };
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("without pre-roll the pause gate opens at 64 recorded frames", () => assert.deepEqual(r.noPreRoll, { recorded: 64, total: 64 }));
test("pre-roll frames do not count toward the pause minimum: still 64 recorded frames, 68 in the buffer", () => assert.deepEqual(r.withPreRoll, { recorded: 64, total: 68 }));
test("pre-roll frames count toward the 128 frame cap: 124 recorded plus 4 pre-roll", () => {
  assert.deepEqual(r.cap, { recorded: 124, total: 128 });
  assert.deepEqual(r.capNoPreRoll, { recorded: 128, total: 128 });
});
