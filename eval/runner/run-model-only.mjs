#!/usr/bin/env node
// Model-only WER run: each whole recorded WAV is fed straight to the vendored
// MoonshineModel.generate(), with no VAD, no SpeechBuffer, no Transcriber and no
// mic path, in a headless page served by the Vite dev server. This isolates the
// model from the pipeline. Nothing is sent to ZeroClaw.
//
// Usage:
//   node eval/runner/run-model-only.mjs --label <name> [--model model/base]
//     [--audio-dir ~/Shiza/nutq-eval-audio/cases] [--cases id,id]
//     [--trim-from-trigger <frames> --triggers <file>]
//
// --trim-from-trigger starts each WAV at (its VAD trigger frame + <frames>) instead of at
// sample 0 (a frame is 512 samples, 32 ms; clamped at 0). The trigger frame of each case is
// the first frame with Silero probability >= 0.65, as written by
// `node eval/runner/vad-onset.mjs --json <file>`, which is the file --triggers reads. +1 is
// what the pipeline records today, -3 is a 4 frame pre-roll. A case with no trigger gets no
// audio and an empty text, like a pipeline run that never detected speech.
//
// Output matches run-wer.mjs (eval/results/<date>-wer-<label>/{raw,summary.json,README.md})
// so wer.mjs scores it unchanged. Events files are synthesized in the run-wer events
// shape: stt_model, stt_committed {text} (omitted when the text is empty), and
// transcript_final {text, trigger: "model_only"}.
//
// The files are 8 s long with seconds of silence around short utterances, and the
// model returns an empty string for many of them (scored as all deletions), so this
// is not the model on a tightly segmented utterance.

import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { parseJsonl, scoreRun, loadEventsDir, loadFlags, numNormSection, burstSection } from "./wer.mjs";
import { REPO, makeTempDir, startVite } from "./vite-server.mjs";

const CHROME = "/usr/bin/google-chrome";
const FRAME = 512; // samples, 32 ms at 16 kHz

function parseArgs(argv) {
  const args = { model: "model/base", audioDir: join(homedir(), "Shiza/nutq-eval-audio/cases"), cases: null, label: null, trim: null, triggers: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--audio-dir") args.audioDir = argv[++i].replace(/^~(?=\/)/, homedir());
    else if (argv[i] === "--cases") args.cases = argv[++i].split(",");
    else if (argv[i] === "--label") args.label = argv[++i];
    else if (argv[i] === "--trim-from-trigger") args.trim = Number(argv[++i]);
    else if (argv[i] === "--triggers") args.triggers = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.label) throw new Error("--label is required");
  if (args.trim !== null && !Number.isInteger(args.trim)) throw new Error("--trim-from-trigger takes a whole number of frames");
  if ((args.trim === null) !== (args.triggers === null)) throw new Error("--trim-from-trigger and --triggers go together");
  return args;
}

// 16 kHz mono int16 WAV -> Float32 samples in [-1, 1). Anything else would silently skew WER.
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

function readme({ args, date, summary, run }) {
  const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const o = summary.overall_excluding_silence;
  const rows = summary.cases.map((r) => {
    const w = r.status === "scored" ? pct(r.wer) : r.status === "silence" ? `words_produced=${r.words_produced}` : r.reason;
    return `| ${r.id} | ${r.status} | ${w} | ${JSON.stringify(r.hypothesis ?? "")} |`;
  });
  return [
    `# ${date}: WER, model-only (${args.model}), ${args.label}`,
    "",
    args.trim === null
      ? "Each whole recorded WAV (16 kHz mono int16 as Float32) was passed straight to the vendored `MoonshineModel.generate()` (`quantized`, as the Transcriber uses) in a headless page served by the Vite dev server."
      : `Each recorded WAV (16 kHz mono int16 as Float32) was trimmed to start ${args.trim} frames (${args.trim * 32} ms) from its VAD trigger frame (first frame with Silero probability >= 0.65, from \`vad-onset.mjs --json\`), then passed to the vendored \`MoonshineModel.generate()\` (\`quantized\`, as the Transcriber uses) in a headless page served by the Vite dev server.`,
    "No VAD, no SpeechBuffer, no Transcriber, no mic path. This isolates the model from the pipeline. Nothing was sent to ZeroClaw.",
    "",
    "Caveat: the files are 8 s long with several seconds of silence around short utterances. The model returned an empty string for many of them (scored as all deletions), so this is not the same as the model on a tightly segmented utterance.",
    "",
    `- Cases attempted: ${run.attempted.length}; missing audio: ${run.missing_audio.length ? run.missing_audio.join(", ") : "none"}; run errors: ${run.errors.length ? run.errors.map((e) => e.id).join(", ") : "none"}`,
    `- Scored: ${summary.meta.n_scored}; no_transcript: ${summary.meta.n_no_transcript}; empty model outputs: ${summary.cases.filter((r) => r.status === "scored" && r.empty_hypothesis).length}`,
    `- Overall WER (corpus-level, excluding silence): ${pct(o.wer)} over ${o.ref_words} reference words (S${o.S} D${o.D} I${o.I})`,
    "",
    "| id | status | WER | hypothesis |",
    "|---|---|---|---|",
    ...rows,
    "",
    "Command: `" + `node eval/runner/run-model-only.mjs --label ${args.label} --model ${args.model}` + (args.cases ? ` --cases ${args.cases.join(",")}` : "") + (args.trim !== null ? ` --trim-from-trigger ${args.trim} --triggers ${args.triggers}` : "") + "`",
    "",
  ].join("\n") + burstSection(summary) + numNormSection(summary);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local
  const allCases = parseJsonl(readFileSync(join(REPO, "eval/wer/cases.jsonl"), "utf8")).rows;
  let cases = allCases;
  if (args.cases) {
    const unknown = args.cases.filter((id) => !allCases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(", ")}`);
    cases = allCases.filter((c) => args.cases.includes(c.id));
  }

  const outDir = join(REPO, "eval/results", `${date}-wer-${args.label}`);
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const userDataDir = makeTempDir("nutq-modelonly-");

  const run = { model: args.model, label: args.label, date, audio_dir: args.audioDir.replace(homedir(), "~"), attempted: [], missing_audio: [], errors: [] };
  let triggers = null;
  if (args.trim !== null) {
    const t = JSON.parse(readFileSync(args.triggers, "utf8"));
    if (t.frame_samples !== FRAME) throw new Error(`${args.triggers}: frame_samples is ${t.frame_samples}, expected ${FRAME}`);
    triggers = t.triggers;
    run.trim = { frames_from_trigger: args.trim, triggers_file: args.triggers, positive_threshold: t.positive_threshold, clamped_to_start: [], no_trigger: [] };
  }
  const vite = await startVite();
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(vite.url);
    const t0 = Date.now();
    await page.evaluate(async (m) => {
      const mod = await import("/src/vendor/model.ts");
      window.__model = new mod.default(m, "quantized"); // same precision the Transcriber passes
      await window.__model.loadModel();
    }, args.model);
    console.error(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    let ts = Date.now(); // synthetic, strictly increasing event timestamps
    for (const c of cases) {
      const wav = join(args.audioDir, `${c.id}.wav`);
      if (!existsSync(wav)) {
        run.missing_audio.push(c.id);
        console.error(`${c.id}: MISSING audio, skipped`);
        continue;
      }
      run.attempted.push(c.id);
      try {
        let samples = readSamples(wav);
        if (triggers) {
          if (!(c.id in triggers)) throw new Error(`no trigger for ${c.id} in ${args.triggers}`);
          if (triggers[c.id] === null) {
            run.trim.no_trigger.push(c.id);
            samples = [];
          } else {
            const startFrame = triggers[c.id] + args.trim;
            if (startFrame < 0) run.trim.clamped_to_start.push(c.id);
            samples = samples.slice(Math.max(0, startFrame) * FRAME);
          }
        }
        const text = samples.length ? await page.evaluate(async (a) => (await window.__model.generate(new Float32Array(a))) ?? "", samples) : "";
        const rows = [{ event: "stt_model", timestamp_ms: ts++, model: args.model }];
        if (text) rows.push({ event: "stt_committed", timestamp_ms: ts++, text });
        rows.push({ event: "transcript_final", timestamp_ms: ts++, text, trigger: "model_only" });
        writeFileSync(join(rawDir, `${c.id}.events.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        console.error(`${c.id.padEnd(7)} ${JSON.stringify(text)}`);
      } catch (e) {
        run.errors.push({ id: c.id, error: String(e.message ?? e).split("\n")[0] });
        console.error(`${c.id}: ERROR ${e.message}`);
      }
    }
  } finally {
    await context.close();
    vite.child.kill();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const scored = cases.filter((c) => run.attempted.includes(c.id));
  const summary = { run, ...scoreRun(scored, loadEventsDir(outDir), loadFlags()) };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(outDir, "README.md"), readme({ args, date, summary, run }));
  console.error(`wrote ${outDir}/summary.json and README.md`);
}

main().catch((e) => {
  console.error(`run-model-only: ${e.message}`);
  process.exit(1);
});
