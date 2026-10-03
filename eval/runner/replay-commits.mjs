#!/usr/bin/env node
// Offline commit-boundary replay: shows where the Transcriber cuts each recorded case into
// commits, which path fired each one, and what the STT returned. Prints to stdout only.
//
// Usage:
//   node eval/runner/replay-commits.mjs [--cases id,id] [--pre-roll 4] [--model model/base]
//     [--audio-dir ~/Shiza/nutq-eval-audio/cases] [--frames 95-120]
//     [--wer <label> [--phases 8]]
// --frames A-B also prints the Silero probability and the pause EMA of each input frame A..B.
//
// --wer <label> is the phase-swept WER mode: instead of printing commits, every case is run at each
// of --phases (default 8) frame phases, scored with wer.mjs, and written to
// eval/results/<date>-wer-<label>/ (summary.json and README.md for the whole sweep, phase-N/summary.json
// per phase in wer.mjs's own format). Phase p prepends p * (512 / phases) zero samples (64 samples,
// 4 ms, per phase for 8 phases), so the frame boundaries fall at a different place relative to the
// speech. Everything is deterministic: no timestamps are written.
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
// The end of the turn mirrors run-wer.mjs: src/turn-policy.ts (the module main.ts uses) is driven with
// time taken from frame positions (frame i is at i * 32 ms). If it ends the turn (auto_silence, SILENCE_COMMIT_MS
// after a speech_end or misfire: 1200 ms, it was 5000 ms in the baseline sweeps) the replay stops there; once the WAV has ended, zero frames are fed until the
// policy ends the turn or until WAV duration + 10 s, and then stop() is called as a manual stop.
//
// Limits: offline frames skip Chrome's mic processing (echo cancellation, noise suppression,
// auto gain, resampling), so a replay can differ from a mic run of the same recording.
// VAD options and the default pre-roll mirror src/main.ts; keep them in step.

import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseJsonl, scoreRun, loadFlags } from "./wer.mjs";
import { REPO, makeTempDir, startVite } from "./vite-server.mjs";

const CHROME = "/usr/bin/google-chrome";
const FRAME = 512; // samples
const VAD_OPTIONS = { positiveSpeechThreshold: 0.65, minSpeechFrames: 12 }; // keep in step with src/main.ts
const FRAME_MS = 32; // 512 samples at 16 kHz
const GRACE_FRAMES = Math.floor(10000 / FRAME_MS); // run-wer.mjs stops manually this long after the WAV ends

function parseArgs(argv) {
  const args = { model: "model/base", audioDir: join(homedir(), "Shiza/nutq-eval-audio/cases"), cases: null, preRoll: 4, frames: null, wer: null, phases: 8 }; // 4 = PRE_ROLL_FRAMES in src/main.ts
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--audio-dir") args.audioDir = argv[++i].replace(/^~(?=\/)/, homedir());
    else if (argv[i] === "--cases") args.cases = argv[++i].split(",");
    else if (argv[i] === "--frames") args.frames = argv[++i].split("-").map(Number);
    else if (argv[i] === "--pre-roll") args.preRoll = Number(argv[++i]);
    else if (argv[i] === "--wer") args.wer = argv[++i];
    else if (argv[i] === "--phases") args.phases = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(args.preRoll) || args.preRoll < 0) throw new Error("--pre-roll takes a whole number of frames");
  if (!Number.isInteger(args.phases) || args.phases < 1 || FRAME % args.phases !== 0) throw new Error("--phases must divide 512");
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
    // A page is opened per phase in the sweep: every case loads a fresh Silero session that is never
    // released, and after about 270 of them the page runs out of wasm memory ("offset is out of bounds").
    const openPage = async (page) => {
      await page.goto(vite.url);
      const t0 = Date.now();
      await page.evaluate(
        async ({ model, vad, preRoll, frameMs }) => {
          const { Transcriber, MIN_ENCODER_SAMPLES } = await import("/src/vendor/transcriber.ts");
          const { TurnPolicy } = await import("/src/turn-policy.ts");
          // Per-case state the generate() wrapper and the callbacks write to.
          const R = (window.__replay = { cur: 0, commits: [], pending: [], events: [], ema: 0, trace: [], policy: null, TurnPolicy });
          const mkTranscriber = () =>
            new Transcriber(
              model,
              {
                onFrame: (p, frame, ema) => {
                  R.ema = ema;
                  R.trace[R.cur] = [p.isSpeech, ema];
                },
                onSpeechStart: (pre) => {
                  R.events.push({ ev: "speech_start", at: R.cur, preRoll: pre });
                  R.policy.speechStart(R.cur * frameMs);
                },
                onSpeechEnd: () => {
                  R.events.push({ ev: "speech_end", at: R.cur });
                  R.policy.speechEnd(R.cur * frameMs);
                },
                onMisfire: () => {
                  R.events.push({ ev: "misfire", at: R.cur });
                  R.policy.misfire(R.cur * frameMs);
                },
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
        { model: args.model, vad: VAD_OPTIONS, preRoll: args.preRoll, frameMs: FRAME_MS },
      );
      console.error(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s; pre-roll ${args.preRoll} frames`);
      return page;
    };
    let page = await openPage(context.pages()[0] ?? (await context.newPage()));

    const phases = args.wer ? [...Array(args.phases).keys()] : [0];
    const sweep = phases.map(() => ({ events: {}, attempted: [], errors: [] }));
    const missing = [];
    for (const phase of phases) {
      if (phase > 0) {
        const old = page;
        page = await openPage(await context.newPage());
        await old.close();
      }
      const lead = phase * (FRAME / args.phases);
      for (const c of cases) {
        const wav = join(args.audioDir, `${c.id}.wav`);
        if (!existsSync(wav)) {
          if (phase === 0) {
            missing.push(c.id);
            console.error(`${c.id}: MISSING audio, skipped`);
          }
          continue;
        }
        const out = await page.evaluate(async ({ samples, frameMs, graceFrames }) => {
          const R = window.__replay;
          R.cur = 0;
          R.commits = [];
          R.pending = [];
          R.events = [];
          R.trace = [];
          R.policy = new R.TurnPolicy();
          const t = window.__mk(); // fresh Transcriber per case: new SpeechBuffer, pre-roll ring and isTalking
          await t.load();
          t.vadModel.frameProcessor.reset();
          t.vadModel.start();
          const f = new Float32Array(samples);
          // One frame in; then ask the turn policy whether the turn has ended by now.
          const feed = async (frame) => {
            await t.vadModel.processFrame(frame);
            R.cur++;
            return R.policy.tick(R.cur * frameMs);
          };
          let nFile = 0;
          let end = null;
          for (let i = 0; i + 512 <= f.length && !end; i += 512, nFile++) end = await feed(f.slice(i, i + 512));
          // The WAV is over: silence until the policy ends the turn, or until WAV duration + 10 s.
          const limit = nFile + graceFrames;
          while (!end && R.cur < limit) end = await feed(new Float32Array(512));
          const trigger = (end ?? R.policy.manualStop(R.cur * frameMs)).reason;
          await t.stop(); // waits for every queued model call
          t.vadModel.destroy?.();
          t.audioContext.close();
          return { nFile, nTotal: R.cur, trigger, commits: R.commits, events: R.events, trace: R.trace };
        }, { samples: [...new Array(lead).fill(0), ...readSamples(wav)], frameMs: FRAME_MS, graceFrames: GRACE_FRAMES });
        if (!args.wer) {
          report(c, out, args.frames);
          continue;
        }
        // Events in the shape run-wer.mjs saves, so wer.mjs scores them unchanged. The transcript is the
        // committed pieces joined with spaces, like sessionTranscript in main.ts.
        const texts = out.commits.filter((k) => !k.skipped && k.text).map((k) => k.text);
        let ts = 0;
        sweep[phase].events[c.id] = [
          { event: "stt_model", timestamp_ms: ts++, model: args.model },
          ...texts.map((text) => ({ event: "stt_committed", timestamp_ms: ts++, text })),
          { event: "transcript_final", timestamp_ms: ts++, text: texts.join(" "), trigger: out.trigger },
        ];
        sweep[phase].attempted.push(c.id);
        for (const k of out.commits.filter((k) => k.error)) sweep[phase].errors.push({ id: c.id, error: k.error });
        console.error(`phase ${phase} ${c.id.padEnd(7)} ${out.trigger.padEnd(12)} ${JSON.stringify(texts.join(" "))}`);
      }
    }
    if (args.wer) writeSweep(args, cases, sweep, missing);
  } finally {
    await context.close();
    vite.child.kill();
  }
}

// Scores every phase with wer.mjs and writes the sweep: per-phase summaries in wer.mjs's format, plus one
// summary.json and README.md across phases. v1 is the original case set (see case_sets in wer.mjs);
// "first words /26" counts first_word_ok over the 26 cases where untrimmed model-only produced text.
function writeSweep(args, cases, sweep, missing) {
  const date = new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local
  const outDir = join(REPO, "eval/results", `${date}-wer-${args.wer}`);
  mkdirSync(outDir, { recursive: true });
  const flags = loadFlags();
  const modelOnly = JSON.parse(readFileSync(join(REPO, "eval/results/2026-10-02-wer-model-only-base/summary.json"), "utf8"));
  const set26 = modelOnly.cases.filter((c) => c.status === "scored" && !c.empty_hypothesis && c.ref_words > 0).map((c) => c.id);
  const step = FRAME / args.phases;
  const run = {
    label: args.wer,
    date,
    model: args.model,
    pre_roll_frames: args.preRoll,
    phases: args.phases,
    phase_step_samples: step,
    phase_method: "phase p prepends p * phase_step_samples zero samples to the WAV",
    end_of_turn: "turn policy (src/turn-policy.ts) with time from frame positions; after the WAV, silence until it ends the turn or WAV duration + 10 s, then a manual stop",
    missing_audio: missing,
  };
  const phaseSummaries = sweep.map((sw, phase) => {
    const scored = cases.filter((c) => sw.attempted.includes(c.id));
    const summary = { run: { ...run, phase, lead_samples: phase * step, attempted: sw.attempted, errors: sw.errors }, ...scoreRun(scored, sw.events, flags) };
    mkdirSync(join(outDir, `phase-${phase}`), { recursive: true });
    writeFileSync(join(outDir, `phase-${phase}`, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    return summary;
  });
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const v1 = (s) => s.case_sets.v1;
  const fw26 = (s) => set26.filter((id) => s.cases.find((c) => c.id === id)?.first_word_ok).length;
  const perPhase = phaseSummaries.map((s, phase) => ({
    phase,
    lead_samples: phase * step,
    v1_num_norm_wer: v1(s).num_norm.wer,
    v1_raw_wer: v1(s).wer,
    ref_words: v1(s).ref_words,
    n_scored: v1(s).n_scored,
    first_word_26: fw26(s),
    first_word_soft_ok: s.first_word.first_word_soft.first_word_ok,
    turns_auto_silence: s.cases.filter((c) => c.trigger === "auto_silence").length,
    turns_manual: s.cases.filter((c) => c.trigger === "manual").length,
    n_commit_cases: s.cases.filter((c) => c.n_commits > 1).length,
    errors: s.run.errors.length,
  }));
  const caseRows = cases
    .filter((c) => !missing.includes(c.id) && c.reference.trim() !== "")
    .map((c) => {
      const rows = phaseSummaries.map((s) => s.cases.find((x) => x.id === c.id));
      return {
        id: c.id,
        reference: c.reference,
        mean_num_norm_wer: mean(rows.map((x) => x.num_norm.wer)),
        distinct_hypotheses: new Set(rows.map((x) => x.hypothesis)).size,
        hypotheses: rows.map((x) => x.hypothesis),
      };
    });
  const aggregate = {
    run,
    per_phase: perPhase,
    mean_across_phases: {
      v1_num_norm_wer: mean(perPhase.map((p) => p.v1_num_norm_wer)),
      v1_raw_wer: mean(perPhase.map((p) => p.v1_raw_wer)),
      first_word_26: mean(perPhase.map((p) => p.first_word_26)),
    },
    v1_num_norm_wer_range: [Math.min(...perPhase.map((p) => p.v1_num_norm_wer)), Math.max(...perPhase.map((p) => p.v1_num_norm_wer))],
    cases: caseRows,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(aggregate, null, 2) + "\n");
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const m = aggregate.mean_across_phases;
  const readme = [
    `# ${date}: phase-swept replay WER, ${args.wer} (${args.model})`,
    "",
    "Every recorded case is replayed offline through the real Transcriber (real Silero VAD, SpeechBuffer and Moonshine model; `replay-commits.mjs --wer`) at each of " +
      `${args.phases} frame phases, and scored with wer.mjs. Phase p prepends p x ${step} zero samples to the WAV (${step} samples = ${(step / 16).toFixed(0)} ms), so the 512 sample frame boundaries fall at a different place relative to the speech. Pre-roll ${args.preRoll} frames.`,
    "",
    "- **End of turn mirrors `run-wer.mjs`.** The same turn policy `main.ts` uses (`src/turn-policy.ts`) is driven with time from frame positions: auto-silence SILENCE_COMMIT_MS after a speech end or misfire (1200 ms; the baseline sweeps used 5000 ms), cancelled by a speech start. After the WAV ends, silence is fed until the policy ends the turn or until WAV duration + 10 s, then the turn is stopped manually. Live baseline runs ended 32 of 37 turns with auto-silence.",
    "- Not modelled: Chrome's mic capture and processing, resampling from the capture rate, real-time scheduling (model runs do not delay frames here), and streaming updates (answered with an empty string).",
    "- Deterministic by construction: no timestamps are written, and two runs of the same code are expected to be identical.",
    "- This is a different measurement from the live runs (`run-wer.mjs`). Use it to compare logic changes; take absolute numbers from interleaved live runs.",
    "",
    `Missing audio: ${missing.length ? missing.join(", ") : "none"}. v1 is the original case set (silence and empty-reference cases excluded); first words /26 counts first_word_ok over the 26 cases where untrimmed model-only produced text.`,
    "",
    "| phase | lead samples | v1 normalized WER | v1 raw WER | first words /26 | soft first words /5 | multi-commit cases | turns ended by auto_silence / stop |",
    "|---|---|---|---|---|---|---|---|",
    ...perPhase.map((p) => `| ${p.phase} | ${p.lead_samples} | ${pct(p.v1_num_norm_wer)} | ${pct(p.v1_raw_wer)} | ${p.first_word_26} | ${p.first_word_soft_ok} | ${p.n_commit_cases} | ${p.turns_auto_silence} / ${p.turns_manual} |`),
    `| **mean across phases** | | **${pct(m.v1_num_norm_wer)}** | **${pct(m.v1_raw_wer)}** | **${m.first_word_26.toFixed(1)}** | | | |`,
    "",
    `Range of v1 normalized WER across phases: ${pct(aggregate.v1_num_norm_wer_range[0])} to ${pct(aggregate.v1_num_norm_wer_range[1])}.`,
    "",
    "## per case",
    "",
    "Mean normalized WER across phases, the number of distinct hypotheses over the phases, and the phase 0 hypothesis. Every phase's hypothesis is in `summary.json`.",
    "",
    "| id | mean WER | distinct hypotheses | phase 0 hypothesis |",
    "|---|---|---|---|",
    ...caseRows.map((r) => `| ${r.id} | ${pct(r.mean_num_norm_wer)} | ${r.distinct_hypotheses} | ${JSON.stringify(r.hypotheses[0])} |`),
    "",
    "Command: `" + `node eval/runner/replay-commits.mjs --wer ${args.wer} --phases ${args.phases} --pre-roll ${args.preRoll}` + (args.cases ? ` --cases ${args.cases.join(",")}` : "") + "`",
    "",
  ].join("\n");
  writeFileSync(join(outDir, "README.md"), readme);
  console.error(`wrote ${outDir}/summary.json, README.md and ${args.phases} phase summaries`);
}

function report(c, out, frames) {
  const ev = out.events.map((e) => `${e.ev}@${e.at}${e.preRoll !== undefined ? `(+${e.preRoll})` : ""}`).join(" ");
  console.log(`${c.id}  file ${out.nFile} frames, fed ${out.nTotal}, turn ended by ${out.trigger}  ${ev}`);
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
