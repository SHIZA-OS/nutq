#!/usr/bin/env node
// Replays recorded WAVs through the real page in system Chrome and scores them.
// No ZeroClaw involved: the page runs with ?eval=1&nosend=1, so nothing is sent.
//
// Usage:
//   node eval/runner/run-wer.mjs --label <name> [--model model/base]
//     [--audio-dir ~/Shiza/nutq-eval-audio/cases] [--cases id,id]
//
// For each case: a fresh Chrome (same --user-data-dir under /tmp for the whole
// run, so the model cache is warm after the first case) with Chrome's fake mic
// reading the WAV once (%noloop). Wait for the mic button to enable (model and
// VAD loaded, so no audio is lost to the load), click it, wait for the
// transcript_final event. If none arrives within WAV duration + 10 s, click the
// mic to stop manually (this is how the silence case ends). Events are saved via
// the page's Download events JSONL button (Blob captured in-page) to
// eval/results/<date>-wer-<label>/raw/<id>.events.jsonl (raw/ is gitignored),
// then wer.mjs scoring writes summary.json and README.md next to it.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJsonl, scoreRun, loadEventsDir, loadFlags, numNormSection } from "./wer.mjs";

const CHROME = "/usr/bin/google-chrome";
const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const LOAD_TIMEOUT_MS = 240_000; // cold model download measured at 27 to 38 s; generous margin
const GRACE_MS = 1_500; // let a late stt_committed land before downloading events

function parseArgs(argv) {
  const args = { model: "model/base", audioDir: join(homedir(), "Shiza/nutq-eval-audio/cases"), cases: null, label: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--audio-dir") args.audioDir = argv[++i].replace(/^~(?=\/)/, homedir());
    else if (argv[i] === "--cases") args.cases = argv[++i].split(",");
    else if (argv[i] === "--label") args.label = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.label) throw new Error("--label is required");
  return args;
}

function wavDurationMs(path) {
  const b = readFileSync(path);
  let byteRate = 0;
  for (let off = 12; off + 8 <= b.length; ) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = b.readUInt32LE(off + 16);
    if (id === "data") return Math.round(((size > b.length ? b.length - off - 8 : size) / byteRate) * 1000);
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
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

// Held at module level from the moment of spawn, so the exit and signal hooks
// below can stop the server even if startup or a later step fails.
let viteChild = null;
let userDataDir = null;
process.on("exit", () => {
  viteChild?.kill();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(sig === "SIGINT" ? 130 : 143));
}

async function startVite() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(REPO, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
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

async function runCase(c, wav, { baseUrl, model, userDataDir, rawDir }) {
  const durationMs = wavDurationMs(wav);
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // The Download events JSONL button builds a Blob and clicks an <a download>.
    // Chrome crashed (SIGILL) saving that file in headless runs, so keep the
    // button's own code path but capture the Blob in-page and skip the file save.
    await page.addInitScript(() => {
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b) => ((window.__evalBlob = b), orig.call(URL, b));
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) HTMLElement.prototype.click.call(this);
      };
    });
    await page.goto(`${baseUrl}?eval=1&nosend=1&model=${model}`);
    await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: LOAD_TIMEOUT_MS });

    const hasFinal = () => page.evaluate(() => document.getElementById("log").textContent.includes('"event":"transcript_final"'));
    const waitFinal = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await hasFinal()) return true;
        await page.waitForTimeout(250);
      }
      return hasFinal();
    };

    await page.click("#mic-btn");
    let ended = "auto";
    if (!(await waitFinal(durationMs + 10_000))) {
      ended = "manual_stop";
      await page.click("#mic-btn"); // stop; finishListening("manual") logs transcript_final
      await waitFinal(15_000);
    }
    await page.waitForTimeout(GRACE_MS);

    await page.click("#eval-download-btn");
    const jsonl = await page.evaluate(() => window.__evalBlob.text());
    writeFileSync(join(rawDir, `${c.id}.events.jsonl`), jsonl);
    return { ended };
  } finally {
    await context.close();
  }
}

function readme({ args, date, summary, run }) {
  const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const o = summary.overall_excluding_silence;
  const rows = summary.cases.map((r) => {
    const w = r.status === "scored" ? pct(r.wer) : r.status === "silence" ? `words_produced=${r.words_produced}` : r.reason;
    return `| ${r.id} | ${r.status} | ${w} | ${r.trigger ?? ""} | ${JSON.stringify(r.hypothesis ?? "")} |`;
  });
  return [
    `# ${date}: WER replay, ${args.label} (${args.model})`,
    "",
    "Recorded WAVs replayed through the page in system Chrome with a fake mic, `?eval=1&nosend=1`.",
    "Nothing was sent to ZeroClaw. Hypothesis text is included because the cases are scripted.",
    "",
    `- Cases attempted: ${run.attempted.length}; missing audio: ${run.missing_audio.length ? run.missing_audio.join(", ") : "none"}; run errors: ${run.errors.length ? run.errors.map((e) => e.id).join(", ") : "none"}`,
    `- Scored: ${summary.meta.n_scored}; no_transcript: ${summary.meta.n_no_transcript}; commit_mismatch: ${summary.commit_mismatch.length ? summary.commit_mismatch.join(", ") : "none"}`,
    `- Overall WER (corpus-level, excluding silence): ${pct(o.wer)} over ${o.ref_words} reference words (S${o.S} D${o.D} I${o.I})`,
    "",
    "| id | status | WER | trigger | hypothesis |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "Command: `" + `node eval/runner/run-wer.mjs --label ${args.label} --model ${args.model}` + (args.cases ? ` --cases ${args.cases.join(",")}` : "") + "`",
    "",
  ].join("\n") + numNormSection(summary);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local
  const allCases = parseJsonl(readFileSync(join(REPO, "eval/wer/cases.jsonl"), "utf8")).rows;
  let cases = allCases;
  if (args.cases) {
    const unknown = args.cases.filter((id) => !allCases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(", ")}`);
    cases = allCases.filter((c) => args.cases.includes(c.id));
  }

  const outDir = join(REPO, "eval/results", `${date}-wer-${args.label}`);
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "nutq-wer-"));

  const run = { model: args.model, label: args.label, date, audio_dir: args.audioDir.replace(homedir(), "~"), attempted: [], missing_audio: [], errors: [], ended: {} };
  const vite = await startVite();
  const stopVite = () => vite.child.kill();

  try {
    for (const c of cases) {
      const wav = join(args.audioDir, `${c.id}.wav`);
      if (!existsSync(wav)) {
        run.missing_audio.push(c.id);
        console.error(`${c.id}: MISSING audio, skipped`);
        continue;
      }
      run.attempted.push(c.id);
      const t0 = Date.now();
      try {
        const { ended } = await runCase(c, wav, { baseUrl: vite.url, model: args.model, userDataDir, rawDir });
        run.ended[c.id] = ended;
        console.error(`${c.id}: done (${ended}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        run.errors.push({ id: c.id, error: String(e.message ?? e).split("\n")[0] });
        console.error(`${c.id}: ERROR ${e.message}`);
      }
    }
  } finally {
    stopVite();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const scored = cases.filter((c) => run.attempted.includes(c.id));
  const summary = { run, ...scoreRun(scored, loadEventsDir(outDir), loadFlags()) };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(outDir, "README.md"), readme({ args, date, summary, run }));
  console.error(`wrote ${outDir}/summary.json and README.md`);
}

main().catch((e) => {
  console.error(`run-wer: ${e.message}`);
  process.exit(1);
});
