// The recorded test audio is not in the repository, so the eval scripts have no default location for it: the directory comes from
// --audio-dir or EVAL_AUDIO_DIR, and a script that needs it says so at once when neither is given. Nothing committed names a
// personal path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, audioDirFrom } from "./vite-server.mjs";

const noEnv = { ...process.env, EVAL_AUDIO_DIR: "" };
const run = (script, ...args) => spawnSync(process.execPath, [join(REPO, "eval/runner", script), ...args], { cwd: REPO, env: noEnv, encoding: "utf8", timeout: 20_000 });

test("audioDirFrom: the flag wins over the environment, ~ is expanded, and neither is an error", () => {
  assert.equal(audioDirFrom("/a", { EVAL_AUDIO_DIR: "/b" }), "/a");
  assert.equal(audioDirFrom(null, { EVAL_AUDIO_DIR: "/b" }), "/b");
  assert.equal(audioDirFrom("~/rec", {}), join(homedir(), "rec"));
  assert.throws(() => audioDirFrom(null, {}), /EVAL_AUDIO_DIR.*--audio-dir|--audio-dir.*EVAL_AUDIO_DIR/);
  assert.throws(() => audioDirFrom(null, { EVAL_AUDIO_DIR: "" }), /EVAL_AUDIO_DIR/);
});

for (const [script, args] of [
  ["run-wer.mjs", ["--label", "t"]],
  ["run-model-only.mjs", ["--label", "t"]],
  ["vad-onset.mjs", []],
  ["replay-commits.mjs", ["--cases", "aq-01"]],
  ["endpoint-sweep.mjs", ["--streams", "s.jsonl", "--recordings", "r"]],
]) {
  test(`${script} without a directory stops at once and names both ways to give one`, () => {
    const out = run(script, ...args);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /EVAL_AUDIO_DIR/);
    assert.match(out.stderr, /--audio-dir/);
  });
}

test("no committed file names a personal audio path", () => {
  const needle = ["Shiza", "nutq-eval-audio"].join("/");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter((p) => p && existsSync(join(REPO, p)) && !/\.(onnx|wasm|woff2)$/.test(p) && p !== "package-lock.json");
  assert.deepEqual(files.filter((p) => readFileSync(join(REPO, p), "utf8").includes(needle) || readFileSync(join(REPO, p), "utf8").includes("~/Shiza")), []);
});
