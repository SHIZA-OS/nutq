#!/usr/bin/env node
// Measures how late the VAD triggers after the true speech onset, per recorded case.
// Read-only: prints a table and summary, writes nothing.
//
// Usage:
//   node eval/runner/vad-onset.mjs [--audio-dir ~/Shiza/nutq-eval-audio/cases] [--cases id,id]
//
// Each case WAV is cut into 512-sample frames (32 ms at 16 kHz, the frame size Nutq's
// Silero v5 uses) and fed frame by frame, offline, to the VAD that the real Transcriber
// loads in a headless page served by the Vite dev server (same Silero model, same
// vad-web 0.0.24 code, no fake mic). The STT model is stubbed out: only the VAD runs.
//
// Per case it reports:
//   - energy onset: first 20 ms window (320 samples) of int16 samples with RMS above 600
//     (600 is 1.5x the max window RMS of the silence recording sil-01), and the start of
//     the first run of 5 such windows (100 ms) as a check for early transients;
//   - the first frame with Silero probability >= 0.5 and >= 0.65 (0.65 is Nutq's
//     positiveSpeechThreshold, see VAD_OPTIONS in src/main.ts);
//   - delay = start of that frame minus the energy onset, in ms and in frames;
//   - ring = frames from the one containing the energy onset through the trigger frame,
//     inclusive: the pre-roll length that would have reached the onset.
//
// Limits: offline frames skip the browser's mic processing (echo cancellation, gain,
// noise suppression, resampling), and a 600 RMS energy onset can itself be late for soft
// onsets, so the delays are likely lower bounds. The 3 burst_affected recordings start
// with a loud non-speech burst, so their energy onset is the burst and is not comparable.

import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseJsonl, loadFlags } from "./wer.mjs";
import { REPO, makeTempDir, startVite } from "./vite-server.mjs";

const CHROME = "/usr/bin/google-chrome";
const FRAME = 512; // samples
const FRAME_MS = 32;
const WIN = 320; // 20 ms at 16 kHz
const RMS_THRESHOLD = 600;
const SUSTAINED_WINDOWS = 5;
const NUTQ_POSITIVE_THRESHOLD = 0.65; // keep in step with VAD_OPTIONS in src/main.ts
const NUTQ_MIN_SPEECH_FRAMES = 12;
const MODEL = "model/base"; // key only; the STT model is stubbed

function parseArgs(argv) {
  const args = { audioDir: join(homedir(), "Shiza/nutq-eval-audio/cases"), cases: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--audio-dir") args.audioDir = argv[++i].replace(/^~(?=\/)/, homedir());
    else if (argv[i] === "--cases") args.cases = argv[++i].split(",");
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

// 16 kHz mono int16 WAV -> int16 sample values.
function readInt16(path) {
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
      const x = new Int16Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + 8 + 2 * i);
      return x;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

function rmsWindows(x) {
  const r = [];
  for (let i = 0; i + WIN <= x.length; i += WIN) {
    let s = 0;
    for (let j = 0; j < WIN; j++) s += x[i + j] ** 2;
    r.push(Math.sqrt(s / WIN));
  }
  return r;
}

// ms of the first window above the threshold, and of the first run of SUSTAINED_WINDOWS of them
function energyOnset(x) {
  const r = rmsWindows(x);
  const first = r.findIndex((v) => v > RMS_THRESHOLD);
  let sustained = -1;
  for (let i = 0; i + SUSTAINED_WINDOWS <= r.length; i++) {
    if (r.slice(i, i + SUSTAINED_WINDOWS).every((v) => v > RMS_THRESHOLD)) {
      sustained = i;
      break;
    }
  }
  return { first: first < 0 ? null : first * 20, sustained: sustained < 0 ? null : sustained * 20 };
}

const firstAtOrAbove = (probs, t) => {
  const i = probs.findIndex((p) => p >= t);
  return i < 0 ? null : i;
};

function stats(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return { n: v.length, min: v[0], median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, max: v.at(-1) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = parseJsonl(readFileSync(join(REPO, "eval/wer/cases.jsonl"), "utf8")).rows.filter((c) => !args.cases || args.cases.includes(c.id));
  const flags = loadFlags();

  const userDataDir = makeTempDir("nutq-vadonset-");
  const vite = await startVite();
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const rows = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(vite.url);
    await page.evaluate(
      async ({ model, positive, minFrames }) => {
        const { Transcriber } = await import("/src/vendor/transcriber.ts");
        // Only the VAD is measured: stand in for the STT model so frames never trigger inference.
        Transcriber.models.set(model, { loadModel: async () => {}, generate: async () => "", isLoaded: () => true, isLoading: () => false });
        const st = { probs: [], starts: [] };
        const t = new Transcriber(
          model,
          { onFrame: (p) => st.probs.push(p.isSpeech), onSpeechStart: () => st.starts.push(st.probs.length - 1) },
          false,
          "quantized",
          { positiveSpeechThreshold: positive, minSpeechFrames: minFrames },
        );
        await t.load();
        window.__vad = { t, st };
      },
      { model: MODEL, positive: NUTQ_POSITIVE_THRESHOLD, minFrames: NUTQ_MIN_SPEECH_FRAMES },
    );

    for (const c of cases) {
      const wav = join(args.audioDir, `${c.id}.wav`);
      if (!existsSync(wav)) {
        console.error(`${c.id}: MISSING audio, skipped`);
        continue;
      }
      const x = readInt16(wav);
      const { probs, starts } = await page.evaluate(async (samples) => {
        const { t, st } = window.__vad;
        st.probs.length = 0;
        st.starts.length = 0;
        t.vadModel.frameProcessor.reset(); // fresh Silero state per recording, like a fresh page in run-wer
        t.vadModel.start();
        const f = new Float32Array(samples);
        for (let i = 0; i + 512 <= f.length; i += 512) await t.vadModel.processFrame(f.slice(i, i + 512));
        return { probs: [...st.probs], starts: [...st.starts] };
      }, Array.from(x, (v) => v / 32768));

      const onset = energyOnset(x);
      const i05 = firstAtOrAbove(probs, 0.5);
      const i65 = firstAtOrAbove(probs, NUTQ_POSITIVE_THRESHOLD);
      // the real onSpeechStart must land on the first frame at or above Nutq's threshold
      const startOk = (starts[0] ?? null) === i65;
      const at = (i) => {
        if (i === null || onset.first === null) return { idx: i, delayMs: null, delayFrames: null, ring: null };
        const delayMs = i * FRAME_MS - onset.first;
        return { idx: i, delayMs, delayFrames: delayMs / FRAME_MS, ring: i - Math.floor(onset.first / FRAME_MS) + 1 };
      };
      rows.push({
        id: c.id,
        category: c.category,
        burst: (flags[c.id] ?? []).includes("burst_affected"),
        silence: c.reference.trim() === "",
        onset,
        transient: onset.first !== null && onset.sustained !== null && onset.sustained - onset.first >= 200,
        t50: at(i05),
        t65: at(i65),
        startOk,
      });
    }
  } finally {
    await context.close();
    vite.child.kill();
  }

  // ---- report
  const fmt = (v, d = 0) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
  console.log("id       category            onset(first/sust)  >=0.5: frame delay(ms) fr ring   >=0.65: frame delay(ms) fr ring   notes");
  for (const r of rows) {
    const notes = [r.burst && "burst_affected", r.silence && "silence", r.transient && "early transient", !r.startOk && "onSpeechStart != first >=0.65"].filter(Boolean).join(", ");
    console.log(
      `${r.id.padEnd(8)} ${r.category.padEnd(19)} ${(fmt(r.onset.first) + "/" + fmt(r.onset.sustained)).padStart(9)}        ` +
        `${fmt(r.t50.idx).padStart(5)} ${fmt(r.t50.delayMs).padStart(8)} ${fmt(r.t50.delayFrames, 1).padStart(5)} ${fmt(r.t50.ring).padStart(4)}   ` +
        `${fmt(r.t65.idx).padStart(8)} ${fmt(r.t65.delayMs).padStart(8)} ${fmt(r.t65.delayFrames, 1).padStart(5)} ${fmt(r.t65.ring).padStart(4)}   ${notes}`,
    );
  }

  const groups = [
    ["first_word_soft (all)", rows.filter((r) => r.category === "first_word_soft" && !r.silence)],
    ["first_word_soft (excl. burst_affected)", rows.filter((r) => r.category === "first_word_soft" && !r.silence && !r.burst)],
    ["first_word_strong", rows.filter((r) => r.category === "first_word_strong" && !r.silence)],
    ["all non-silence, non-burst cases", rows.filter((r) => !r.silence && !r.burst)],
  ];
  console.log("\nsummary (delay of the trigger frame start after the 600 RMS energy onset; ring = frames to reach the onset)");
  for (const [name, g] of groups) {
    for (const [label, key] of [[">=0.5", "t50"], [">=0.65", "t65"]]) {
      const usable = g.filter((r) => r[key].delayMs !== null);
      const ms = stats(usable.map((r) => r[key].delayMs));
      const fr = stats(usable.map((r) => r[key].delayFrames));
      const ring = stats(usable.map((r) => r[key].ring));
      console.log(
        `${name.padEnd(40)} ${label.padEnd(7)} n=${usable.length}/${g.length}  ` +
          (ms ? `delay ms min ${fmt(ms.min)} median ${fmt(ms.median)} max ${fmt(ms.max)}; frames min ${fmt(fr.min, 1)} median ${fmt(fr.median, 1)} max ${fmt(fr.max, 1)}; ring min ${ring.min} median ${ring.median} max ${ring.max}` : "no usable cases"),
      );
    }
  }
}

main().catch((e) => {
  console.error(`vad-onset: ${e.message}`);
  process.exit(1);
});
