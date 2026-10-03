// Tests that the real Transcriber (src/vendor/transcriber.ts) runs model calls one at a time,
// in a headless Chrome page served by Vite. The STT model is a fake that takes 60 ms per call,
// counts concurrent calls and returns "t<tag>", where the tag is the value of the audio's first
// sample. The real VAD and SpeechBuffer are loaded (the VAD comes from the CDN, like in
// vad-onset.mjs); the VAD's own handlers (t.vadModel.options) are called directly. Runs with the
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
  context = await chromium.launchPersistentContext(makeTempDir("nutq-serial-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { Transcriber } = await import("/src/vendor/transcriber.ts");
    const model = "model/base";
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const log = { events: [], sizes: [], inFlight: 0, maxInFlight: 0 };
    Transcriber.models.set(model, {
      loadModel: async () => {},
      isLoaded: () => true,
      isLoading: () => false,
      generate: async (audio) => {
        const tag = audio[0];
        log.events.push("s" + tag);
        log.sizes.push(audio.length);
        log.maxInFlight = Math.max(log.maxInFlight, ++log.inFlight);
        await sleep(60);
        log.inFlight--;
        log.events.push("e" + tag);
        if (tag === 9) throw new Error("boom");
        return "t" + tag;
      },
    });
    const frame = (tag) => new Float32Array(512).fill(tag);

    // One fresh Transcriber per scenario. `go` drives it and may return extra values.
    const scenario = async (go) => {
      Object.assign(log, { events: [], sizes: [], inFlight: 0, maxInFlight: 0 });
      const committed = [];
      const updates = [];
      const errors = [];
      const t = new Transcriber(
        model,
        {
          onTranscriptionCommitted: (text) => committed.push(text),
          onTranscriptionUpdated: (text) => updates.push(text),
          onModelError: (path, message) => errors.push({ path, message }),
        },
        false,
      );
      await t.load();
      const o = t.vadModel.options;
      const tools = {
        talk: () => o.onSpeechStart(), // isTalking = true, empty pre-roll
        fill: (n, tag) => { for (let i = 0; i < n; i++) t.speechBuffer.set(frame(tag)); },
        feed: (n, p, tag) => { for (let i = 0; i < n; i++) o.onFrameProcessed({ isSpeech: p }, frame(tag)); },
      };
      let threw = null;
      let extra;
      try {
        extra = await go(t, o, tools, committed);
        while (t.inFlight) await t.queue;
      } catch (e) {
        threw = String(e.message ?? e);
      }
      const out = { events: [...log.events], sizes: [...log.sizes], maxInFlight: log.maxInFlight, committed, updates, errors, threw, extra };
      t.vadModel.destroy?.();
      t.audioContext.close();
      return out;
    };

    return {
      // a pause commit (64 frames, tag 1) and, in the same tick, an onSpeechEnd commit (tag 2)
      overlap: await scenario(async (t, o, { talk, fill, feed }) => {
        talk();
        feed(64, 0, 1);
        fill(2, 2);
        o.onSpeechEnd(new Float32Array(0));
      }),
      // three onSpeechEnd commits made back to back
      fifo: await scenario(async (t, o, { talk, fill }) => {
        for (const tag of [1, 2, 3]) {
          talk();
          fill(2, tag);
          o.onSpeechEnd(new Float32Array(0));
        }
      }),
      // a commit is in flight when the buffer reaches 16 frames again: no update may start
      updateSkipped: await scenario(async (t, o, { talk, fill, feed }) => {
        talk();
        fill(64, 1);
        feed(1, 0, 1); // 65 frames, pause gate open: commit queued, buffer flushed
        feed(16, 0, 3); // update boundary while the commit runs
        const during = t.inFlight;
        while (t.inFlight) await t.queue;
        feed(16, 0, 4); // buffer now at 32 frames, model idle: this update runs
        return { during };
      }),
      // an update in flight when the buffer reaches the next update boundary: skipped too
      updateWhileUpdate: await scenario(async (t, o, { talk, feed }) => {
        talk();
        feed(32, 0, 1);
      }),
      // stop() with a 2 frame tail while an earlier commit is still running
      stopWaits: await scenario(async (t, o, { talk, fill }, committed) => {
        talk();
        fill(2, 1);
        o.onSpeechEnd(new Float32Array(0));
        fill(2, 2);
        await t.stop();
        return { atStop: [...committed] };
      }),
      // stop() with a tail too short for the model still waits for the earlier commit
      stopWaitsShortTail: await scenario(async (t, o, { talk, fill }, committed) => {
        talk();
        fill(2, 1);
        o.onSpeechEnd(new Float32Array(0));
        fill(1, 2);
        await t.stop();
        return { atStop: [...committed] };
      }),
      // an error on each path is reported, does not throw, and does not stop the later commit
      errSpeechEnd: await scenario(async (t, o, { talk, fill }) => {
        talk();
        fill(2, 9);
        o.onSpeechEnd(new Float32Array(0));
        fill(2, 5);
        await t.stop();
      }),
      errCommit: await scenario(async (t, o, { talk, fill, feed }) => {
        talk();
        fill(64, 9);
        feed(1, 0, 9);
      }),
      errStop: await scenario(async (t, o, { fill }) => {
        fill(2, 9);
        await t.stop();
      }),
      errUpdate: await scenario(async (t, o, { talk, feed }) => {
        talk();
        feed(16, 0, 9);
      }),
    };
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

const alternates = (events) => events.every((e, i) => e[0] === (i % 2 ? "e" : "s"));

test("overlapping pause commit and onSpeechEnd run one after the other, in order", () => {
  assert.equal(r.overlap.maxInFlight, 1);
  assert.ok(alternates(r.overlap.events), r.overlap.events.join(" "));
  assert.deepEqual(r.overlap.committed, ["t1", "t2"]);
});

test("commits are queued FIFO and none is dropped", () => {
  assert.equal(r.fifo.maxInFlight, 1);
  assert.deepEqual(r.fifo.committed, ["t1", "t2", "t3"]);
});

test("an update that falls due during a commit is skipped, and updates run again once idle", () => {
  assert.equal(r.updateSkipped.extra.during, 1, "the commit was still in flight");
  assert.deepEqual(r.updateSkipped.sizes, [65 * 512, 32 * 512]); // the commit, then the idle update; no 16 frame update
  assert.deepEqual(r.updateSkipped.committed, ["t1"]);
  assert.deepEqual(r.updateSkipped.updates, ["t3"]);
});

test("an update that falls due during another update is skipped", () => {
  assert.deepEqual(r.updateWhileUpdate.sizes, [16 * 512]); // the update at 16 frames; the one at 32 was skipped
  assert.equal(r.updateWhileUpdate.maxInFlight, 1);
});

test("stop() waits for the queued commits before returning", () => {
  assert.equal(r.stopWaits.threw, null);
  assert.deepEqual(r.stopWaits.extra.atStop, ["t1", "t2"]);
  assert.equal(r.stopWaits.maxInFlight, 1);
});

test("stop() with a tail under the encoder minimum still waits for the earlier commit", () => {
  assert.deepEqual(r.stopWaitsShortTail.extra.atStop, ["t1"]);
});

test("a model error is reported as onModelError with its path, and later commits still run", () => {
  assert.equal(r.errSpeechEnd.threw, null);
  assert.deepEqual(r.errSpeechEnd.errors, [{ path: "speech_end", message: "boom" }]);
  assert.deepEqual(r.errSpeechEnd.committed, ["t5"]);
  assert.deepEqual(r.errCommit.errors, [{ path: "commit", message: "boom" }]);
  assert.deepEqual(r.errStop.errors, [{ path: "stop", message: "boom" }]);
  assert.equal(r.errStop.threw, null);
  assert.deepEqual(r.errUpdate.errors, [{ path: "update", message: "boom" }]);
});
