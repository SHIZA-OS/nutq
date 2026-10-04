#!/usr/bin/env node
// End-of-turn sweep, tier 2: replays many policies on the recorded streams of replay-commits.mjs --streams (tier 1: the
// real model ran once per case and phase) with endpoint-sim.mjs, in a headless page so that the real TurnPolicy of
// src/turn-policy.ts decides, and writes eval/results/<date>-endpoint-sweep/ (summary.json, README.md, grid.json).
//
// Usage:
//   node eval/runner/endpoint-sweep.mjs --streams <streams.jsonl> [--out <results dir>] [--tier2] [--scales 0.5,1,2]
//     [--recordings <results dir of the tier 1 replay>] [--noise <results dir of a fixed:5000 replay of the noise cases>]
// --check-only writes only the recordings check (recordings.json and recordings.md), with no policies run.
// --tier2 adds the arm whose open list also has auxiliary verbs and subject pronouns (src/turn-policy.ts OPEN_WORDS_TIER2).
// --recordings adds the per-take check (pauses, bursts, flags) using the transcripts of the tier 1 run and the WAVs;
// --noise adds what the noise recordings produce and whether it would have been sent, from a real replay.
//
// Policies: fixed waits (0 to 5000 ms) and the semantic grid: done {0,150,300,600,1000}, unknown {600,1000,1500,2200,3000},
// open {1500,2500,3500,5000,7000} with done <= unknown <= open, floor {0,150,300}, ceiling 8000. Text reaches the policy
// at a commit's fire time plus a modelled model run time (endpoint-metrics.mjs commitLatencyMs) times each scale.
//
// What is counted (pooled over the 8 phases, which only shift the frame grid, so one recording is one sample of the
// speaker and the counts over phases are not independent):
// - premature on the pause cases: an auto-silence ended the turn while the file still held speech, mp-01 to mp-12, by
//   category and by the measured pause length; plus premature on the v1 speech cases, counted separately.
// - the wait after the true end of speech (median, p90, max) over the turns that cut nothing off, on all speech cases and
//   on the v1 speech ones.
// - noise: how many turns of the noise-only recordings (no-01 to no-04, sil-01) would have sent a non-empty transcript,
//   as a separate column, and for nts-01 how many sent "stop".
// - v1 text changes: v1 turns whose simulated text differs from fixed:5000 at the same scale (a proxy for the v1 gate,
//   which is decided by the real replay).
// The simulated text is the commits fired before the end; the flush stop() does is not modelled (see endpoint-sim.mjs).

import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { analyzeTurn, quantile } from "./endpoint-metrics.mjs";
import { measureTake, takeFlags, wavStats } from "./endpoint-check.mjs";
import { REPO, makeTempDir, startVite } from "./vite-server.mjs";

const CHROME = "/usr/bin/google-chrome";
const FIXED = [0, 150, 300, 600, 1000, 1200, 1500, 2200, 3000, 5000];
const DONE = [0, 150, 300, 600, 1000];
const UNKNOWN = [600, 1000, 1500, 2200, 3000];
const OPEN = [1500, 2500, 3500, 5000, 7000];
const FLOOR = [0, 150, 300];
const CEILING = 8000; // MAX_SILENCE_MS
// Budgets of pause cuts out of the 96 turn-phases, worst case over the latency scales. The first plan was 0, 4 and 12; no
// semantic policy fits 0 or 4 (the fewest cuts any of them has is 12, see the README), so the table reports the budgets
// where the frontier has vertices: 0 and 8 (the two fixed vertices) and 12, 20 and 40.
const BUDGETS = [0, 8, 12, 20, 40];

function parseArgs(argv) {
  const a = { streams: null, out: null, checkOnly: false, tier2: false, scales: [0.5, 1, 2], recordings: null, noise: null, audioDir: join(homedir(), "Shiza/nutq-eval-audio/cases") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--streams") a.streams = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--tier2") a.tier2 = true;
    else if (argv[i] === "--check-only") a.checkOnly = true;
    else if (argv[i] === "--scales") a.scales = argv[++i].split(",").map(Number);
    else if (argv[i] === "--recordings") a.recordings = argv[++i];
    else if (argv[i] === "--noise") a.noise = argv[++i];
    else if (argv[i] === "--audio-dir") a.audioDir = argv[++i].replace(/^~(?=\/)/, homedir());
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!a.streams) throw new Error("--streams is required");
  a.out ??= join(REPO, "eval/results", `${new Date().toLocaleDateString("sv")}-endpoint-sweep`);
  return a;
}

export function policyList(tier2) {
  const specs = FIXED.map((ms) => ({ name: `fixed:${ms}`, kind: "fixed", ms }));
  for (const t2 of tier2 ? [false, true] : [false]) {
    for (const floor of FLOOR) {
      for (const done of DONE) {
        for (const unknown of UNKNOWN) {
          for (const open of OPEN) {
            if (done > unknown || unknown > open) continue;
            const waits = { done, unknown, open, floor, ceiling: CEILING, ...(t2 ? { tier2: true } : {}) };
            specs.push({ name: `semantic${t2 ? "2" : ""}:${done},${unknown},${open},${floor}`, kind: "semantic", tier2: t2, waits });
          }
        }
      }
    }
  }
  return specs;
}

const stat = (w) => ({ median: quantile(w, 0.5), p90: quantile(w, 0.9), max: w.length ? Math.max(...w) : null, n: w.length });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const streams = readFileSync(args.streams, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const caseRows = Object.fromEntries(readFileSync(join(REPO, "eval/wer/cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((c) => [c.id, c]));
  const cat = (s) => caseRows[s.id].category;
  const isMp = (s) => s.id.startsWith("mp-");
  const isNoise = (s) => ["noise_only", "silence"].includes(cat(s));
  const isNts = (s) => cat(s) === "noise_then_short";
  const isV1Speech = (s) => s.set === "v1" && !isNoise(s) && !isNts(s);
  if (args.checkOnly) {
    const recordings = args.recordings ? checkRecordings(args, streams, caseRows) : null;
    const noise = args.noise ? noiseReport(args.noise) : null;
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, "recordings.json"), JSON.stringify({ recordings, noise }, null, 1) + "\n");
    writeFileSync(join(args.out, "recordings.md"), recordingSections({ recordings, noise }).join("\n") + "\n");
    console.error(`wrote ${args.out}/recordings.json and recordings.md`);
    return;
  }
  const specs = policyList(args.tier2);
  console.error(`${streams.length} streams, ${specs.length} policies, scales ${args.scales.join(", ")}`);

  const vite = await startVite();
  const context = await chromium.launchPersistentContext(makeTempDir("nutq-sweep-"), { executablePath: CHROME, headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
  const raw = {}; // `${name}@${scale}` -> { ends, auto, text }
  let texts = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(vite.url);
    const slim = streams.map((s) => ({ nFile: s.nFile, seq: s.seq }));
    for (const scale of args.scales) {
      const out = await page.evaluate(async ({ slim, specs, scale }) => {
        const { TurnPolicy, waitFor } = await import("/src/turn-policy.ts");
        const { simulate } = await import("/eval/runner/endpoint-sim.mjs");
        const { commitLatencyMs } = await import("/eval/runner/endpoint-metrics.mjs");
        const table = new Map();
        const intern = (t) => (table.has(t) ? table.get(t) : (table.set(t, table.size), table.size - 1));
        const res = {};
        for (const spec of specs) {
          const mk = spec.kind === "fixed" ? () => new TurnPolicy(spec.ms) : () => new TurnPolicy((text, n) => waitFor(text, spec.waits, n));
          const ends = new Array(slim.length);
          const auto = new Array(slim.length);
          const text = new Array(slim.length);
          slim.forEach((s, j) => {
            const r = simulate(s, mk, commitLatencyMs, scale);
            ends[j] = r.endMs;
            auto[j] = r.trigger === "auto_silence" ? 1 : 0;
            text[j] = intern(r.sentText);
          });
          res[spec.name] = { ends, auto, text };
        }
        return { res, table: [...table.keys()] };
      }, { slim, specs, scale });
      texts = out.table;
      for (const [name, v] of Object.entries(out.res)) raw[`${name}@${scale}`] = { ...v, table: out.table };
      console.error(`scale ${scale} done`);
    }
  } finally {
    await context.close();
    vite.child.kill();
  }

  // ---- metrics per policy and scale
  const longestGap = (s) => analyzeTurn({ probs: s.truth, endMs: 0, trigger: "manual" }).pause_ms; // of the file, whatever the turn did
  const bucket = (ms) => (ms < 1500 ? "pause <1.5 s" : ms < 2750 ? "pause 1.5 to 2.75 s" : "pause 2.75 s and up");
  const mpBucket = Object.fromEntries(streams.filter((s) => s.phase === 0 && isMp(s)).map((s) => [s.id, bucket(longestGap(s) ?? 0)]));
  const grid = [];
  const baseText = {};
  for (const scale of args.scales) baseText[scale] = raw[`fixed:5000@${scale}`];
  for (const spec of specs) {
    for (const scale of args.scales) {
      const r = raw[`${spec.name}@${scale}`];
      const a = streams.map((s, j) => analyzeTurn({ probs: s.truth, endMs: r.ends[j], trigger: r.auto[j] ? "auto_silence" : "manual" }));
      const byCat = {};
      const byBucket = {};
      const perCase = {};
      let mpCut = 0;
      let mpTotal = 0;
      let v1Cut = 0;
      const wAll = [];
      const wV1 = [];
      let noiseSends = 0;
      let ntsStop = 0;
      let v1Changed = 0;
      streams.forEach((s, j) => {
        const t = r.table[r.text[j]];
        if (isMp(s)) {
          mpTotal++;
          const k = cat(s);
          byCat[k] ??= { cut: 0, total: 0 };
          byCat[k].total++;
          const b = mpBucket[s.id];
          byBucket[b] ??= { cut: 0, total: 0 };
          byBucket[b].total++;
          if (a[j].premature) {
            mpCut++;
            byCat[k].cut++;
            byBucket[b].cut++;
            perCase[s.id] = (perCase[s.id] ?? 0) + 1;
          }
        }
        if (isV1Speech(s) && a[j].premature) v1Cut++;
        if (isV1Speech(s)) {
          const base = baseText[scale];
          if (t !== base.table[base.text[j]]) v1Changed++;
        }
        if (!isNoise(s) && !isNts(s) && a[j].wait_after_true_end_ms !== null) {
          wAll.push(a[j].wait_after_true_end_ms);
          if (isV1Speech(s)) wV1.push(a[j].wait_after_true_end_ms);
        }
        if (isNoise(s) && t.trim() !== "") noiseSends++;
        if (isNts(s) && /\bstop\b/i.test(t)) ntsStop++;
      });
      grid.push({ name: spec.name, kind: spec.kind, tier2: !!spec.tier2, waits: spec.waits ?? { ms: spec.ms }, scale, mp_cut: mpCut, mp_total: mpTotal, by_category: byCat, by_bucket: byBucket, per_case_cut: perCase, v1_cut: v1Cut, wait_all: stat(wAll), wait_v1: stat(wV1), noise_sends: noiseSends, nts_stop: ntsStop, v1_text_changed: v1Changed });
    }
  }

  // ---- selection: per budget, the policy (per family) with the lowest p90, then median, then max wait, then the smaller open wait,
  // among those whose cuts stay within the budget at EVERY latency scale
  const byName = (name) => grid.filter((g) => g.name === name);
  const at1 = (name) => grid.find((g) => g.name === name && g.scale === 1);
  const names = [...new Set(grid.map((g) => g.name))];
  const worstCuts = (name) => Math.max(...byName(name).map((g) => g.mp_cut));
  const openOf = (n) => at1(n).waits.open ?? 0;
  const tierOf = (n) => (n.startsWith("semantic2:") ? 1 : 0); // a tie goes to the simpler open list
  const rank = (x, y) => at1(x).wait_all.p90 - at1(y).wait_all.p90 || at1(x).wait_all.median - at1(y).wait_all.median || at1(x).wait_all.max - at1(y).wait_all.max || openOf(x) - openOf(y) || tierOf(x) - tierOf(y) || (x < y ? -1 : 1);
  const pick = (pool, budget) => pool.filter((n) => worstCuts(n) <= budget).sort(rank)[0] ?? null;
  const fixedNames = names.filter((n) => n.startsWith("fixed:"));
  const arms = [["semantic", names.filter((n) => n.startsWith("semantic:"))], ...(args.tier2 ? [["semantic2", names.filter((n) => n.startsWith("semantic2:"))]] : [])];
  const selections = BUDGETS.map((budget) => ({ budget, fixed: pick(fixedNames, budget), ...Object.fromEntries(arms.map(([arm, pool]) => [arm, pick(pool, budget)])) }));
  // the frontier over (worst-case cuts, median, p90), equivalent policies collapsed to one representative
  const vec = (n) => [worstCuts(n), at1(n).wait_all.median, at1(n).wait_all.p90];
  const dom = (a, b) => a.every((x, i) => x <= b[i]) && a.some((x, i) => x < b[i]);
  const front = names.filter((n) => !names.some((m) => dom(vec(m), vec(n))));
  const groups = new Map();
  for (const n of front) groups.set(vec(n).join(), [...(groups.get(vec(n).join()) ?? []), n]);
  const frontier = {
    vertices: [...groups.values()].map((g) => ({ policy: g.sort((x, y) => at1(x).wait_all.max - at1(y).wait_all.max || openOf(x) - openOf(y) || tierOf(x) - tierOf(y) || (x < y ? -1 : 1))[0], cuts: vec(g[0])[0], median: vec(g[0])[1], p90: vec(g[0])[2], max: at1(g[0]).wait_all.max, equivalent_policies: g.length })).sort((x, y) => x.cuts - y.cuts || x.p90 - y.p90),
    fewest_semantic_cuts: Math.min(...names.filter((n) => n.startsWith("semantic")).map(worstCuts)),
  };
  // tier 2 against tier 1 (same d, u, o, floor)
  const t1 = names.filter((n) => n.startsWith("semantic:"));
  const t2 = names.filter((n) => n.startsWith("semantic2:"));
  frontier.tier2 = args.tier2 ? { points: t2.length, dominated_by_a_tier1_point: t2.filter((n) => t1.some((m) => dom(vec(m), vec(n)))).length, better_than_every_tier1_point: t2.filter((n) => !t1.some((m) => vec(m).every((x, i) => x <= vec(n)[i]))).length } : null;

  // ---- per-case waits of a policy (median over phases), to see which cases make the tail
  const perCaseWait = (name, scale) => {
    const r = raw[`${name}@${scale}`];
    const w = {};
    streams.forEach((s, j) => {
      if (isNoise(s) || isNts(s)) return;
      const t = analyzeTurn({ probs: s.truth, endMs: r.ends[j], trigger: r.auto[j] ? "auto_silence" : "manual" });
      if (t.wait_after_true_end_ms !== null) (w[s.id] ??= []).push(t.wait_after_true_end_ms);
    });
    return Object.entries(w).map(([id, v]) => ({ id, median: quantile(v, 0.5), max: Math.max(...v) })).sort((x, y) => y.median - x.median);
  };
  const chosen = selections.flatMap((sel) => [sel.fixed, sel.semantic, sel.semantic2].filter(Boolean)).filter((n, i, all) => all.indexOf(n) === i);
  const drivers = Object.fromEntries(chosen.map((n) => {
    const cuts = at1(n).per_case_cut;
    const top = Object.entries(cuts).sort((x, y) => y[1] - x[1])[0];
    return [n, { cuts, cuts_without_top_case: top ? { case: top[0], cuts: at1(n).mp_cut - top[1] } : null, slowest: perCaseWait(n, 1).slice(0, 6) }];
  }));

  const recordings = args.recordings ? checkRecordings(args, streams, caseRows) : null;
  const noise = args.noise ? noiseReport(args.noise) : null;

  mkdirSync(args.out, { recursive: true });
  const summary = { streams: streams.length, policies: specs.length, scales: args.scales, budgets: BUDGETS, selections, frontier, fixed_scale1: fixedNames.map((n) => at1(n)), chosen: chosen.map((n) => byName(n)), drivers, recordings, noise };
  writeFileSync(join(args.out, "grid.json"), JSON.stringify(grid) + "\n");
  writeFileSync(join(args.out, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  writeFileSync(join(args.out, "README.md"), readme({ args, streams, specs, summary, at1, byName, grid }));
  console.error(`wrote ${args.out}/summary.json, grid.json and README.md`);
}

// ---- the per-take check of the recordings (Step 2): pauses, bursts, flags, from the tier 1 streams, the WAVs and the tier 1 transcripts
function checkRecordings(args, streams, caseRows) {
  const dir = args.recordings.startsWith("/") ? args.recordings : join(REPO, "eval/results", args.recordings);
  const summ = JSON.parse(readFileSync(join(dir, "phase-0/summary.json"), "utf8"));
  const wer = Object.fromEntries(summ.cases.map((c) => [c.id, { wer: c.num_norm?.wer ?? c.wer, hypothesis: c.hypothesis }]));
  const ids = [...new Set(streams.map((s) => s.id))];
  return ids.map((id) => {
    const c = caseRows[id];
    const phases = streams.filter((s) => s.id === id).sort((x, y) => x.phase - y.phase).map((s) => s.truth);
    const m = measureTake(phases);
    const w = wavStats(readFileSync(join(args.audioDir, `${id}.wav`)));
    const flags = takeFlags(c, m, w, wer[id]?.wer ?? 0);
    return { id, set: c.set ?? "v1", category: c.category, pause_s: c.pause_s ?? null, ...m, wav: w, wer: wer[id]?.wer ?? null, hypothesis: wer[id]?.hypothesis ?? null, ...flags };
  });
}

// ---- what the noise recordings produce under the fixed 5000 ms policy, from a real replay (all 8 phases)
function noiseReport(noiseDir) {
  const dir = noiseDir.startsWith("/") ? noiseDir : join(REPO, "eval/results", noiseDir);
  const out = {};
  for (let phase = 0; phase < 8; phase++) {
    const f = join(dir, `phase-${phase}`, "summary.json");
    const sm = JSON.parse(readFileSync(f, "utf8"));
    for (const c of sm.cases ?? []) (out[c.id] ??= []).push({ phase, hypothesis: sm.turns?.[c.id]?.sent_text ?? c.hypothesis ?? "", status: c.status });
    for (const id of Object.keys(sm.turns ?? {})) if (!out[id]) (out[id] ??= []).push({ phase, hypothesis: sm.turns[id].sent_text, status: "n/a" });
  }
  return Object.fromEntries(Object.entries(out).map(([id, v]) => [id, { words: v.map((x) => x.hypothesis.trim().split(/\s+/).filter(Boolean).length), sent: v.filter((x) => x.hypothesis.trim() !== "").length, phases: v.length, texts: [...new Set(v.map((x) => x.hypothesis))] }]));
}

// The two README sections about the recordings themselves (the take check and the noise recordings).
function recordingSections(summary) {
  const f1 = (x) => (x === null || x === undefined ? "-" : String(Math.round(x)));
  const L = [];
  if (summary.recordings) {
    L.push("## Check of the recordings", "");
    L.push("From the VAD trace of every take (probability 0.5 or above is speech; gaps under 512 ms are bridged), the WAV, and the tier 1 transcript. Nothing was dropped; flagged takes are listed and stay in the sweep. `unusable` = cannot answer what it was recorded for; `note` = worth knowing.", "");
    L.push("| id | category | intended pause s | longest gap ms (min / median / max over phases) | other gaps ms | first speech ms | silence after speech ms | burst | peak | WER | unusable | note |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of summary.recordings.filter((x) => x.set === "v2")) {
      const g = r.longest_gap_phases_ms;
      const others = r.gaps_ms.filter((x) => x !== r.longest_gap_ms).join(", ");
      L.push(`| ${r.id} | ${r.category} | ${r.pause_s ?? ""} | ${g ? `${g.min} / ${g.median} / ${g.max}` : ""} | ${others} | ${f1(r.first_speech_ms)} | ${f1(r.file_ms - r.last_speech_end_ms)} | ${r.burst ? "yes" : ""} | ${r.wav.peak.toFixed(2)} | ${r.wer === null ? "" : (r.wer * 100).toFixed(0) + "%"} | ${r.unusable.join(", ")} | ${r.note.join(", ")} |`);
    }
    const peaks = (set) => summary.recordings.filter((r) => r.set === set && !["noise_only", "silence", "noise_then_short"].includes(r.category)).map((r) => r.wav.peak);
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const mp = summary.recordings.filter((r) => r.pause_s !== null && r.longest_gap_phases_ms);
    const lo = mp.reduce((a, r) => (r.longest_gap_phases_ms.median < a.longest_gap_phases_ms.median ? r : a));
    const hi = mp.reduce((a, r) => (r.longest_gap_phases_ms.median > a.longest_gap_phases_ms.median ? r : a));
    L.push("", `**Measured pauses against the intended 1 / 2 / 3.5 s:** the ${mp.length} pause takes measure ${lo.longest_gap_phases_ms.median} ms (${lo.id}) to ${hi.longest_gap_phases_ms.median} ms (${hi.id}) at the median over phases. ${mp.filter((r) => r.pause_s === 1).map((r) => `${r.id} (intended 1 s) measures ${r.longest_gap_phases_ms.median} ms`).join("; ")}; ${mp.filter((r) => r.pause_s === 3.5).map((r) => `${r.id} (intended 3.5 s) measures ${r.longest_gap_phases_ms.median} ms`).join("; ")}. So there is no short pause under ${Math.round(Math.min(...mp.map((r) => r.longest_gap_phases_ms.median)) / 100) / 10} s and no pause above ${Math.round(Math.max(...mp.map((r) => r.longest_gap_phases_ms.median)) / 100) / 10} s: the dose-response by pause length is not testable, and the pause-length buckets below are by measured length. The measured gap runs from the last frame of the word before to the first frame of the word after, so it includes the speaker's own decay and onset.`);
    const burstIds = (set) => summary.recordings.filter((r) => r.set === set && r.note.includes("leading_burst")).map((r) => r.id);
    L.push("", `Leading burst (a short VAD run before the speech, or a near full-scale peak in the first 256 ms): v1 ${burstIds("v1").join(", ") || "none"}, against the three already flagged \`burst_affected\` (fws-01, bn-01, bn-03); v2 ${burstIds("v2").join(", ") || "none"}. Level (peak, 0 to 1, speech recordings only): v1 median ${med(peaks("v1")).toFixed(2)} (the bursts reach 1.0), v2 ${Math.min(...peaks("v2")).toFixed(2)} to ${Math.max(...peaks("v2")).toFixed(2)}.`, "");
  }
  if (summary.noise) {
    L.push("## Noise recordings under fixed:5000 (real replay, 8 phases)", "");
    L.push("| id | words produced per phase | phases that would send a non-empty transcript | distinct texts |", "|---|---|---|---|");
    for (const [id, n] of Object.entries(summary.noise)) L.push(`| ${id} | ${n.words.join(" ")} | ${n.sent} of ${n.phases} | ${n.texts.map((t) => JSON.stringify(t)).join(" ")} |`);
    L.push("");
  }

  return L;
}

function readme({ args, streams, specs, summary, at1, byName }) {
  const f1 = (x) => (x === null || x === undefined ? "-" : String(Math.round(x)));
  const L = [];
  const date = args.out.split("/").pop().slice(0, 10);
  L.push(`# ${date}: end-of-turn sweep`, "");
  L.push(`Tier 1: the real Transcriber ran once per recording and phase (${streams.length} streams = ${new Set(streams.map((s) => s.id)).size} recordings x ${new Set(streams.map((s) => s.phase)).size} phases) with no turn ending early, and recorded the VAD events, the commits (fire frame, real text) and the VAD probability of every frame. Tier 2: ${specs.length} policies, each replayed on those streams with the real \`TurnPolicy\` (\`endpoint-sim.mjs\`), at model latency scales ${args.scales.join(", ")} (the fitted line: 269 ms per second of audio minus 61 ms, floor 100 ms). Policies: ${specs.filter((x) => x.kind === "fixed").length} fixed waits and the semantic grid (done 0 to 1000, unknown 600 to 3000, open 1500 to 7000, done <= unknown <= open, floor 0/150/300, ceiling 8000)${args.tier2 ? ", with the open list tier 1 and tier 1 plus tier 2 as separate arms" : ", open list tier 1 only"}.`, "");
  L.push("## How to read the numbers", "");
  L.push("- **Cut** (premature): an auto-silence ended the turn while the recording still held speech (the VAD trace says so). Counted on the 12 pause recordings mp-01 to mp-12 over 8 phases = 96 turn-phases. The 8 phases only shift the frame grid, so they are **not** independent samples: one recording is one take by one speaker. A count of 8 can be one recording cut in every phase.");
  L.push("- **Wait after true end**: from the last frame of speech to the end of the turn, over the turns that cut nothing off, on every speech recording (v1 without the noise-only ones, plus mp, te, ls). It excludes the live flush after the end (about 0.2 s) and any text decode the live app waits for. Frame timing is accurate to about 32 ms.");
  L.push("- **Noise sends**: of the 40 turn-phases of the noise-only recordings (no-01 to no-04, sil-01), how many would have sent a non-empty transcript. Reported apart; lower is better. nts-01 (a cough, then \"Stop\") is counted as how many of its 8 turns sent \"stop\".");
  L.push("- **v1 text changed**: v1 turns whose simulated text differs from fixed:5000 at the same latency scale. A proxy for the v1 gate, which only the real replay decides.");
  L.push("- Text arrival is modelled, the text itself is the real model's, and the flush that `stop()` does at an early end is not modelled. The VAD trace is the truth for \"still speaking\", so it can miss soft speech in the noise cases.", "");

  L.push(...recordingSections(summary));

  L.push("## Fixed waits (scale 1)", "", "A fixed wait W gives a wait after the true end of about 768 ms of VAD redemption plus W. Waits under 800 ms are not reachable with `?silence` (clamped) and are here as a reference.", "");
  L.push("| fixed wait ms | pause cuts /96 | v1 cuts | wait after true end median / p90 / max ms | v1 wait median / p90 | noise sends /40 | nts-01 stop /8 | v1 text changed |", "|---|---|---|---|---|---|---|---|");
  for (const g of summary.fixed_scale1) L.push(`| ${g.waits.ms} | ${g.mp_cut} | ${g.v1_cut} | ${f1(g.wait_all.median)} / ${f1(g.wait_all.p90)} / ${f1(g.wait_all.max)} | ${f1(g.wait_v1.median)} / ${f1(g.wait_v1.p90)} | ${g.noise_sends} | ${g.nts_stop} | ${g.v1_text_changed} |`);
  L.push("");

  L.push("## Does a semantic point beat the fixed-wait frontier?", "");
  const fr = summary.frontier;
  L.push(`The fewest pause cuts any semantic policy has (worst case over the latency scales) is **${fr.fewest_semantic_cuts}** of 96; fixed:3000 has 0 and fixed:2200 has 8. Why: a pause after a complete clause ("Yes." then 2.6 s, mp-12) reads as done, and Moonshine sometimes puts a full stop mid-sentence ("my appointment.", mp-10) so that a pause after a content word reads as done too; the grid's \`done\` tops out at 1000 ms, which cannot cover a 1.7 to 2.6 s pause. The semantic rule does protect the pauses after function words (0 of 64 cut once \`open\` is 2500 or more).`, "");
  L.push("The frontier over (cuts at the worst latency scale, median wait, p90 wait), equivalent policies collapsed (policies that tie differ only in an unused wait, floor or open value; the one with the lowest max wait is shown):", "", "| cuts /96 | median ms | p90 ms | max ms | policy | equivalent policies |", "|---|---|---|---|---|---|");
  for (const v of fr.vertices) L.push(`| ${v.cuts} | ${f1(v.median)} | ${f1(v.p90)} | ${f1(v.max)} | \`${v.policy}\` | ${v.equivalent_policies} |`);
  L.push("");
  if (fr.tier2) L.push(`Tier 2 arm: of ${fr.tier2.points} tier 2 policies, ${fr.tier2.dominated_by_a_tier1_point} are dominated by a tier 1 policy and ${fr.tier2.better_than_every_tier1_point} is better than every tier 1 policy. On these recordings no pause ends in an auxiliary verb or a pronoun, so tier 2 only lengthens waits.`, "");
  L.push("For each budget of pause cuts (out of 96 turn-phases, and it must hold at every latency scale), the best policy by p90 wait after the true end (ties by median, then max wait), at scale 1. \"Saved\" is the best fixed policy within the same budget minus the semantic one:", "");
  L.push("| budget (cuts) | arm | policy | cuts at x0.5 / x1 / x2 | median ms | p90 ms | max ms | v1 cuts | noise sends /40 | v1 text changed | median saved ms | p90 saved ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const sel of summary.selections) {
    const fx = sel.fixed ? at1(sel.fixed) : null;
    for (const arm of ["fixed", "semantic", "semantic2"]) {
      const n = sel[arm];
      if (arm !== "fixed" && n === undefined) continue;
      if (!n) { L.push(`| ${sel.budget} | ${arm} | none within budget | | | | | | | | | |`); continue; }
      const g = at1(n);
      const cuts = args.scales.map((sc) => byName(n).find((x) => x.scale === sc).mp_cut).join(" / ");
      L.push(`| ${sel.budget} | ${arm} | \`${n}\` | ${cuts} | ${f1(g.wait_all.median)} | ${f1(g.wait_all.p90)} | ${f1(g.wait_all.max)} | ${g.v1_cut} | ${g.noise_sends} | ${g.v1_text_changed} | ${arm === "fixed" || !fx ? "" : f1(fx.wait_all.median - g.wait_all.median)} | ${arm === "fixed" || !fx ? "" : f1(fx.wait_all.p90 - g.wait_all.p90)} |`);
    }
  }
  L.push("");

  L.push("## Selected points by scale", "");
  L.push("| policy | scale | pause cuts /96 | by category | by measured pause | v1 cuts | wait median / p90 / max ms | v1 wait median / p90 | noise sends /40 | nts-01 stop /8 | v1 text changed |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const rows of summary.chosen) for (const g of rows) {
    const cat = Object.entries(g.by_category).map(([k, v]) => `${k.replace("pause_", "")} ${v.cut}/${v.total}`).join("; ");
    const bk = Object.entries(g.by_bucket).map(([k, v]) => `${k.replace("pause ", "")} ${v.cut}/${v.total}`).join("; ");
    L.push(`| \`${g.name}\` | ${g.scale} | ${g.mp_cut} | ${cat} | ${bk} | ${g.v1_cut} | ${f1(g.wait_all.median)} / ${f1(g.wait_all.p90)} / ${f1(g.wait_all.max)} | ${f1(g.wait_v1.median)} / ${f1(g.wait_v1.p90)} | ${g.noise_sends} | ${g.nts_stop} | ${g.v1_text_changed} |`);
  }
  L.push("", "## Which single cases drive the result (scale 1)", "");
  for (const [n, d] of Object.entries(summary.drivers)) {
    L.push(`- \`${n}\`: cut turn-phases by recording ${Object.entries(d.cuts).map(([id, c]) => `${id} ${c}/8`).join(", ") || "none"}${d.cuts_without_top_case ? `; without ${d.cuts_without_top_case.case} the cuts are ${d.cuts_without_top_case.cuts}` : ""}; slowest to send (median wait over phases): ${d.slowest.map((x) => `${x.id} ${f1(x.median)} ms`).join(", ")}.`);
  }
  L.push("", "Raw grid of every policy at every scale: `grid.json`. The streams (`raw/streams.jsonl`) are not committed.", "");
  return L.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`endpoint-sweep: ${e.message}`);
    process.exit(1);
  });
}
