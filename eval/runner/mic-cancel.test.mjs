// Tests that tapping the mic button to start listening cancels speech and reports tts_cancelled { reason: "mic_press" },
// with ?tts_stream=1 and without, against a local stub gateway and the real page in headless Chrome. The Transcriber
// module is replaced in the page by a minimal fake (served by route interception) and getUserMedia by a fake stream, so
// the mic button works with no speech model, no microphone and no network. speechSynthesis.speak and cancel are
// recorders and the test fires the utterance callbacks itself. Runs with the rest of the suite via `npm test`.

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
const r = {};

const frame = (obj) => {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
};

const FAKE_TRANSCRIBER = `export class Transcriber {
  constructor(model, callbacks) { this.callbacks = callbacks; }
  async load() {}
  attachStream() {}
  async start() {}
  async stop() {}
}`;

async function openPage(query) {
  const page = await context.newPage();
  await page.route(/\/src\/vendor\/transcriber\.ts/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_TRANSCRIBER }));
  await page.addInitScript(() => {
    window.__sp = { utterances: [], cancels: 0 };
    window.speechSynthesis.speak = (u) => window.__sp.utterances.push(u);
    window.speechSynthesis.cancel = () => window.__sp.cancels++;
    navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [{ getSettings: () => ({}) }] });
  });
  await page.goto(`${vite.url}?${query}`);
  await page.fill("#ws-url", `ws://127.0.0.1:${server.address().port}/ws/chat`);
  await page.fill("#agent-alias", "stub");
  await page.fill("#auth-token", "stub-token");
  await page.click("#connect-btn");
  await page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("connected"), null, { timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: 15000 });
  const send = async (obj) => {
    client.write(frame(obj));
    await page.waitForTimeout(150);
  };
  const state = () =>
    page.evaluate(() => ({
      cancels: window.__sp.cancels,
      events: [...document.getElementById("log").textContent.matchAll(/EVENT (\{.*\})/g)].map((m) => JSON.parse(m[1])),
    }));
  const fire = (i, kind, code) =>
    page.evaluate(([i, kind, code]) => {
      const u = window.__sp.utterances[i];
      if (kind === "start") u.onstart({});
      else if (kind === "end") u.onend({});
      else u.onerror({ error: code });
    }, [i, kind, code]);
  const mic = async () => {
    await page.click("#mic-btn");
    await page.waitForTimeout(150);
  };
  return { page, send, state, fire, mic };
}

const cancelled = (events) => events.filter((e) => e.event === "tts_cancelled").map((e) => e.reason);

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
  context = await chromium.launchPersistentContext(makeTempDir("nutq-miccancel-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  // Flag off: the reply is spoken at done. Tapping the mic cancels it; the browser reports the cancelled utterance
  // afterwards, and that one event carries the reason mic_press.
  let p = await openPage("");
  await p.mic(); // nothing is speaking: speechSynthesis.cancel() is still called, and no event
  r.offIdle = await p.state();
  await p.mic(); // stop listening
  await p.send({ type: "done", full_response: "A reply that is being read out.", tokens_used: 1 });
  await p.fire(0, "start");
  const beforeTap = await p.state();
  await p.mic(); // start listening while it speaks
  await p.fire(0, "error", "canceled"); // the browser's report of the cancelled utterance
  r.offTap = await p.state();
  r.offBefore = beforeTap;
  await p.mic(); // stop listening: must not cancel again
  r.offStop = await p.state();
  // A later cancel that is not the mic (an aborted turn) is back to the plain reason.
  await p.send({ type: "done", full_response: "Another reply to be read out.", tokens_used: 1 });
  await p.fire(1, "start");
  await p.send({ type: "aborted" });
  await p.fire(1, "error", "canceled");
  r.offAborted = await p.state();
  client.destroy();
  await p.page.close();

  // Flag on: the queue reports the cancel itself, at once, with the reason.
  p = await openPage("tts_stream=1");
  await p.send({ type: "chunk", content: "A long enough sentence is here. And another long sentence here. " });
  await p.fire(0, "start");
  const onBefore = await p.state();
  await p.mic();
  await p.fire(0, "end"); // a late end from the cancelled sentence is ignored
  r.onTap = await p.state();
  r.onBefore = onBefore;
  await p.mic(); // stop listening
  r.onStop = await p.state();
  await p.send({ type: "chunk", content: "A fresh sentence after the tap. " });
  await p.fire(1, "start");
  await p.send({ type: "aborted" });
  r.onAborted = await p.state();
  client.destroy();
});

after(async () => {
  await context?.close();
  vite?.child.kill();
  client?.destroy();
  server?.close();
});

test("flag off: tapping the mic while a reply is spoken cancels it and the browser's cancelled report is tts_cancelled mic_press", () => {
  assert.equal(r.offTap.cancels - r.offBefore.cancels, 1);
  assert.deepEqual(cancelled(r.offTap.events), ["mic_press"]);
  assert.ok(r.offTap.events.some((e) => e.event === "mic_button_press"));
});

test("flag off: tapping the mic with nothing speaking stops the engine but reports nothing", () => {
  assert.equal(r.offIdle.cancels, 1);
  assert.deepEqual(cancelled(r.offIdle.events), []);
});

test("flag off: stopping the listening does not cancel speech, and a later abort is reported as canceled again", () => {
  assert.equal(r.offStop.cancels, r.offTap.cancels);
  assert.deepEqual(cancelled(r.offStop.events), ["mic_press"]);
  assert.deepEqual(cancelled(r.offAborted.events), ["mic_press", "canceled"]);
});

test("flag on: tapping the mic while a sentence is spoken cancels the queue at once, as one tts_cancelled mic_press", () => {
  assert.equal(r.onTap.cancels - r.onBefore.cancels, 1);
  assert.deepEqual(cancelled(r.onTap.events), ["mic_press"]);
  assert.equal(r.onTap.events.filter((e) => e.event === "tts_end").length, 0); // the late end is ignored
});

test("flag on: stopping the listening does not cancel speech, and a later abort is reported as canceled", () => {
  assert.equal(r.onStop.cancels, r.onTap.cancels);
  assert.deepEqual(cancelled(r.onStop.events), ["mic_press"]);
  assert.deepEqual(cancelled(r.onAborted.events), ["mic_press", "canceled"]);
});
