import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, scoreCase, scoreRun, loadEventsDir, loadFlags } from "./wer.mjs";

// Event shapes copied from a real run (verify-base-unpadded): stt_model,
// mic_button_press, speech_start, stt_committed {text}, speech_end,
// transcript_final {text, trigger}, each with a timestamp_ms.
let t = 1000;
const ev = (event, extra = {}) => ({ event, timestamp_ms: (t += 100), ...extra });
function turn(pieces, finalText, trigger = "auto_silence") {
  return [
    ev("stt_model", { model: "model/base" }),
    ev("mic_button_press"),
    ev("speech_start"),
    ...pieces.map((text) => ev("stt_committed", { text })),
    ev("speech_end"),
    ...(finalText === undefined ? [] : [ev("transcript_final", { text: finalText, trigger })]),
  ];
}

const FOX = {
  id: "pw-01",
  category: "problem_words",
  condition: "quiet",
  reference: "The quick brown fox jumps over the lazy dog.",
};

test("perfect match scores WER 0 and first_word_ok", () => {
  const text = "The quick brown fox jumps over the lazy dog.";
  const r = scoreCase(FOX, turn([text], text));
  assert.equal(r.status, "scored");
  assert.equal(r.wer, 0);
  assert.deepEqual([r.S, r.D, r.I], [0, 0, 0]);
  assert.equal(r.ref_words, 9);
  assert.equal(r.first_word_ok, true);
  assert.equal(r.commit_mismatch, false);
  assert.equal(r.has_digits, false);
});

test("real fox->pox run: two substitutions, first word wrong", () => {
  const text = "A quick brown pox jumps over the lazy dog.";
  const r = scoreCase(FOX, turn([text], text));
  assert.deepEqual([r.S, r.D, r.I], [2, 0, 0]);
  assert.equal(r.wer, 2 / 9);
  assert.equal(r.first_word_ok, false);
  assert.equal(r.hypothesis, text);
  const subs = r.alignment.filter((p) => p.op === "sub").map((p) => [p.ref, p.hyp]);
  assert.deepEqual(subs, [["the", "a"], ["fox", "pox"]]);
  assert.equal(r.trigger, "auto_silence");
});

test("empty transcript_final text is scored as all deletions", () => {
  const r = scoreCase(FOX, turn([], ""));
  assert.equal(r.status, "scored");
  assert.equal(r.empty_hypothesis, true);
  assert.deepEqual([r.S, r.D, r.I], [0, 9, 0]);
  assert.equal(r.wer, 1);
  assert.equal(r.first_word_ok, false);
  assert.equal(r.commit_mismatch, false);
});

test("missing transcript_final is no_transcript, and counted separately", () => {
  const r = scoreCase(FOX, turn(["A quick brown pox."], undefined));
  assert.equal(r.status, "no_transcript");
  assert.equal(r.reason, "no_transcript_final");
  assert.equal(scoreCase(FOX, null).reason, "no_events_file");

  const other = { ...FOX, id: "pw-02", reference: "Stop." };
  const run = scoreRun([FOX, other], { "pw-02": turn(["Stop."], "Stop.") });
  assert.equal(run.meta.n_no_transcript, 1);
  assert.deepEqual(run.no_transcript, [{ id: "pw-01", reason: "no_events_file" }]);
  assert.equal(run.overall_excluding_silence.wer, 0); // the missing case is not silently scored
});

test("silence case reports words_produced and has no WER", () => {
  const sil = { id: "sil-01", category: "silence", condition: "quiet", reference: "" };
  const quiet = scoreCase(sil, turn([], "", "manual"));
  assert.equal(quiet.status, "silence");
  assert.equal(quiet.words_produced, 0);
  assert.equal(quiet.trigger, "manual");
  assert.equal(quiet.wer, undefined);
  const noisy = scoreCase(sil, turn(["Thank you."], "Thank you."));
  assert.equal(noisy.words_produced, 2);

  const run = scoreRun([sil, FOX], { "sil-01": turn([], "", "manual"), "pw-01": turn(["x"], "The quick brown fox jumps over the lazy dog.") });
  assert.equal(run.overall_excluding_silence.n_cases, 1);
  assert.deepEqual(run.silence.cases, [{ id: "sil-01", status: "silence", words_produced: 0, trigger: "manual" }]);
});

test("fillers are removed on both sides", () => {
  assert.deepEqual(normalize("Um, can you tell me, uh, what day it is? Erm"), ["can", "you", "tell", "me", "what", "day", "it", "is"]);
  const c = { id: "cas-01", category: "casual", condition: "quiet", reference: "Um, can you tell me what day it is?" };
  const r = scoreCase(c, turn(["Can you tell me what day it is?"], "Can you tell me what day it is?"));
  assert.equal(r.wer, 0);
  assert.equal(r.ref_words, 8);
});

test("hyphens split into words and apostrophes are removed", () => {
  assert.deepEqual(normalize("Twenty-five, it's"), ["twenty", "five", "its"]);
  const c = { id: "x", category: "numbers", condition: "quiet", reference: "Add twenty five and seventeen." };
  assert.equal(scoreCase(c, turn(["Add twenty-five and seventeen."], "Add twenty-five and seventeen.")).wer, 0);
  const c2 = { id: "y", category: "casual", condition: "quiet", reference: "It's going to rain." };
  assert.equal(scoreCase(c2, turn(["Its going to rain."], "Its going to rain.")).wer, 0);
});

test("digits are not normalized and are flagged", () => {
  const c = { id: "num-01", category: "numbers", condition: "quiet", reference: "Add twenty five and seventeen." };
  const r = scoreCase(c, turn(["Add 25 and 17."], "Add 25 and 17."));
  assert.equal(r.has_digits, true);
  // twenty->25 sub, five del, seventeen->17 sub ("add" and "and" match)
  assert.deepEqual([r.S, r.D, r.I], [2, 1, 0]);
  assert.equal(r.wer, 3 / 5);
});

test("commit_mismatch compares joined stt_committed with transcript_final", () => {
  const ok = scoreCase(FOX, turn(["The quick brown fox", "jumps over the lazy dog."], "The quick brown fox jumps over the lazy dog."));
  assert.equal(ok.commit_mismatch, false);
  assert.equal(ok.n_commits, 2);
  // a commit that landed but never reached the final text (a lost commit)
  const lost = scoreCase(FOX, turn(["The quick brown fox", "jumps over the lazy dog."], "The quick brown fox"));
  assert.equal(lost.commit_mismatch, true);
  assert.equal(lost.committed_joined, "The quick brown fox jumps over the lazy dog.");
  // commits that arrive after transcript_final also count as mismatched
  const late = [...turn(["The quick"], "The quick"), ev("stt_committed", { text: "brown fox" })];
  assert.equal(scoreCase(FOX, late).commit_mismatch, true);
  // old events files with no text on stt_committed: unknown, not a false alarm
  const legacy = [ev("stt_committed"), ev("transcript_final", { text: "Stop.", trigger: "manual" })];
  assert.equal(scoreCase(FOX, legacy).commit_mismatch, null);
});

test("aggregates are corpus-level, not a mean of per-case WERs", () => {
  const a = { id: "a", category: "short", condition: "quiet", reference: "Yes." }; // 1 word, wrong -> 100%
  const b = { id: "b", category: "short", condition: "quiet", reference: "one two three four five six seven eight nine ten" }; // 10 words, 1 wrong
  const run = scoreRun([a, b], {
    a: turn(["No."], "No."),
    b: turn(["x"], "one two three four five six seven eight nine eleven"),
  });
  assert.equal(run.by_category.short.ref_words, 11);
  assert.equal(run.by_category.short.wer, 2 / 11); // not (1 + 0.1) / 2
  assert.equal(run.overall_excluding_silence.wer, 2 / 11);
  assert.equal(run.by_condition.quiet.wer, 2 / 11);
});

test("first-word rate is reported for soft vs strong side by side", () => {
  const soft = { id: "fws-01", category: "first_word_soft", condition: "quiet", reference: "The meeting starts at nine." };
  const strong = { id: "fst-01", category: "first_word_strong", condition: "quiet", reference: "Seven people are coming." };
  const run = scoreRun([soft, strong], {
    "fws-01": turn(["meeting starts at nine."], "meeting starts at nine."),
    "fst-01": turn(["Seven people are coming."], "Seven people are coming."),
  });
  assert.equal(run.first_word.first_word_soft.first_word_ok_rate, 0);
  assert.equal(run.first_word.first_word_strong.first_word_ok_rate, 1);
});

test("loadEventsDir reads <run>/raw/<id>.events.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "wer-"));
  mkdirSync(join(dir, "raw"));
  const rows = turn(["Stop."], "Stop.");
  writeFileSync(join(dir, "raw", "sh-02.events.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const byId = loadEventsDir(dir);
  const sh = { id: "sh-02", category: "short", condition: "quiet", reference: "Stop." };
  assert.equal(scoreCase(sh, byId["sh-02"]).wer, 0);
});

test("loadFlags: missing file means no flags, present file is read as id -> flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "wer-flags-"));
  assert.deepEqual(loadFlags(join(dir, "nope.json")), {});
  const p = join(dir, "flags.json");
  writeFileSync(p, JSON.stringify({ "pw-01": ["burst_affected"] }));
  assert.deepEqual(loadFlags(p), { "pw-01": ["burst_affected"] });
});

test("burst_affected flag marks cases and adds with/without aggregates", () => {
  const other = { id: "pw-02", category: "problem_words", condition: "quiet", reference: "A fox ran." };
  const events = {
    "pw-01": turn(["A quick brown pox jumps over the lazy dog."], "A quick brown pox jumps over the lazy dog."), // 2 errors / 9
    "pw-02": turn(["A fox ran."], "A fox ran."), // 0 errors / 3
  };
  const run = scoreRun([FOX, other], events, { "pw-01": ["burst_affected"] });
  assert.deepEqual(run.burst_affected, ["pw-01"]);
  assert.equal(run.cases.find((c) => c.id === "pw-01").burst_affected, true);
  assert.equal("burst_affected" in run.cases.find((c) => c.id === "pw-02"), false);
  assert.equal(run.overall_excluding_silence.wer, 2 / 12);
  const ex = run.excluding_burst_affected;
  assert.equal(ex.meta.n_cases, 1);
  assert.equal(ex.overall_excluding_silence.ref_words, 3);
  assert.equal(ex.overall_excluding_silence.wer, 0);
  assert.equal(ex.first_word.first_word_soft.n_scored, 0);
});

test("no flags means no burst_affected keys in the summary", () => {
  const run = scoreRun([FOX], { "pw-01": turn(["Stop."], "Stop.") });
  assert.equal("burst_affected" in run, false);
  assert.equal("excluding_burst_affected" in run, false);
  assert.equal("burst_affected" in run.cases[0], false);
});
