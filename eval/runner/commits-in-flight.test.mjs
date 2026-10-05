// Tests the commits-in-flight signal of the real Transcriber (src/vendor/transcriber.ts): onCommitsInFlight(n)
// fires when a commit is queued and again when it has finished, with its text already delivered. Streaming
// updates and skipped (too short) commits are not commits. Headless Chrome served by Vite, STT model stubbed
// (same setup as commit-guard.test.mjs). Runs with the rest of the suite via `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-inflight-"), {
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { Transcriber } = await import("/src/vendor/transcriber.ts");
    const model = "model/base";
    let fail = false;
    Transcriber.models.set(model, {
      loadModel: async () => {},
      isLoaded: () => true,
      isLoading: () => false,
      generate: async () => {
        await new Promise((res) => setTimeout(res, 5));
        if (fail) throw new Error("boom");
        return "text";
      },
    });
    const scenario = async (go, opts = {}) => {
      fail = !!opts.fail;
      const log = []; // what the callbacks saw, in order
      const t = new Transcriber(
        model,
        {
          onTranscriptionCommitted: (text) => log.push("text"),
          onCommitsInFlight: (n) => log.push(n),
          onModelError: () => log.push("error"),
        },
        false,
      );
      await t.load();
      await go(t);
      while (t.inFlight) await t.queue;
      await new Promise((res) => setTimeout(res, 20));
      t.vadModel.destroy?.();
      t.audioContext.close();
      return log;
    };
    const audio = (frames) => new Float32Array(frames * 512);
    return {
      one: await scenario((t) => t.commit("commit", audio(70))),
      two: await scenario((t) => (t.commit("commit", audio(70)), t.commit("speech_end", audio(20)))),
      skipped: await scenario((t) => t.commit("stop", audio(1))),
      update: await scenario((t) => t.update(audio(16))),
      failing: await scenario((t) => t.commit("commit", audio(70)), { fail: true }),
      stop: await scenario(async (t) => {
        for (let i = 0; i < 2; i++) t.speechBuffer.set(new Float32Array(512));
        await t.stop();
      }),
    };
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("a commit raises the count when it is queued and lowers it after its text was delivered", () => {
  assert.deepEqual(r.one, [1, "text", 0]);
});

test("two commits queued back to back count up and then down in order", () => {
  assert.deepEqual(r.two, [1, 2, "text", 1, "text", 0]);
});

test("a commit under the encoder minimum is skipped and never counted", () => assert.deepEqual(r.skipped, []));

test("a streaming update is not a commit", () => assert.deepEqual(r.update, []));

test("a failed model call still brings the count back to zero", () => assert.deepEqual(r.failing, [1, "error", 0]));

test("the flush in stop() is a commit like any other", () => assert.deepEqual(r.stop, [1, "text", 0]));
