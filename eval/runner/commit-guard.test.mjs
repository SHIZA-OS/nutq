// Tests the encoder-minimum guard in the real Transcriber (src/vendor/transcriber.ts) in a
// headless Chrome page served by Vite, with the STT model stubbed so no weights are needed.
// The real VAD and SpeechBuffer are loaded (the VAD comes from the CDN, like in
// vad-onset.mjs). Every commit path must go through Transcriber.transcribe(), which skips
// audio under 895 samples. The VAD's own handlers (t.vadModel.options) are called directly
// to drive the onFrameProcessed and onSpeechEnd paths. Runs with the rest of the suite via
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
  context = await chromium.launchPersistentContext(makeTempDir("nutq-commitguard-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { Transcriber } = await import("/src/vendor/transcriber.ts");
    const model = "model/base";
    const generated = []; // sample counts that reached the model
    Transcriber.models.set(model, {
      loadModel: async () => {},
      isLoaded: () => true,
      isLoading: () => false,
      generate: async (audio) => {
        generated.push(audio.length);
        return "tail";
      },
    });
    const frame = () => new Float32Array(512);
    const tick = () => new Promise((res) => setTimeout(res, 0));

    // One fresh Transcriber per scenario; `go` drives it. Returns what reached the model,
    // what was committed, and any error thrown.
    const scenario = async (go) => {
      generated.length = 0;
      const committed = [];
      const routed = []; // sample counts that went through transcribe()
      const t = new Transcriber(model, { onTranscriptionCommitted: (text) => committed.push(text) }, false);
      await t.load();
      const orig = t.transcribe.bind(t);
      t.transcribe = (audio) => (routed.push(audio.length), orig(audio));
      let threw = null;
      try {
        await go(t, t.vadModel.options);
        await tick();
      } catch (e) {
        threw = String(e.message ?? e);
      }
      const out = { generated: [...generated], committed, routed, threw, hasFrames: t.speechBuffer.hasFrames() };
      t.vadModel.destroy?.();
      t.audioContext.close();
      return out;
    };
    const fill = (t, n) => { for (let i = 0; i < n; i++) t.speechBuffer.set(frame()); };
    const talk = (o) => o.onSpeechStart(); // isTalking = true, empty pre-roll
    const feed = (o, n, p) => { for (let i = 0; i < n; i++) o.onFrameProcessed({ isSpeech: p }, frame()); };

    return {
      stopShort: await scenario(async (t) => { fill(t, 1); await t.stop(); }),
      stopOk: await scenario(async (t) => { fill(t, 2); await t.stop(); }),
      stopEmpty: await scenario(async (t) => { await t.stop(); }),
      endShort: await scenario(async (t, o) => { talk(o); fill(t, 1); o.onSpeechEnd(new Float32Array(0)); }),
      endEmpty: await scenario(async (t, o) => { talk(o); o.onSpeechEnd(new Float32Array(0)); }),
      endOk: await scenario(async (t, o) => { talk(o); fill(t, 2); o.onSpeechEnd(new Float32Array(0)); }),
      // A pause or cap commit always carries at least 64 frames (the pause minimum), so it can
      // never be under 895 samples; these check the paths still run through transcribe().
      pause: await scenario(async (t, o) => { talk(o); feed(o, 64, 0); }),
      cap: await scenario(async (t, o) => { talk(o); feed(o, 128, 1); }),
    };
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

const skipped = (x) => {
  assert.equal(x.threw, null);
  assert.deepEqual(x.generated, []);
  assert.deepEqual(x.committed, []);
  assert.equal(x.hasFrames, false, "the buffer is still flushed");
};

test("stop(): a 1 frame tail (512 samples) skips the model call and does not throw", () => skipped(r.stopShort));
test("stop(): a 2 frame tail (1024 samples) is transcribed and committed", () => {
  assert.deepEqual(r.stopOk.generated, [1024]);
  assert.deepEqual(r.stopOk.committed, ["tail"]);
});
test("stop(): an empty buffer makes no model call", () => assert.deepEqual(r.stopEmpty.generated, []));

test("onSpeechEnd: a 1 frame buffer skips the model call", () => skipped(r.endShort));
test("onSpeechEnd: an empty buffer skips the model call", () => skipped(r.endEmpty));
test("onSpeechEnd: a 2 frame buffer is transcribed and committed", () => {
  assert.deepEqual(r.endOk.generated, [1024]);
  assert.deepEqual(r.endOk.committed, ["tail"]);
});

test("pause-EMA commit at 64 frames goes through transcribe()", () => {
  assert.deepEqual(r.pause.routed, [64 * 512]);
  assert.equal(r.pause.generated.at(-1), 64 * 512); // earlier entries are streaming updates, not commits
  assert.deepEqual(r.pause.committed, ["tail"]);
});
test("cap commit at 128 frames goes through transcribe()", () => {
  assert.deepEqual(r.cap.routed, [128 * 512]);
  assert.equal(r.cap.generated.at(-1), 128 * 512);
  assert.deepEqual(r.cap.committed, ["tail"]);
});
