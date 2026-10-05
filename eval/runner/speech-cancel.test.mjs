// Tests that main.ts cancels speech when a turn is aborted and when the socket closes, against a local stub
// gateway (a minimal WebSocket server, no ZeroClaw) and the real page in headless Chrome. speechSynthesis.speak
// and cancel are replaced in the page by recorders, so nothing is spoken and no voices are needed. (Cancel on a
// new message needs a speech turn, so it was checked live with a fake microphone, see the commit message.) Runs with the rest of the suite via
// `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let server;
let client = null;
let r;

const frame = (obj) => {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
};

before(async () => {
  server = http.createServer((_, res) => res.end("stub")).listen(0, "127.0.0.1");
  server.on("upgrade", (req, sock) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    client = sock;
    sock.on("data", () => {});
    sock.on("error", () => {});
    sock.write(frame({ type: "session_start", session_id: "stub", resumed: false }));
  });
  await new Promise((res) => server.once("listening", res));
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-speechcancel-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript(() => {
    window.__sp = { spoken: [], cancels: 0 };
    window.speechSynthesis.speak = (u) => window.__sp.spoken.push(u.text);
    window.speechSynthesis.cancel = () => window.__sp.cancels++;
  });
  await page.goto(`${vite.url}?eval=1&model=zzz&tts_stream=0`); // an invalid model name: nothing is downloaded; the original speak-at-done flow
  await page.fill("#ws-url", `ws://127.0.0.1:${server.address().port}/ws/chat`);
  await page.fill("#agent-alias", "stub");
  await page.fill("#auth-token", "stub-token");
  await page.click("#connect-btn");
  await page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("connected"), null, { timeout: 15000 });
  const sp = () => page.evaluate(() => ({ spoken: [...window.__sp.spoken], cancels: window.__sp.cancels }));
  const settle = () => page.waitForTimeout(300);
  r = {};
  r.start = await sp();
  client.write(frame({ type: "chunk", content: "Hello" }));
  client.write(frame({ type: "done", full_response: "Hello there.", tokens_used: 1 }));
  await settle();
  r.afterDone = await sp(); // done speaks, and does not cancel
  client.write(frame({ type: "aborted" }));
  await settle();
  r.afterAborted = await sp();
  client.write(frame({ type: "error", code: "EMPTY_CONTENT", message: "x" }));
  client.write(frame({ type: "chunk", content: "more" }));
  await settle();
  r.afterOtherFrames = await sp(); // other frames do not cancel
  client.destroy(); // the socket closes under the page
  await page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("disconnected"), null, { timeout: 15000 });
  await settle();
  r.afterClose = await sp();
});

after(async () => {
  await context?.close();
  vite?.child.kill();
  client?.destroy();
  server?.close();
});

test("a reply is spoken and does not cancel speech", () => {
  assert.deepEqual(r.start, { spoken: [], cancels: 0 });
  assert.deepEqual(r.afterDone, { spoken: ["Hello there."], cancels: 0 });
});

test("an aborted frame cancels speech", () => assert.equal(r.afterAborted.cancels, 1));

test("other frames (a refused message, a chunk) do not cancel speech", () => assert.equal(r.afterOtherFrames.cancels, 1));

test("a closed socket cancels speech", () => assert.equal(r.afterClose.cancels, 2));
