// Tests the real Transcriber.stop() (src/vendor/transcriber.ts) in a headless Chrome page
// served by Vite, with the STT model stubbed so no weights are needed. The real VAD and
// SpeechBuffer are loaded (the VAD comes from the CDN, like in vad-onset.mjs). Runs with the
// rest of the suite via `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-stopguard-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { Transcriber } = await import("/src/vendor/transcriber.ts");
    const model = "model/base";
    const calls = [];
    Transcriber.models.set(model, {
      loadModel: async () => {},
      isLoaded: () => true,
      isLoading: () => false,
      generate: async (audio) => {
        calls.push(audio.length);
        return "tail";
      },
    });
    const committed = [];
    const t = new Transcriber(model, { onTranscriptionCommitted: (text) => committed.push(text) }, false);
    await t.load();

    // stop() with `frames` 512-sample frames left in the speech buffer
    const stopWith = async (frames) => {
      calls.length = 0;
      committed.length = 0;
      for (let i = 0; i < frames; i++) t.speechBuffer.set(new Float32Array(512));
      let threw = null;
      try {
        await t.stop();
      } catch (e) {
        threw = String(e.message ?? e);
      }
      return { calls: [...calls], committed: [...committed], threw, hasFrames: t.speechBuffer.hasFrames() };
    };
    return { one: await stopWith(1), two: await stopWith(2), none: await stopWith(0) };
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("a 1 frame tail (512 samples, under the encoder minimum) skips the model call and does not throw", () => {
  assert.equal(r.one.threw, null);
  assert.deepEqual(r.one.calls, []);
  assert.deepEqual(r.one.committed, []);
  assert.equal(r.one.hasFrames, false, "the buffer is still flushed");
});

test("a 2 frame tail (1024 samples) is transcribed and committed", () => {
  assert.deepEqual(r.two.calls, [1024]);
  assert.deepEqual(r.two.committed, ["tail"]);
});

test("an empty buffer makes no model call", () => assert.deepEqual(r.none.calls, []));
