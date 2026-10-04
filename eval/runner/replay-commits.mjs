#!/usr/bin/env node
// Offline commit-boundary replay: shows where the Transcriber cuts each recorded case into
// commits, which path fired each one, and what the STT returned. Prints to stdout only.
//
// Usage:
//   node eval/runner/replay-commits.mjs [--cases id,id] [--pre-roll 4] [--model model/base]
//     [--audio-dir ~/Shiza/nutq-eval-audio/cases] [--frames 95-120]
//     [--wer <label> [--phases 8]] [--policy fixed:<ms>|semantic|semantic:d,u,o,floor,ceil] [--latency-scale 1]
//     [--gate <results dir>]
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
// after a speech_end or misfire: 5000 ms, as in the baseline sweeps) the replay stops there; once the WAV has ended, zero frames are fed until the
// policy ends the turn or until WAV duration + 10 s, and then stop() is called as a manual stop.
//
// --policy picks the end-of-turn policy the replay drives (default fixed:5000, what every baseline used):
// fixed:<ms> is a fixed wait; semantic is the text-dependent wait with the SEMANTIC_WAITS of src/turn-policy.ts, and
// semantic:<done>,<unknown>,<open>,<floor>,<ceiling> sets them. The policy is fed what main.ts feeds it: the committed
// transcript and the number of commits in flight. The replay has no real clock, so a commit's text is delivered to the
// policy at its fire time plus a modelled model run time (endpoint-metrics.mjs commitLatencyMs, scaled by
// --latency-scale), one commit at a time in order, like the serialized model. The text itself is the real model's.
//
// Every case also gets an end-of-turn report: a second pass over the whole file with the same VAD and no policy gives the
// speech runs (endpoint-metrics.mjs), so the report can say whether the turn was cut off (premature) and how long after
// the true end of speech it ended. --gate <results dir> compares every v1 case, per phase, with that earlier sweep: it
// fails (exit 1) when a case has a new error against the reference, and lists changed hypotheses for review.
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
import { analyzeTurn, compareGate, parsePolicy, summarize } from "./endpoint-metrics.mjs";

const CHROME = "/usr/bin/google-chrome";
const FRAME = 512; // samples
const VAD_OPTIONS = { positiveSpeechThreshold: 0.65, minSpeechFrames: 12 }; // keep in step with src/main.ts
const FRAME_MS = 32; // 512 samples at 16 kHz
const GRACE_FRAMES = Math.floor(10000 / FRAME_MS); // run-wer.mjs stops manually this long after the WAV ends

function parseArgs(argv) {
  const args = { model: "model/base", audioDir: join(homedir(), "Shiza/nutq-eval-audio/cases"), cases: null, preRoll: 4, frames: null, wer: null, phases: 8, policy: undefined, latencyScale: 1, gate: null }; // 4 = PRE_ROLL_FRAMES in src/main.ts
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--audio-dir") args.audioDir = argv[++i].replace(/^~(?=\/)/, homedir());
    else if (argv[i] === "--cases") args.cases = argv[++i].split(",");
    else if (argv[i] === "--frames") args.frames = argv[++i].split("-").map(Number);
    else if (argv[i] === "--pre-roll") args.preRoll = Number(argv[++i]);
    else if (argv[i] === "--wer") args.wer = argv[++i];
    else if (argv[i] === "--phases") args.phases = Number(argv[++i]);
    else if (argv[i] === "--policy") args.policy = argv[++i];
    else if (argv[i] === "--latency-scale") args.latencyScale = Number(argv[++i]);
    else if (argv[i] === "--gate") args.gate = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(args.preRoll) || args.preRoll < 0) throw new Error("--pre-roll takes a whole number of frames");
  args.policySpec = parsePolicy(args.policy);
  if (!(args.latencyScale > 0)) throw new Error("--latency-scale takes a number above 0");
  if (args.gate && !args.wer) throw new Error("--gate needs --wer");
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
        async ({ model, vad, preRoll, frameMs, latencyScale }) => {
          const { Transcriber, MIN_ENCODER_SAMPLES } = await import("/src/vendor/transcriber.ts");
          const { TurnPolicy, SEMANTIC_WAITS, endHint, waitFor } = await import("/src/turn-policy.ts");
          const { commitLatencyMs } = await import("/eval/runner/endpoint-metrics.mjs");
          // Per-case state the generate() wrapper and the callbacks write to.
          const R = (window.__replay = { cur: 0, commits: [], pending: [], events: [], ema: 0, trace: [], policy: null, TurnPolicy, SEMANTIC_WAITS, endHint, waitFor });
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
                  R.arm();
                },
                onMisfire: () => {
                  R.events.push({ ev: "misfire", at: R.cur });
                  R.policy.misfire(R.cur * frameMs);
                  R.arm();
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
            } finally {
              c.resolve(); // the text (or the error) is there; deliver() may now hand it to the policy
            }
          };
          // Every commit goes through Transcriber.commit(path, audio), which this wraps to record it.
          const orig = Transcriber.prototype.commit;
          Transcriber.prototype.commit = function (path, audio) {
            const n = audio.length / 512;
            const name = path === "commit" ? (n === 128 ? "cap" : "pause-EMA") : path === "speech_end" ? "onSpeechEnd" : path;
            const c = { path: name, fire: R.cur, from: R.cur - n + 1, to: R.cur, frames: n, samples: audio.length, ema: R.ema, skipped: audio.length < MIN_ENCODER_SAMPLES, text: null, error: null };
            R.commits.push(c);
            if (!c.skipped) {
              R.pending.push(c);
              // The policy hears of the commit now, and of its text when the modelled run has finished: one
              // commit at a time, like the serialized model.
              const fireMs = R.cur * frameMs;
              c.arriveMs = R.finish = Math.max(R.finish, fireMs) + commitLatencyMs(audio.length, latencyScale);
              c.done = new Promise((res) => (c.resolve = res));
              R.queue.push(c);
              R.policy.setCommitsInFlight(++R.inflight, fireMs);
            }
            return orig.call(this, path, audio);
          };
          first.vadModel.destroy?.();
          first.audioContext.close();
        },
        { model: args.model, vad: VAD_OPTIONS, preRoll: args.preRoll, frameMs: FRAME_MS, latencyScale: args.latencyScale },
      );
      console.error(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s; pre-roll ${args.preRoll} frames`);
      return page;
    };
    let page = await openPage(context.pages()[0] ?? (await context.newPage()));

    const phases = args.wer ? [...Array(args.phases).keys()] : [0];
    const sweep = phases.map(() => ({ events: {}, attempted: [], errors: [], turns: {} }));
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
        const out = await page.evaluate(async ({ samples, frameMs, graceFrames, policy }) => {
          const R = window.__replay;
          const f = new Float32Array(samples);
          // Truth pass: the same VAD over the whole file with no policy and no model, for the report's speech runs.
          // (The callbacks need a policy; this one is thrown away.)
          R.cur = 0;
          R.trace = [];
          R.policy = new R.TurnPolicy();
          R.arm = () => {};
          const tt = window.__mk();
          await tt.load();
          tt.commit = () => Promise.resolve();
          tt.update = () => {};
          tt.vadModel.frameProcessor.reset();
          tt.vadModel.start();
          for (let i = 0; i + 512 <= f.length; i += 512) {
            await tt.vadModel.processFrame(f.slice(i, i + 512));
            R.cur++;
          }
          const truth = R.trace.map((x) => x[0]);
          tt.vadModel.destroy?.();
          tt.audioContext.close();

          R.cur = 0;
          R.commits = [];
          R.pending = [];
          R.events = [];
          R.trace = [];
          R.texts = []; // committed text the policy has been told about, in order
          R.finish = 0; // when the modelled model run of the last commit ends
          R.inflight = 0;
          R.queue = []; // commits whose text the policy has not been told yet
          R.arms = [];
          R.policy = new R.TurnPolicy(policy.kind === "fixed" ? policy.ms : (text, n) => R.waitFor(text, policy.waits ?? R.SEMANTIC_WAITS, n));
          const snapshot = (at) => ({ at, hint: R.endHint(R.texts.join(" ")), wait_ms: R.policy.wait(), text_chars: R.texts.join(" ").length, commits_in_flight: R.inflight });
          R.arm = () => R.arms.push(snapshot(R.cur * frameMs)); // what the policy knew when a wait was armed
          const t = window.__mk(); // fresh Transcriber per case: new SpeechBuffer, pre-roll ring and isTalking
          await t.load();
          t.vadModel.frameProcessor.reset();
          t.vadModel.start();
          // Hand the policy every commit whose modelled run has finished by `now`: its real text (waiting for the
          // real model call if it is still running), then the lower in-flight count, as main.ts does.
          const deliver = async (now) => {
            while (R.queue.length && R.queue[0].arriveMs <= now) {
              const c = R.queue.shift();
              await c.done;
              if (c.text) {
                R.texts.push(c.text);
                R.policy.transcript(R.texts.join(" "), c.arriveMs);
              }
              R.policy.setCommitsInFlight(--R.inflight, c.arriveMs);
            }
          };
          // One frame in; then the due texts, then ask the turn policy whether the turn has ended by now.
          const feed = async (frame) => {
            await t.vadModel.processFrame(frame);
            R.cur++;
            await deliver(R.cur * frameMs);
            return R.policy.tick(R.cur * frameMs);
          };
          let nFile = 0;
          let end = null;
          for (let i = 0; i + 512 <= f.length && !end; i += 512, nFile++) end = await feed(f.slice(i, i + 512));
          // The WAV is over: silence until the policy ends the turn, or until WAV duration + 10 s.
          const limit = nFile + graceFrames;
          while (!end && R.cur < limit) end = await feed(new Float32Array(512));
          const endState = snapshot(R.cur * frameMs); // what the policy knew when it decided
          const final = end ?? R.policy.manualStop(R.cur * frameMs);
          await t.stop(); // waits for every queued model call
          t.vadModel.destroy?.();
          t.audioContext.close();
          return { nFile, nTotal: R.cur, trigger: final.reason, endMs: final.at, endState, arms: R.arms, truth, commits: R.commits, events: R.events, trace: R.trace };
        }, { samples: [...new Array(lead).fill(0), ...readSamples(wav)], frameMs: FRAME_MS, graceFrames: GRACE_FRAMES, policy: args.policySpec });
        if (!args.wer) {
          report(c, out, args.frames, turnReport(out, out.commits.filter((k) => !k.skipped && k.text).map((k) => k.text)));
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
        sweep[phase].turns[c.id] = turnReport(out, texts);
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
    policy: args.policy ?? "fixed:5000",
    latency_scale: args.latencyScale,
    missing_audio: missing,
  };
  const phaseSummaries = sweep.map((sw, phase) => {
    const scored = cases.filter((c) => sw.attempted.includes(c.id));
    const summary = { run: { ...run, phase, lead_samples: phase * step, attempted: sw.attempted, errors: sw.errors }, ...scoreRun(scored, sw.events, flags), turns: sw.turns };
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
      const turns = sweep.map((sw) => sw.turns[c.id]);
      return {
        id: c.id,
        reference: c.reference,
        mean_num_norm_wer: mean(rows.map((x) => x.num_norm.wer)),
        distinct_hypotheses: new Set(rows.map((x) => x.hypothesis)).size,
        hypotheses: rows.map((x) => x.hypothesis),
        pause_ms: turns[0].pause_ms, // phase 0; the phases only shift the frame grid
        premature_phases: turns.filter((x) => x.premature).length,
        wait_after_true_end_ms: turns.map((x) => x.wait_after_true_end_ms),
        hint_at_arm: turns[0].hint_at_arm,
        wait_at_arm_ms: turns[0].wait_at_arm_ms,
      };
    });
  // End of turn over every phase of the cases in a set: how many were cut off, and the wait after the true end.
  const turnRows = (set) => cases.filter((c) => !missing.includes(c.id) && (set === "all" || (c.set ?? "v1") === set)).flatMap((c) => sweep.map((sw) => sw.turns[c.id]));
  const endpoint = {
    policy: args.policy ?? "fixed:5000",
    latency_scale: args.latencyScale,
    v1: summarize(turnRows("v1")),
    all: summarize(turnRows("all")),
  };
  const gate = args.gate ? gateAgainst(args.gate, phaseSummaries) : null;
  const aggregate = {
    run,
    endpoint,
    gate,
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
    "- **End of turn mirrors `run-wer.mjs`.** The same turn policy `main.ts` uses (`src/turn-policy.ts`) is driven with time from frame positions: auto-silence SILENCE_COMMIT_MS (5000 ms) after a speech end or misfire, cancelled by a speech start. After the WAV ends, silence is fed until the policy ends the turn or until WAV duration + 10 s, then the turn is stopped manually. Live baseline runs ended 32 of 37 turns with auto-silence.",
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
    "## end of turn",
    "",
    `Policy \`${endpoint.policy}\`, commit latency scale ${args.latencyScale}. Pooled over the ${args.phases} phases. "premature" is a turn an auto-silence ended while the file still held speech; the wait after the true end is counted from the last frame of speech (VAD probability 0.5 or above, gaps under 512 ms bridged), for turns that cut nothing off, and excludes the live flush after the end. Text reaches the policy at the commit's fire time plus a modelled model run time. The speech runs come from the VAD, so speech it misses (soft speech in the noise cases, for example bn-03's late \"Yes.\") is not seen as speech to come: premature can read false there, and a cut-off shows up as a deleted word in the WER (hence the v1 gate).`,
    "",
    "| set | turn-phases | with a pause | premature | true ends | wait median ms | wait p90 ms | wait max ms |",
    "|---|---|---|---|---|---|---|---|",
    ...["v1", "all"].map((k) => `| ${k} | ${endpoint[k].cases} | ${endpoint[k].with_pause} | ${endpoint[k].premature} | ${endpoint[k].true_ends} | ${endpoint[k].wait_median_ms} | ${endpoint[k].wait_p90_ms} | ${endpoint[k].wait_max_ms} |`),
    "",
    ...(gate
      ? [
          `**v1 gate against \`${gate.baseline}\`: ${gate.pass ? "PASS" : "FAIL"}.** ${gate.compared} v1 case-phases compared over ${gate.phases} phases: ${gate.fail.length} with a new error against the reference (fail), ${gate.review.length} with a changed hypothesis and no new error (for review); v1 normalized WER mean ${pct(gate.wer_mean)} vs ${pct(gate.baseline_wer_mean)}.`,
          "",
          ...gate.fail.map((m) => `- FAIL phase ${m.phase} ${m.id}: more ${m.more.join(", ")}: ${JSON.stringify(m.baseline)} became ${JSON.stringify(m.got)}`),
          ...gate.review.map((m) => `- review phase ${m.phase} ${m.id}: ${JSON.stringify(m.baseline)} became ${JSON.stringify(m.got)} (errors S/D/I ${m.errors.baseline.S}/${m.errors.baseline.D}/${m.errors.baseline.I} to ${m.errors.got.S}/${m.errors.got.D}/${m.errors.got.I})`),
          "",
        ]
      : []),
    "| id | pause ms | premature phases | hint at arm | wait at arm ms | wait after true end ms, per phase |",
    "|---|---|---|---|---|---|",
    ...caseRows.map((r) => `| ${r.id} | ${r.pause_ms ?? ""} | ${r.premature_phases} | ${r.hint_at_arm ?? ""} | ${r.wait_at_arm_ms ?? ""} | ${r.wait_after_true_end_ms.map((w) => w ?? "-").join(" ")} |`),
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
  if (gate) {
    console.error(`v1 gate against ${gate.baseline}: ${gate.pass ? "PASS" : "FAIL"} (${gate.fail.length} fail, ${gate.review.length} for review, of ${gate.compared} case-phases)`);
    if (!gate.pass) process.exitCode = 1;
  }
}

// The v1 gate against an earlier sweep (a results directory with phase-N/summary.json): per phase, every v1 case of
// the earlier sweep is compared with the same case here (compareGate). FAIL when a case has a new error against the
// reference; a case whose hypothesis changed without more errors is listed for review. Cases the earlier sweep did
// not have (later sets) are not compared.
function gateAgainst(dir, phaseSummaries) {
  const base = dir.startsWith("/") ? dir : join(REPO, "eval/results", dir);
  const fail = [];
  const review = [];
  let compared = 0;
  const baseWer = [];
  const gotWer = [];
  phaseSummaries.forEach((s, phase) => {
    const b = JSON.parse(readFileSync(join(base, `phase-${phase}`, "summary.json"), "utf8"));
    baseWer.push(b.case_sets.v1.num_norm.wer);
    gotWer.push(s.case_sets.v1.num_norm.wer);
    const baseCases = b.cases.filter((x) => x.set === "v1");
    compared += baseCases.length;
    const r = compareGate(baseCases, s.cases);
    fail.push(...r.fail.map((x) => ({ phase, ...x })));
    review.push(...r.review.map((x) => ({ phase, ...x })));
  });
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { baseline: dir, phases: phaseSummaries.length, compared, fail, review, baseline_wer_mean: mean(baseWer), wer_mean: mean(gotWer), pass: fail.length === 0 };
}

// The end-of-turn report of one case: when and how the turn ended against the recorded speech (endpoint-metrics.mjs),
// and what the policy knew at the last arm and when it decided.
function turnReport(out, texts) {
  const a = analyzeTurn({ probs: out.truth, endMs: out.endMs, trigger: out.trigger });
  const arm = out.arms[out.arms.length - 1] ?? null;
  return {
    trigger: out.trigger,
    turn_end_ms: out.endMs,
    ...a,
    hint_at_arm: arm?.hint ?? null,
    wait_at_arm_ms: arm?.wait_ms ?? null,
    text_chars_at_arm: arm?.text_chars ?? null,
    commits_in_flight_at_arm: arm?.commits_in_flight ?? null,
    hint_at_end: out.endState.hint,
    wait_at_end_ms: out.endState.wait_ms,
    commits_in_flight_at_end: out.endState.commits_in_flight,
    sent_text: texts.join(" "),
  };
}

function report(c, out, frames, turn) {
  const ev = out.events.map((e) => `${e.ev}@${e.at}${e.preRoll !== undefined ? `(+${e.preRoll})` : ""}`).join(" ");
  console.log(`${c.id}  file ${out.nFile} frames, fed ${out.nTotal}, turn ended by ${out.trigger}  ${ev}`);
  out.commits.forEach((k, i) => {
    const what = k.error ? `ERROR ${k.error}` : k.skipped ? `skipped, ${k.samples} samples under the encoder minimum` : JSON.stringify(k.text);
    console.log(`  commit ${i + 1}  ${k.path.padEnd(11)} fired@${k.fire}  frames ${k.from}-${k.to} (${k.frames})  ema=${k.ema.toFixed(2)}  ${what}`);
  });
  if (frames) for (let i = frames[0]; i <= frames[1] && i < out.trace.length; i++) console.log(`  frame ${i}  p=${out.trace[i][0].toFixed(2)}  ema=${out.trace[i][1].toFixed(2)}`);
  console.log(`  text: ${JSON.stringify(out.commits.map((k) => k.text).filter(Boolean).join(" "))}`);
  const pauses = turn.pauses.map((p) => `${p.ms} ms at ${p.start_ms}`).join(", ") || "none";
  console.log(`  end: ${turn.trigger} at ${turn.turn_end_ms} ms; last speech ended ${turn.last_speech_end_ms} ms; pauses: ${pauses}; premature: ${turn.premature}; wait after true end: ${turn.wait_after_true_end_ms} ms; hint at arm ${turn.hint_at_arm} (${turn.wait_at_arm_ms} ms)`);
}

main().catch((e) => {
  console.error(`replay-commits: ${e.message}`);
  process.exit(1);
});
