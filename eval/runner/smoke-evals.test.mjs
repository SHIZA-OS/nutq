// One-case smoke test of the two eval drivers against the Vite dev server (where eval mode is on): run-wer.mjs and replay-commits.mjs on
// one recorded case. A production-build change must leave them working. They need the recordings (EVAL_AUDIO_DIR); without them both tests are
// skipped. run-wer.mjs writes eval/results/<date>-wer-<label>/; the test removes it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO } from "./vite-server.mjs";

const AUDIO_DIR = (process.env.EVAL_AUDIO_DIR || "").replace(/^~(?=\/)/, homedir());
const skip = !(AUDIO_DIR && existsSync(join(AUDIO_DIR, "aq-01.wav"))) && "EVAL_AUDIO_DIR is not set or has no aq-01.wav";
const LABEL = "smoke-test";
const resultsDirs = () => readdirSync(join(REPO, "eval/results")).filter((d) => d.endsWith(`-wer-${LABEL}`));
const before = new Set(resultsDirs()); // never remove a directory that was already there

const node = (script, ...args) => spawnSync(process.execPath, [join(REPO, "eval/runner", script), ...args], { cwd: REPO, encoding: "utf8", timeout: 280_000 });

after(() => {
  for (const d of resultsDirs()) if (!before.has(d)) rmSync(join(REPO, "eval/results", d), { recursive: true, force: true });
});

test("run-wer.mjs scores one case", { skip }, () => {
  const out = node("run-wer.mjs", "--label", LABEL, "--cases", "aq-01", "--audio-dir", AUDIO_DIR);
  assert.equal(out.status, 0, out.stderr);
  const dir = resultsDirs().find((d) => !before.has(d));
  const summary = JSON.parse(readFileSync(join(REPO, "eval/results", dir, "summary.json"), "utf8"));
  const c = summary.cases.find((x) => x.id === "aq-01");
  assert.equal(c.status, "scored");
  assert.match(c.hypothesis, /capital of australia/i);
});

test("replay-commits.mjs replays one case", { skip }, () => {
  const out = node("replay-commits.mjs", "--cases", "aq-01", "--audio-dir", AUDIO_DIR);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /aq-01/);
  assert.match(out.stdout, /onSpeechEnd|pause-EMA|cap|stop/);
  assert.match(out.stdout, /capital of australia/i);
});
