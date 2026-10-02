#!/usr/bin/env node
// Scores a WER replay run: eval/wer/cases.jsonl (references) against a run
// folder of per-case events files (<run>/raw/<id>.events.jsonl, or the files
// directly in <run>), as written by run-wer.mjs from the page's Download events
// button (?eval=1&nosend=1).
//
// Usage:
//   node wer.mjs --run <run-folder> [--cases eval/wer/cases.jsonl] [--only id,id] [--flags eval/wer/recording-flags.json] [--out summary.json]
//
// Per case it reads the last transcript_final event (text, trigger) and the
// stt_committed events (text) from the events file. Scoring rules:
//   - normalize both sides: lowercase, hyphens split into words, apostrophes
//     removed (it's -> its), other punctuation stripped, whitespace collapsed,
//     fillers (um umm uh uhh er erm) removed. Numbers are NOT normalized;
//     a hypothesis containing digits is flagged has_digits.
//   - word-level edit distance with backtrace gives S/D/I and aligned pairs.
//   - no transcript_final (or no events file) -> status "no_transcript",
//     counted separately, never skipped. Empty transcript text -> all deletions.
//   - empty reference (silence) -> no WER, words_produced reported (expected 0).
//   - commit_mismatch: stt_committed texts joined with spaces vs transcript_final.
//   - corpus-level WER is sum(errors) / sum(ref words), not a mean of per-case WERs.
//   - eval/wer/recording-flags.json (optional) flags recordings, not cases. Cases flagged
//     burst_affected get burst_affected: true, and the summary adds burst_affected[] and
//     excluding_burst_affected (the same aggregates without them).
//   - re-scoring over an existing summary.json keeps its run block.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FILLERS = new Set(["um", "umm", "uh", "uhh", "er", "erm"]);

export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLERS.has(w));
}

// Word-level Levenshtein with backtrace. Ties prefer match/substitution, then
// deletion, then insertion, so the alignment is deterministic.
export function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j - 1] + cost, d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      pairs.push({ op: ref[i - 1] === hyp[j - 1] ? "ok" : "sub", ref: ref[i - 1], hyp: hyp[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      pairs.push({ op: "del", ref: ref[i - 1], hyp: null });
      i--;
    } else {
      pairs.push({ op: "ins", ref: null, hyp: hyp[j - 1] });
      j--;
    }
  }
  pairs.reverse();
  const count = (op) => pairs.filter((p) => p.op === op).length;
  return { pairs, S: count("sub"), D: count("del"), I: count("ins") };
}

// events: array of parsed events for the case, or null when there is no events file.
export function scoreCase(c, events) {
  const base = { id: c.id, category: c.category, condition: c.condition, reference: c.reference };
  const finals = (events ?? []).filter((e) => e.event === "transcript_final");
  if (finals.length === 0) {
    return { ...base, status: "no_transcript", reason: events ? "no_transcript_final" : "no_events_file" };
  }
  const final = finals[finals.length - 1];
  const hypothesis = typeof final.text === "string" ? final.text : "";
  const hypWords = normalize(hypothesis);
  const refWords = normalize(c.reference);

  const committed = (events ?? []).filter((e) => e.event === "stt_committed");
  let commit_mismatch = null; // unknown for old events files whose stt_committed has no text
  let committed_joined;
  if (committed.every((e) => typeof e.text === "string")) {
    committed_joined = committed.map((e) => e.text).join(" ");
    commit_mismatch = committed_joined !== hypothesis;
  }

  const out = {
    ...base,
    hypothesis,
    trigger: final.trigger ?? null,
    has_digits: /\d/.test(hypothesis),
    commit_mismatch,
    n_commits: committed.length,
  };
  if (commit_mismatch) out.committed_joined = committed_joined;
  if (finals.length > 1) out.n_transcript_final = finals.length;

  if (refWords.length === 0) {
    return { ...out, status: "silence", words_produced: hypWords.length, expected_words: 0 };
  }

  const { pairs, S, D, I } = align(refWords, hypWords);
  const firstRef = pairs.find((p) => p.ref !== null);
  return {
    ...out,
    status: "scored",
    empty_hypothesis: hypWords.length === 0,
    ref_words: refWords.length,
    S,
    D,
    I,
    wer: (S + D + I) / refWords.length,
    first_word_ok: firstRef?.op === "ok",
    alignment: pairs,
  };
}

function groupAgg(results) {
  const scored = results.filter((r) => r.status === "scored");
  const sum = (k) => scored.reduce((a, r) => a + r[k], 0);
  const refWords = sum("ref_words");
  const errors = sum("S") + sum("D") + sum("I");
  return {
    n_cases: results.length,
    n_scored: scored.length,
    n_no_transcript: results.filter((r) => r.status === "no_transcript").length,
    ref_words: refWords,
    S: sum("S"),
    D: sum("D"),
    I: sum("I"),
    wer: refWords ? errors / refWords : null,
    n_has_digits: results.filter((r) => r.has_digits).length,
    n_commit_mismatch: results.filter((r) => r.commit_mismatch === true).length,
    first_word_ok: scored.filter((r) => r.first_word_ok).length,
    first_word_ok_rate: scored.length ? scored.filter((r) => r.first_word_ok).length / scored.length : null,
  };
}

function groupBy(results, key) {
  const groups = {};
  for (const r of results) (groups[r[key]] ??= []).push(r);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, groupAgg(v)]));
}

// Recording flags describe the recordings, not the scripted cases: { [caseId]: ["burst_affected"] }.
// A missing file means no flags.
// ponytail: only "burst_affected" is consumed; other flags are stored but ignored. Add a generic with/without split if a second flag appears.
export function loadFlags(path = "eval/wer/recording-flags.json") {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

// cases: parsed cases.jsonl; eventsById: { [id]: parsed events array }; flags: see loadFlags
export function scoreRun(cases, eventsById, flags = {}) {
  const isBurst = (id) => (flags[id] ?? []).includes("burst_affected");
  const results = cases.map((c) => {
    const r = scoreCase(c, eventsById[c.id] ?? null);
    return isBurst(c.id) ? { ...r, burst_affected: true } : r;
  });
  const isSilence = (r) => normalize(r.reference).length === 0;
  const nonSilence = results.filter((r) => !isSilence(r));
  const silence = results.filter(isSilence);
  const fw = (cat) => {
    const a = groupAgg(results.filter((r) => r.category === cat));
    return { n_scored: a.n_scored, first_word_ok: a.first_word_ok, first_word_ok_rate: a.first_word_ok_rate };
  };
  const burst = results.filter((r) => r.burst_affected).map((r) => r.id);
  const out = {
    meta: {
      n_cases: results.length,
      n_scored: results.filter((r) => r.status === "scored").length,
      n_silence: silence.length,
      n_no_transcript: results.filter((r) => r.status === "no_transcript").length,
    },
    overall_excluding_silence: groupAgg(nonSilence),
    by_category: groupBy(nonSilence, "category"),
    by_condition: groupBy(nonSilence, "condition"),
    first_word: { first_word_soft: fw("first_word_soft"), first_word_strong: fw("first_word_strong") },
    silence: {
      expected_words: 0,
      cases: silence.map((r) => ({ id: r.id, status: r.status, words_produced: r.words_produced ?? null, trigger: r.trigger ?? null })),
    },
    no_transcript: results.filter((r) => r.status === "no_transcript").map((r) => ({ id: r.id, reason: r.reason })),
    commit_mismatch: results.filter((r) => r.commit_mismatch === true).map((r) => r.id),
    cases: results,
  };
  if (burst.length) {
    const sub = scoreRun(cases.filter((c) => !isBurst(c.id)), eventsById);
    out.burst_affected = burst;
    out.excluding_burst_affected = { meta: sub.meta, overall_excluding_silence: sub.overall_excluding_silence, first_word: sub.first_word };
  }
  return out;
}

export function parseJsonl(text) {
  const rows = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

export function loadEventsDir(dir) {
  const rawDir = existsSync(join(dir, "raw")) ? join(dir, "raw") : dir;
  const byId = {};
  for (const f of readdirSync(rawDir)) {
    const m = f.match(/^(.+)\.events\.jsonl$/);
    if (m) byId[m[1]] = parseJsonl(readFileSync(join(rawDir, f), "utf8")).rows;
  }
  return byId;
}

function main(argv) {
  const args = { cases: "eval/wer/cases.jsonl", flags: "eval/wer/recording-flags.json", run: null, only: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cases") args.cases = argv[++i];
    else if (argv[i] === "--flags") args.flags = argv[++i];
    else if (argv[i] === "--run") args.run = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i].split(",");
    else if (argv[i] === "--out") args.out = argv[++i];
    else {
      console.error(`wer: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.run) {
    console.error("usage: node wer.mjs --run <run-folder> [--cases file] [--flags file] [--only id,id] [--out summary.json]");
    process.exit(2);
  }
  let cases = parseJsonl(readFileSync(args.cases, "utf8")).rows;
  if (args.only) cases = cases.filter((c) => args.only.includes(c.id));
  const out = args.out ?? join(args.run, "summary.json");
  const scored = scoreRun(cases, loadEventsDir(args.run), loadFlags(args.flags));
  // Re-scoring keeps the run block (written by run-wer.mjs) from the summary being replaced.
  const run = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).run : undefined;
  const summary = run ? { run, ...scored } : scored;
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");

  const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  for (const r of summary.cases) {
    const detail =
      r.status === "scored"
        ? `WER ${pct(r.wer)} S${r.S} D${r.D} I${r.I} first_word_ok=${r.first_word_ok}`
        : r.status === "silence"
          ? `words_produced=${r.words_produced} (expected 0)`
          : `${r.reason}`;
    console.error(`${r.id.padEnd(8)} ${r.status.padEnd(13)} ${detail}  ${JSON.stringify(r.hypothesis ?? "")}`);
  }
  console.error(
    `overall (excl. silence): WER ${pct(summary.overall_excluding_silence.wer)}, ` +
      `${summary.meta.n_scored} scored, ${summary.meta.n_no_transcript} no_transcript. Wrote ${out}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
