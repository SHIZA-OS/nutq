// Shared by the eval drivers (run-wer, run-model-only, vad-onset): start the Vite dev
// server on a free port and own the cleanup. The server handle and temp dirs live at
// module level from the moment they exist, so the exit and signal hooks can stop and
// remove them even if startup or a later step fails. Processes are only ever stopped
// through the handle recorded at spawn.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(import.meta.url), "../../..");

let viteChild = null;
const tempDirs = [];
process.on("exit", () => {
  viteChild?.kill();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(sig === "SIGINT" ? 130 : 143));
}

// Where the recorded test audio is (<case id>.wav files, not in the repository): --audio-dir, else EVAL_AUDIO_DIR, else an error.
export function audioDirFrom(flag, env = process.env) {
  const dir = flag || env.EVAL_AUDIO_DIR;
  if (!dir) throw new Error("no audio directory: pass --audio-dir <dir> or set EVAL_AUDIO_DIR (the directory holding <case id>.wav files)");
  return dir.replace(/^~(?=\/)/, homedir());
}

// A temp dir (for example a Chrome profile) that is removed on exit.
export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

export async function startVite() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(REPO, "node_modules/vite/bin/vite.js"), "--config", join(REPO, "eval/runner/vite.test.config.mjs"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: REPO,
    stdio: "ignore",
  });
  viteChild = child;
  console.error(`dev server PID ${child.pid} on port ${port}`);
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("vite exited early");
    try {
      if ((await fetch(url)).ok) return { child, url };
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error("vite did not become ready");
}
