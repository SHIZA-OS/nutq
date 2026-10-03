#!/usr/bin/env node
// Offline commit-boundary replay: shows where the Transcriber cuts each recorded case into
// commits, which path fired each one, and what the STT returned. Prints to stdout only.
//
// Usage:
//   node eval/runner/replay-commits.mjs [--cases id,id] [--pre-roll 4] [--model model/base]
//     [--audio-dir ~/Shiza/nutq-eval-audio/cases] [--frames 95-120]
// --frames A-B also prints the Silero probability and the pause EMA of each input frame A..B.
//
// Each WAV is cut into 512-sample frames (32 ms at 16 kHz) and fed, faster than real time, to
// the real vendored Transcriber (real Silero VAD, real SpeechBuffer, real Moonshine model) in
// a headless page served by the Vite dev server. Commit points depend only on the frames, not
// on how fast inference runs, so they match a real-time run of the same samples. A wrapper on
// Transcriber.commit() records every commit: the input frame it fired on, the frame range
// of the audio it carried (pre-roll frames included), and the path:
//   pause-EMA    the pause gate in onFrameProcessed (fewer than 128 frames in the buffer)
//   cap          the 128 frame buffer cap in onFrameProcessed
//   onSpeechEnd  the VAD's own speech end
//   stop         Transcriber.stop() at the end of the turn
// A commit under the encoder minimum (895 samples) is listed as skipped; the model is not called.
// Streaming updates (generate on a view of the live buffer) are not commits and are not listed.
// After the file, zero frames are fed until 5 s after the last speech_end (the 5 s auto-send
// silence in main.ts; at most 10 s of padding), then stop() is called, like a finished turn.
//
// Limits: offline frames skip Chrome's mic processing (echo cancellation, noise suppression,
// auto gain, resampling), so a replay can differ from a mic run of the same recording.
// VAD options and the default pre-roll mirror src/main.ts; keep them in step.

import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseJsonl } from "./wer.mjs";
import { REPO, makeTempDir, startVite } from "./vite-server.mjs";

const CHROME = "/usr/bin/google-chrome";
const FRAME = 512; // samples
const VAD_OPTIONS = { positiveSpeechThreshold: 0.65, minSpeechFrames: 12 }; // keep in step with src/main.ts
const SILENCE_FRAMES = Math.round(5000 / 32); // SILENCE_COMMIT_MS in src/main.ts
const MAX_PAD_FRAMES = 312; // 10 s

function parseArgs(argv) {
  const args = { model: "model/base", audioDir: join(homedir(), "Shiza/nutq-eval-audio/cases"), cases: null, preRoll: 4, frames: null }; // 4 = PRE_ROLL_FRAMES in src/main.ts
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--audio-dir") args.audioDir = argv[++i].replace(/^~(?=\/)/, homedir());
    else if (argv[i] === "--cases") args.cases = argv[++i].split(",");
    else if (argv[i] === "--frames") args.frames = argv[++i].split("-").map(Number);
    else if (argv[i] === "--pre-roll") args.preRoll = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(args.preRoll) || args.preRoll < 0) throw new Error("--pre-roll takes a whole number of frames");
  return args;
}

// 16 kHz mono int16 WAV -> Float32 samples in [-1, 1).
// ponytail: third copy of this reader (run-model-only.mjs, vad-onset.mjs have their own); move to a shared module if it changes again.
function readSamples(path) {
  const b = readFileSync(path);
  let fmt = null;
  for (let off = 12; off + 8 <= b.length; ) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) {
        throw new Error(`${path}: expected 16 kHz mono int16 PCM, got ${JSON.stringify(fmt)}`);
      }
      const n = Math.min(size, b.length - off - 8) >> 1;
      const samples = new Array(n);
      for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(off + 8 + 2 * i) / 32768;
      return samples;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCases = parseJsonl(readFileSync(join(REPO, "eval/wer/cases.jsonl"), "utf8")).rows;
  if (args.cases) {
    const unknown = args.cases.filter((id) => !allCases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(", ")}`);
  }
  const cases = allCases.filter((c) => !args.cases || args.cases.includes(c.id));

  const vite = await startVite();
  const context = await chromium.launchPersistentContext(makeTempDir("nutq-replay-"), {
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(vite.url);
    const t0 = Date.now();
    await page.evaluate(
      async ({ model, vad, preRoll }) => {
        const { Transcriber, MIN_ENCODER_SAMPLES } = await import("/src/vendor/transcriber.ts");
        // Per-case state the generate() wrapper and the callbacks write to.
        const R = (window.__replay = { cur: 0, commits: [], pending: [], events: [], ema: 0, trace: [] });
        const mkTranscriber = () =>
          new Transcriber(
            model,
            {
              onFrame: (p, frame, ema) => {
                R.ema = ema;
                R.trace[R.cur] = [p.isSpeech, ema];
              },
              onSpeechStart: (pre) => R.events.push({ ev: "speech_start", at: R.cur, preRoll: pre }),
              onSpeechEnd: () => R.events.push({ ev: "speech_end", at: R.cur }),
            },
            false,
            "quantized",
            vad,
            preRoll,
          );
        window.__mk = mkTranscriber;
        const first = mkTranscriber();
        await first.load(); // loads the real STT model (shared by every later Transcriber) and the VAD
        // Streaming updates call generate() directly on a view of the live buffer (every commit passes
        // a copy). They only feed the live caption, so the replay answers them with "" instead of
        // spending model time on them; commit boundaries do not depend on them.
        const m = first.sttModel;
        const real = m.generate.bind(m);
        m.generate = async (audio) => {
          if (audio.buffer.byteLength > audio.byteLength) return "";
          // The Transcriber runs model calls one at a time, in the order the commits were made, so the
          // next commit that was not skipped is the one this call belongs to.
          const c = R.pending.shift();
          try {
            return (c.text = await real(audio));
          } catch (e) {
            c.error = String(e.message ?? e).split("\n")[0].slice(0, 80);
            throw e;
          }
        };
        // Every commit goes through Transcriber.commit(path, audio), which this wraps to record it.
        const orig = Transcriber.prototype.commit;
        Transcriber.prototype.commit = function (path, audio) {
          const n = audio.length / 512;
          const name = path === "commit" ? (n === 128 ? "cap" : "pause-EMA") : path === "speech_end" ? "onSpeechEnd" : path;
          const c = { path: name, fire: R.cur, from: R.cur - n + 1, to: R.cur, frames: n, samples: audio.length, ema: R.ema, skipped: audio.length < MIN_ENCODER_SAMPLES, text: null, error: null };
          R.commits.push(c);
          if (!c.skipped) R.pending.push(c);
          return orig.call(this, path, audio);
        };
        first.vadModel.destroy?.();
        first.audioContext.close();
      },
      { model: args.model, vad: VAD_OPTIONS, preRoll: args.preRoll },
    );
    console.error(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s; pre-roll ${args.preRoll} frames`);

    for (const c of cases) {
      const wav = join(args.audioDir, `${c.id}.wav`);
      if (!existsSync(wav)) {
        console.error(`${c.id}: MISSING audio, skipped`);
        continue;
      }
      const out = await page.evaluate(async (samples) => {
        const R = window.__replay;
        R.cur = 0;
        R.commits = [];
        R.pending = [];
        R.events = [];
        R.trace = [];
        const t = window.__mk(); // fresh Transcriber per case: new SpeechBuffer, pre-roll ring and isTalking
        await t.load();
        t.vadModel.frameProcessor.reset();
        t.vadModel.start();
        const f = new Float32Array(samples);
        const feed = async (frame) => {
          await t.vadModel.processFrame(frame);
          R.cur++;
        };
        let nFile = 0;
        for (let i = 0; i + 512 <= f.length; i += 512, nFile++) await feed(f.slice(i, i + 512));
        const lastEnd = () => R.events.findLast((e) => e.ev === "speech_end")?.at ?? null;
        for (let pad = 0; pad < 312 && !(lastEnd() !== null && R.cur - lastEnd() >= 156); pad++) await feed(new Float32Array(512));
        await t.stop(); // waits for every queued model call
        t.vadModel.destroy?.();
        t.audioContext.close();
        return { nFile, nTotal: R.cur, commits: R.commits, events: R.events, trace: R.trace };
      }, readSamples(wav));
      report(c, out, args.frames);
    }
  } finally {
    await context.close();
    vite.child.kill();
  }
}

function report(c, out, frames) {
  const ev = out.events.map((e) => `${e.ev}@${e.at}${e.preRoll !== undefined ? `(+${e.preRoll})` : ""}`).join(" ");
  console.log(`${c.id}  file ${out.nFile} frames, fed ${out.nTotal}  ${ev}`);
  out.commits.forEach((k, i) => {
    const what = k.error ? `ERROR ${k.error}` : k.skipped ? `skipped, ${k.samples} samples under the encoder minimum` : JSON.stringify(k.text);
    console.log(`  commit ${i + 1}  ${k.path.padEnd(11)} fired@${k.fire}  frames ${k.from}-${k.to} (${k.frames})  ema=${k.ema.toFixed(2)}  ${what}`);
  });
  if (frames) for (let i = frames[0]; i <= frames[1] && i < out.trace.length; i++) console.log(`  frame ${i}  p=${out.trace[i][0].toFixed(2)}  ema=${out.trace[i][1].toFixed(2)}`);
  console.log(`  text: ${JSON.stringify(out.commits.map((k) => k.text).filter(Boolean).join(" "))}`);
}

main().catch((e) => {
  console.error(`replay-commits: ${e.message}`);
  process.exit(1);
});
