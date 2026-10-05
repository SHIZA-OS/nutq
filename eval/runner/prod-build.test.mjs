// The production build (vite build, import.meta.env.PROD): no eval instrumentation ships, ?eval=1 and the eval-only params do nothing,
// and the built dist runs when served statically from the gateway's own origin: pair, connect, send. The gateway here is a stub that
// serves dist, answers POST /pair, and speaks the /ws/chat frames the page needs.
//
// Sending needs speech: Chrome's fake microphone plays one recorded case (EVAL_AUDIO_DIR, default ~/Shiza/nutq-eval-audio/cases,
// the same recordings run-wer.mjs uses). Without that file the send test is skipped; everything else runs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { REPO, makeTempDir } from "./vite-server.mjs";
import { frame, readFrames } from "./page-harness.mjs";

const AUDIO_DIR = (process.env.EVAL_AUDIO_DIR ?? join(homedir(), "Shiza/nutq-eval-audio/cases")).replace(/^~(?=\/)/, homedir());
const WAV = join(AUDIO_DIR, "aq-01.wav"); // "What is the capital of Australia?"
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const TOKEN = "stub-token";

// The event names of main.ts's EvalEvent union, read from the source so a new event is covered without touching this test. Two of them
// are also words the shipped code needs for other reasons: the gateway's session_start frame and the Transcriber's speech_end commit trigger.
const mainSrc = readFileSync(join(REPO, "src/main.ts"), "utf8");
const union = mainSrc.slice(mainSrc.indexOf("type EvalEvent ="), mainSrc.indexOf("type EvalEventRecord"));
const EVAL_EVENTS = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((n) => !["session_start", "speech_end"].includes(n));
const EVAL_ONLY = ["nosend", "rawmic", "eval-download-btn", "nutq-events", "EVENT {"];

const dist = makeTempDir("nutq-dist-");
let server, browser, port;
const gw = { received: [], pairCodes: [], wsTokens: [] };
const r = {};

function textFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" ? [] : textFiles(p);
    return /\.(js|mjs|css|html)$/.test(e.name) ? [p] : [];
  });
}

before(async () => {
  execFileSync(process.execPath, [join(REPO, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir"], { cwd: REPO, stdio: "ignore" });
  r.built = textFiles(dist).map((p) => [p, readFileSync(p, "utf8")]);

  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/pair") {
      gw.pairCodes.push(req.headers["x-pairing-code"]);
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ paired: true, token: TOKEN, message: "stub paired" }));
    }
    const path = join(dist, req.url.split("?")[0] === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
    if (!path.startsWith(dist) || !existsSync(path) || !statSync(path).isFile()) return (res.statusCode = 404), res.end();
    res.setHeader("content-type", MIME[extname(path)] ?? "application/octet-stream");
    res.end(readFileSync(path));
  });
  server.on("upgrade", (req, sock) => {
    gw.wsTokens.push(new URL(req.url, "http://x").searchParams.get("token"));
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.write(frame({ type: "session_start", session_id: "stub", resumed: false }));
    const state = { buf: Buffer.alloc(0) };
    sock.on("data", (d) => {
      for (const msg of readFrames(state, d)) {
        gw.received.push(msg);
        if (msg.type === "message") sock.write(frame({ type: "done", full_response: "stub answer", tokens_used: 1 }));
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  port = server.address().port;

  const hasWav = existsSync(WAV);
  browser = await chromium.launchPersistentContext(makeTempDir("nutq-prod-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", ...(hasWav ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}%noloop`] : [])],
  });

  // ?eval=1 and the eval-only params, before anything is connected: they must be inert.
  const p0 = await browser.newPage();
  await p0.goto(`http://127.0.0.1:${port}/?eval=1&nosend=1&rawmic=1&model=nonsense`);
  await p0.waitForTimeout(1500);
  r.inert = await p0.evaluate(() => ({
    micDisabled: document.getElementById("mic-btn").disabled,
    hint: document.getElementById("mic-hint").textContent,
    log: document.getElementById("log").textContent,
    exportBtn: document.getElementById("eval-download-btn")?.hidden ?? "absent",
  }));
  await p0.close();

  // pair, connect, send on the same origin, no eval params.
  const page = await browser.newPage();
  r.errors = [];
  page.on("pageerror", (e) => r.errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill("#ws-url", `ws://127.0.0.1:${port}/ws/chat`);
  await page.fill("#agent-alias", "stub");
  await page.fill("#pair-code", "123456");
  await page.click("#pair-btn");
  await page.waitForFunction(() => document.getElementById("pair-status").textContent.includes("paired") && !document.getElementById("pair-status").textContent.includes("not"), null, { timeout: 15000 });
  r.token = await page.inputValue("#auth-token");
  await page.click("#connect-btn");
  await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: 180000 });
  r.status = await page.textContent("#conn-status");
  if (hasWav) {
    await page.click("#mic-btn");
    const end = Date.now() + 40000;
    while (Date.now() < end && !gw.received.some((m) => m.type === "message")) await page.waitForTimeout(250);
    await page.waitForTimeout(500);
    r.reply = await page.textContent("#reply-box");
  }
});

after(async () => {
  await browser?.close();
  server?.close();
});

test("the bundle carries no eval event names", () => {
  assert.ok(EVAL_EVENTS.length > 30, `read ${EVAL_EVENTS.length} event names from main.ts`);
  const found = [];
  for (const [p, text] of r.built) for (const n of EVAL_EVENTS) if (text.includes(`"${n}"`) || text.includes(`'${n}'`) || text.includes(`\`${n}\``)) found.push(`${p.slice(dist.length)}: ${n}`);
  assert.deepEqual(found, []);
});

test("the bundle carries no eval-only params or export button", () => {
  const found = [];
  for (const [p, text] of r.built) for (const s of EVAL_ONLY) if (text.includes(s)) found.push(`${p.slice(dist.length)}: ${s}`);
  assert.deepEqual(found, []);
});

test("?eval=1 and the eval-only params do nothing in the built page", () => {
  assert.equal(r.inert.micDisabled, true); // nosend would have enabled it without a gateway
  assert.doesNotMatch(r.inert.log, /Invalid model|EVENT /); // model=nonsense would be rejected; no event lines
  assert.ok(r.inert.exportBtn === "absent" || r.inert.exportBtn === true);
});

test("dist served from the gateway's own origin: pairs automatically", () => {
  assert.deepEqual(gw.pairCodes, ["123456"]);
  assert.equal(r.token, TOKEN);
});

test("dist connects with the paired token and loads the speech model", () => {
  assert.deepEqual(gw.wsTokens, [TOKEN]);
  assert.match(r.status, /connected/);
  assert.deepEqual(r.errors, []);
});

test("dist sends a spoken message and shows the reply", { skip: !existsSync(WAV) && `no recording at ${WAV}` }, () => {
  const sent = gw.received.filter((m) => m.type === "message");
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /capital of Australia/i);
  assert.match(r.reply, /stub answer/);
});
