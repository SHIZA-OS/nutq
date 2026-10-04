// Tests the pure helpers that check a recording from its VAD trace and its WAV (endpoint-check.mjs): the measured
// pauses, a leading burst, and the flags that say a take may be unusable. Plain Node, no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { measureTake, wavStats, takeFlags } from "./endpoint-check.mjs";

const probs = (pattern) => [...pattern].map((c) => (c === "s" ? 0.9 : 0.05));
const sil = (n) => ".".repeat(n);
const sp = (n) => "s".repeat(n);

test("measureTake: one pause between two runs of speech, in ms, with where the speech starts and ends", () => {
  const m = measureTake([probs(sil(20) + sp(30) + sil(62) + sp(40) + sil(100))]);
  assert.deepEqual(m.gaps_ms, [62 * 32]);
  assert.equal(m.longest_gap_ms, 62 * 32);
  assert.equal(m.first_speech_ms, 20 * 32);
  assert.equal(m.last_speech_end_ms, 152 * 32);
  assert.equal(m.file_ms, 252 * 32);
  assert.equal(m.burst, false);
});

test("measureTake: the longest gap over the phases is reported as min, max and median", () => {
  const a = probs(sil(10) + sp(30) + sil(60) + sp(30) + sil(50));
  const b = probs(sil(10) + sp(30) + sil(62) + sp(30) + sil(50));
  const c = probs(sil(10) + sp(30) + sil(64) + sp(30) + sil(50));
  const m = measureTake([a, b, c]);
  assert.deepEqual(m.longest_gap_phases_ms, { min: 60 * 32, median: 62 * 32, max: 64 * 32 });
});

test("measureTake: a leading burst is a short run in the first frames, then at least 16 frames of silence before the speech", () => {
  assert.equal(measureTake([probs(sp(3) + sil(40) + sp(30) + sil(50))]).burst, true); // like fws-01 and bn-01: frames 0 to 2
  assert.equal(measureTake([probs(sil(1) + sp(2) + sil(30) + sp(30) + sil(50))]).burst, true);
  assert.equal(measureTake([probs(sil(20) + sp(3) + sil(40) + sp(30) + sil(50))]).burst, false); // not at the start
  assert.equal(measureTake([probs(sp(30) + sil(40) + sp(30) + sil(50))]).burst, false); // a real first part, not a click
  assert.equal(measureTake([probs(sp(3) + sil(10) + sp(30) + sil(50))]).burst, false); // the gap is a breath, merged into one run
  assert.equal(measureTake([probs(sil(100))]).burst, false);
});

test("measureTake: no speech at all", () => {
  const m = measureTake([probs(sil(100))]);
  assert.deepEqual([m.first_speech_ms, m.last_speech_end_ms, m.longest_gap_ms, m.gaps_ms], [null, null, null, []]);
});

// a 16 kHz mono int16 WAV from sample values
const wav = (samples) => {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "ascii"); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
  return b;
};

test("wavStats: duration, peak, rms and the share of clipped samples", () => {
  const w = wavStats(wav([0, 16384, -16384, 32767, 0, 0, 0, 0]));
  assert.equal(w.seconds, 8 / 16000);
  assert.equal(w.peak.toFixed(3), "1.000");
  assert.equal(w.clipped_frac, 1 / 8);
  assert.equal(wavStats(wav(new Array(16000).fill(0))).rms, 0);
  assert.throws(() => wavStats(Buffer.from("not a wav")), /WAV/);
});

const take = (o) => ({ burst: false, gaps_ms: [], longest_gap_ms: null, first_speech_ms: 1000, last_speech_end_ms: 5000, file_ms: 10000, longest_gap_phases_ms: { min: 0, median: 0, max: 0 }, ...o });
const stats = { seconds: 10, peak: 0.5, rms: 0.05, clipped_frac: 0 };

test("takeFlags: a clean pause take has no flags", () => {
  const f = takeFlags({ category: "pause_function_word", pause_s: 2 }, take({ gaps_ms: [2016], longest_gap_ms: 2016 }), stats, 0.1);
  assert.deepEqual(f, { unusable: [], note: [] });
});

test("takeFlags: no speech, a missing pause, speech cut off by the end of the file, clipping and a bad transcript are unusable", () => {
  const u = (c, t, s = stats, w = 0.1) => takeFlags(c, t, s, w).unusable;
  assert.deepEqual(u({ category: "true_end_trailing" }, take({ first_speech_ms: null, last_speech_end_ms: null })), ["no_speech"]);
  assert.deepEqual(u({ category: "pause_function_word", pause_s: 2 }, take({ gaps_ms: [], longest_gap_ms: null })), ["pause_missing"]);
  assert.deepEqual(u({ category: "pause_function_word", pause_s: 2 }, take({ gaps_ms: [400], longest_gap_ms: 400 })), ["pause_missing"]); // under 0.77 s the VAD never ends the segment
  assert.deepEqual(u({ category: "long_utterance" }, take({ last_speech_end_ms: 9950 })), ["speech_cut_off_by_file_end"]);
  assert.deepEqual(u({ category: "long_utterance" }, take(), { ...stats, clipped_frac: 0.02 }), ["clipped"]);
  assert.deepEqual(u({ category: "long_utterance" }, take(), { ...stats, peak: 0.01 }), ["very_quiet"]);
  assert.deepEqual(u({ category: "long_utterance" }, take(), stats, 0.8), ["transcript_far_from_script"]);
});

test("takeFlags: a pause far from the intended length, a second long gap and a leading burst are notes, not unusable", () => {
  const n = (c, t) => takeFlags(c, t, stats, 0.1).note;
  assert.deepEqual(n({ category: "pause_function_word", pause_s: 3.5 }, take({ gaps_ms: [2016], longest_gap_ms: 2016 })), ["pause_off_target"]); // 2.0 s against 3.5 s
  assert.deepEqual(n({ category: "pause_function_word", pause_s: 2 }, take({ gaps_ms: [2016, 800], longest_gap_ms: 2016 })), ["extra_gap"]);
  assert.deepEqual(n({ category: "long_utterance" }, take({ burst: true })), ["leading_burst"]);
  assert.deepEqual(takeFlags({ category: "pause_function_word", pause_s: 2 }, take({ gaps_ms: [2016], longest_gap_ms: 2016 }), stats, 0.1).unusable, []);
});
