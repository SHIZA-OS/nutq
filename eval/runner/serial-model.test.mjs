// Tests that the real Transcriber (src/vendor/transcriber.ts) runs model calls one at a time,
// in a headless Chrome page served by Vite. The STT model is a fake that takes 60 ms per call,
// counts concurrent calls and returns "t<tag>", where the tag is the value of the audio's first
// sample. The real VAD and SpeechBuffer are loaded (the VAD files are served from public/vendor, like in
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
    const { Transcriber, audioHash } = await import("/src/vendor/transcriber.ts");
    const model = "model/base";
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const log = { events: [], sizes: [], inFlight: 0, maxInFlight: 0 };
    // performance.now() is what the Transcriber times a call with (wait_ms, run_ms). While `fake.on` it reads a clock
    // that only moves when the fake model "takes" its 60 ms, so those times do not depend on how busy the machine
    // is (the test's own synchronous work between two calls being queued took 27 ms and more under a parallel run).
    const realNow = performance.now.bind(performance);
    const fake = { on: false, now: 0 };
    performance.now = () => (fake.on ? fake.now : realNow());
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
        if (fake.on) fake.now += 60;
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
      const calls = [];
      const t = new Transcriber(
        model,
        {
          onTranscriptionCommitted: (text) => committed.push(text),
          onTranscriptionUpdated: (text) => updates.push(text),
          onModelError: (path, message) => errors.push({ path, message }),
          onModelCall: (info) => calls.push(info),
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
      const out = { events: [...log.events], sizes: [...log.sizes], maxInFlight: log.maxInFlight, committed, updates, errors, calls, threw, extra };
      t.vadModel.destroy?.();
      t.audioContext.close();
      return out;
    };

    // an independent FNV-1a over the int16 bytes, to check audioHash() against
    const fnv = (samples) => {
      let h = 0x811c9dc5n;
      for (const x of samples) {
        const v = Math.max(-32768, Math.min(32767, Math.round(x * 32768)));
        for (const b of [v & 255, (v >> 8) & 255]) h = ((h ^ BigInt(b)) * 0x01000193n) & 0xffffffffn;
      }
      return h.toString(16).padStart(8, "0");
    };
    const noise = new Float32Array(2000).map((_, i) => Math.sin(i * 0.37) * 0.8);
    const hashes = {
      noise: audioHash(noise),
      expected: fnv(noise),
      again: audioHash(noise.slice()),
      oneSampleOff: audioHash(noise.map((x, i) => (i === 1999 ? x + 0.001 : x))),
      belowQuantum: audioHash(noise.map((x, i) => (i === 5 ? x + 0.000001 : x))), // under 1/65536: same int16
      clipped: audioHash(new Float32Array([2, -2])) === audioHash(new Float32Array([1, -1])),
      empty: audioHash(new Float32Array(0)),
    };

    // a pause commit (64 frames, tag 1) and, in the same tick, an onSpeechEnd commit (tag 2), on the fake clock
    const overlap = await scenario(async (t, o, { talk, fill, feed }) => {
      fake.on = true;
      talk();
      feed(64, 0, 1);
      fill(2, 2);
      o.onSpeechEnd(new Float32Array(0));
    });
    fake.on = false;

    return {
      hashes,
      overlap,
      // 2 frame commits at amplitude 0.1, 0.2, 0.1 (under the int16 clip that tags 1, 2, 3 hit)
      hashed: await scenario(async (t, o, { talk, fill }) => {
        for (const amp of [0.1, 0.2, 0.1]) {
          talk();
          fill(2, amp);
          o.onSpeechEnd(new Float32Array(0));
        }
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
      // a tail under the encoder minimum is reported as skipped, with no wait and no run
      shortStop: await scenario(async (t, o, { fill }) => {
        fill(1, 2);
        await t.stop();
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

test("onModelCall reports each call's samples, wait and run time, and its skips", () => {
  const ran = r.overlap.calls.filter((c) => !c.skipped);
  assert.deepEqual(ran.map((c) => [c.path, c.samples]), [["update", 16 * 512], ["commit", 64 * 512], ["speech_end", 2 * 512]]);
  // On the fake clock all three were queued at 0 and the model takes 60 each: the first found the model idle, and each
  // later one waited for every call before it.
  assert.deepEqual(ran.map((c) => [c.wait_ms, c.run_ms]), [[0, 60], [60, 60], [120, 60]]);
  const skipped = r.overlap.calls.filter((c) => c.skipped);
  assert.deepEqual(skipped.map((c) => [c.path, c.samples, c.wait_ms, c.run_ms]), [["update", 32 * 512, 0, 0], ["update", 48 * 512, 0, 0]]);
  assert.deepEqual(r.shortStop.calls.map((c) => ({ ...c, audio_hash: undefined })), [{ path: "stop", samples: 512, audio_hash: undefined, wait_ms: 0, run_ms: 0, skipped: true }]);
});

test("audioHash is FNV-1a over the int16 bytes, stable, and sensitive to the audio", () => {
  const h = r.hashes;
  assert.equal(h.noise, h.expected); // matches an independent implementation
  assert.match(h.noise, /^[0-9a-f]{8}$/);
  assert.equal(h.again, h.noise);
  assert.notEqual(h.oneSampleOff, h.noise);
  assert.equal(h.belowQuantum, h.noise);
  assert.equal(h.clipped, true);
  assert.equal(h.empty, "811c9dc5"); // the FNV-1a offset basis
});

test("onModelCall carries the audio hash: same audio gives the same hash, different audio a different one", () => {
  const h = r.hashed.calls.map((c) => c.audio_hash);
  assert.equal(h.length, 3);
  assert.ok(h.every((x) => /^[0-9a-f]{8}$/.test(x)));
  assert.equal(h[0], h[2]);
  assert.notEqual(h[0], h[1]);
});
