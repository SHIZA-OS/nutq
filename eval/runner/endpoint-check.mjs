// Pure helpers that check a recording from its VAD trace and its WAV, before it goes into an end-of-turn sweep: the
// pauses it really has, a leading burst (a click before the speech, like fws-01, bn-01 and bn-03), and flags that say a
// take may be unusable. Nothing here drops a case: it only reports.

import { FRAME_MS, speechRuns } from "./endpoint-metrics.mjs";

// A pause the VAD can see: it ends a segment after 24 frames (768 ms) below its negative threshold.
const VAD_VISIBLE_MS = 768;

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// What the VAD probabilities of one recording say. `phases` is one probability array per phase of the frame grid (the
// phases only shift the grid, so the first one gives the numbers and all of them give the spread of the longest gap).
// - gaps_ms: the pauses (gaps of 16 frames or more between runs of speech), in order.
// - burst: a short run (6 frames or fewer) in the first 4 frames and then a pause before the real speech.
export function measureTake(phases) {
  const runs = speechRuns(phases[0]);
  const gapsOf = (r) => r.slice(1).map((x, i) => (x.start - r[i].end - 1) * FRAME_MS);
  const gaps_ms = gapsOf(runs);
  const longest = (g) => (g.length ? Math.max(...g) : null);
  const longs = phases.map((p) => longest(gapsOf(speechRuns(p)))).filter((x) => x !== null);
  const first = runs[0];
  return {
    gaps_ms,
    longest_gap_ms: longest(gaps_ms),
    longest_gap_phases_ms: longs.length ? { min: Math.min(...longs), median: median(longs), max: Math.max(...longs) } : null,
    first_speech_ms: first ? first.start * FRAME_MS : null,
    last_speech_end_ms: runs.length ? (runs[runs.length - 1].end + 1) * FRAME_MS : null,
    file_ms: phases[0].length * FRAME_MS,
    burst: !!first && runs.length > 1 && first.start <= 3 && first.end - first.start + 1 <= 6,
  };
}

// Duration, peak (0 to 1), rms and the share of clipped samples of a 16 kHz mono int16 WAV.
export function wavStats(b) {
  for (let off = 12; off + 8 <= b.length; ) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") {
      const n = Math.min(size, b.length - off - 8) >> 1;
      let peak = 0;
      let sq = 0;
      let clipped = 0;
      for (let i = 0; i < n; i++) {
        const v = b.readInt16LE(off + 8 + 2 * i);
        peak = Math.max(peak, Math.abs(v));
        sq += v * v;
        if (Math.abs(v) >= 32767) clipped++;
      }
      return { seconds: n / 16000, peak: peak / 32768, rms: Math.sqrt(sq / (n || 1)) / 32768, clipped_frac: n ? clipped / n : 0 };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("not a WAV with a data chunk");
}

// Flags for one take. `c` is the case row (category, pause_s), `m` is measureTake, `w` is wavStats and `wer` the word
// error rate of the transcript against the script. unusable: the take cannot answer what it was recorded for; note:
// worth knowing, the take still can. Noise-only and silence recordings have no speech by design: only clipping applies.
export function takeFlags(c, m, w, wer) {
  const unusable = [];
  const note = [];
  if (w.clipped_frac > 0.005) unusable.push("clipped");
  if (c.category === "noise_only" || c.category === "silence") return { unusable, note };
  if (m.first_speech_ms === null) return { unusable: ["no_speech", ...unusable], note };
  if (w.peak < 0.05) unusable.push("very_quiet");
  if (m.file_ms - m.last_speech_end_ms < 150) unusable.push("speech_cut_off_by_file_end");
  if (wer > 0.5) unusable.push("transcript_far_from_script");
  const longest = m.longest_gap_ms;
  if (c.pause_s !== undefined) {
    if (longest === null || longest < VAD_VISIBLE_MS) unusable.push("pause_missing");
    else {
      const ratio = longest / (c.pause_s * 1000);
      if (ratio < 0.6 || ratio > 1.5) note.push("pause_off_target");
    }
  }
  const others = m.gaps_ms.filter((g, i) => (c.pause_s === undefined ? true : i !== m.gaps_ms.indexOf(longest)) && g >= VAD_VISIBLE_MS);
  if (others.length) note.push("extra_gap");
  if (m.burst) note.push("leading_burst");
  return { unusable: [...new Set(unusable)].sort((a, b) => order(a) - order(b)), note };
}

const order = (f) => ["no_speech", "pause_missing", "speech_cut_off_by_file_end", "clipped", "very_quiet", "transcript_far_from_script"].indexOf(f);

