// Pure helpers for the replay's end-of-turn report (replay-commits.mjs): speech runs and pauses from per-frame
// VAD probabilities, premature sends, the wait after the true end of speech, a summary, the commit latency
// model and the --policy argument. No browser and no model, so they are tested on their own.

export const FRAME_MS = 32; // 512 samples at 16 kHz

// A frame is speech at this Silero probability or above. Lower than the VAD's own 0.65 start threshold: this
// is "is the person still talking", not "should a segment start".
export const SPEECH_P = 0.5;
// A gap shorter than this many frames (512 ms) is a breath or a gap between words, not a pause.
export const MERGE_FRAMES = 16;

// Runs of speech [{ start, end }] (frame indices, inclusive) from one probability per frame.
export function speechRuns(probs) {
  const runs = [];
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] < SPEECH_P) continue;
    const last = runs[runs.length - 1];
    if (last && i - last.end - 1 < MERGE_FRAMES) last.end = i;
    else runs.push({ start: i, end: i });
  }
  return runs;
}

// What the end of one turn means against the recorded audio. `probs` is the VAD probability of every frame of
// the whole file, from a pass that no policy interrupted; `endMs` is when the turn ended (same time base: frame
// i covers [i * 32, (i + 1) * 32) ms) and `trigger` how.
// - pauses: the gaps between runs of speech, and pause_ms the longest one (null when there is none).
// - premature: an auto-silence ended the turn and there was still speech to come.
// - cut_into_pause_ms: for a premature turn, how long after the last speech it ended.
// - wait_after_true_end_ms: for an auto-silence that did not cut anything off, how long after the last
//   speech it ended. Excludes the live flush after the end.
export function analyzeTurn({ probs, endMs, trigger }) {
  const runs = speechRuns(probs);
  const pauses = runs.slice(1).map((r, i) => {
    const start_ms = (runs[i].end + 1) * FRAME_MS;
    const end_ms = r.start * FRAME_MS;
    return { start_ms, end_ms, ms: end_ms - start_ms };
  });
  const auto = trigger === "auto_silence";
  const premature = auto && runs.some((r) => r.start * FRAME_MS > endMs);
  const before = runs.filter((r) => r.start * FRAME_MS <= endMs);
  const lastBefore = before.length ? (before[before.length - 1].end + 1) * FRAME_MS : null;
  const lastEnd = runs.length ? (runs[runs.length - 1].end + 1) * FRAME_MS : null;
  return {
    last_speech_end_ms: lastEnd,
    pauses,
    pause_ms: pauses.length ? Math.max(...pauses.map((p) => p.ms)) : null,
    premature,
    cut_into_pause_ms: premature && lastBefore !== null ? endMs - lastBefore : null,
    wait_after_true_end_ms: auto && !premature && lastEnd !== null ? endMs - lastEnd : null,
  };
}

// Nearest-rank quantile, q in (0, 1]; null for no values.
export function quantile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}

// Counts over rows of analyzeTurn results: how many cases, how many have a pause and were cut off, and the wait
// after the true end over the turns that were not.
export function summarize(rows) {
  const waits = rows.map((r) => r.wait_after_true_end_ms).filter((w) => w !== null);
  return {
    cases: rows.length,
    with_pause: rows.filter((r) => r.pause_ms !== null).length,
    premature: rows.filter((r) => r.premature).length,
    true_ends: waits.length,
    wait_median_ms: quantile(waits, 0.5),
    wait_p90_ms: quantile(waits, 0.9),
    wait_max_ms: waits.length ? Math.max(...waits) : null,
  };
}

// How long the model takes for a commit of this many samples, in ms: a line fitted to 297 live commit calls
// (serial-model-2 runs 1 to 3: 269 ms per second of audio minus 61 ms, residual sd 191 ms), at least 100 ms,
// times `scale` for a sensitivity check. The replay has no real clock, so it places the text's arrival with this.
export function commitLatencyMs(samples, scale) {
  return Math.round(Math.max(100, Math.round(269 * (samples / 16000) - 61)) * scale);
}

// The --policy argument: "fixed:<ms>", "semantic" (the SEMANTIC_WAITS of src/turn-policy.ts) or
// "semantic:<done>,<unknown>,<open>,<floor>,<ceiling>", with ",tier2" after them for the second open list (src/turn-policy.ts). Absent is the fixed 5000 the baselines were run with.
export function parsePolicy(arg) {
  if (arg === undefined) return { kind: "fixed", ms: 5000 };
  const bad = () => new Error(`--policy takes fixed:<ms>, semantic or semantic:<done>,<unknown>,<open>,<floor>,<ceiling>[,tier2], got "${arg}"`);
  const num = (s) => (/^\d+$/.test(s) ? Number(s) : NaN);
  if (arg.startsWith("fixed:")) {
    const ms = num(arg.slice(6));
    if (Number.isNaN(ms)) throw bad();
    return { kind: "fixed", ms };
  }
  if (arg === "semantic") return { kind: "semantic", waits: null };
  if (arg.startsWith("semantic:")) {
    const parts = arg.slice(9).split(",");
    const tier2 = parts.length === 6 && parts[5] === "tier2";
    const n = parts.slice(0, 5).map(num);
    if ((parts.length !== 5 && !tier2) || n.length !== 5 || n.some(Number.isNaN)) throw bad();
    const [done, unknown, open, floor, ceiling] = n;
    return { kind: "semantic", waits: { done, unknown, open, floor, ceiling, ...(tier2 ? { tier2 } : {}) } };
  }
  throw bad();
}

// The v1 gate: compare each case of a new run with the same case of a baseline run (cases are the per-case rows of
// a wer.mjs summary). Errors are counted against the reference after number normalization: num_norm { S, D, I }; a case
// with an empty reference (sil-01, no-01 to no-04) is scored "silence" and counts each word it produced as an insertion.
// A case FAILS when it has more substitutions, deletions or insertions than the baseline (`more` names which), or is missing
// from the new run, or was scored in the baseline and has no scored errors now (`unscored`). A case whose hypothesis changed
// but whose errors did not grow is listed for REVIEW and does not fail. A baseline case with no scored errors cannot get
// worse, so it is only ever listed. Cases only the new run has are not compared.
export function compareGate(baseCases, gotCases) {
  const fail = [];
  const review = [];
  let unchanged = 0;
  for (const b of baseCases) {
    const g = gotCases.find((x) => x.id === b.id);
    if (!g) {
      fail.push({ id: b.id, more: ["missing"], baseline: b.hypothesis, got: null });
      continue;
    }
    const be = errorsOf(b);
    const ge = errorsOf(g);
    if (be && !ge) {
      fail.push({ id: b.id, more: ["unscored"], baseline: b.hypothesis, got: g.hypothesis ?? null });
      continue;
    }
    const more = be ? ["S", "D", "I"].filter((k) => ge[k] > be[k]) : [];
    const errors = { baseline: be, got: ge };
    if (more.length) fail.push({ id: b.id, more, baseline: b.hypothesis, got: g.hypothesis, errors });
    else if (g.hypothesis !== b.hypothesis) review.push({ id: b.id, baseline: b.hypothesis, got: g.hypothesis, errors });
    else unchanged++;
  }
  return { fail, review, unchanged };
}

const errorsOf = (c) => (c.num_norm ? { S: c.num_norm.S, D: c.num_norm.D, I: c.num_norm.I } : c.status === "silence" ? { S: 0, D: 0, I: c.words_produced ?? 0 } : null);
