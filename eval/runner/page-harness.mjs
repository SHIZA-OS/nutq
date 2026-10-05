// Shared by the page tests that need a stub gateway they can watch: the real page in headless Chrome, a Vite dev server, a
// WebSocket server that keeps every connection and records every message frame the page sends (so a test can say what went
// over the wire, not only what the page logged), a fake Transcriber, and a fake clock (the page's Date.now moves only when
// the test says so). mic-cancel.test.mjs has its own older copy of the same ideas.

import http from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

export const frame = (obj) => {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
};

// Reads the text frames a browser sends (always masked; payloads here are under 64 KiB). Returns the parsed JSON of each.
function readFrames(state, chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  const out = [];
  for (;;) {
    const b = state.buf;
    if (b.length < 2) break;
    let len = b[1] & 127;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) break;
      len = (b[2] << 8) | b[3];
      off = 4;
    }
    if (b.length < off + 4 + len) break;
    const mask = b.subarray(off, off + 4);
    const data = Buffer.from(b.subarray(off + 4, off + 4 + len)).map((x, i) => x ^ mask[i % 4]);
    state.buf = b.subarray(off + 4 + len);
    if ((b[0] & 15) === 1) out.push(JSON.parse(Buffer.from(data).toString("utf8")));
  }
  return out;
}

const FAKE_TRANSCRIBER = `export class Transcriber {
  constructor(model, callbacks) { this.callbacks = callbacks; window.__tcb = callbacks; }
  async load() {}
  attachStream() {}
  async start() {}
  // A transcript is committed on stop when the test asks: the next text of window.__texts, or "hello there".
  async stop() {
    if (window.__stopDelay) await new Promise((r) => setTimeout(r, window.__stopDelay));
    if (window.__commitOnStop) this.callbacks.onTranscriptionCommitted((window.__texts ?? []).shift() ?? "hello there");
  }
}`;

export async function startHarness() {
  const h = { sockets: [], received: [] }; // received: { conn, msg } in arrival order, conn = index into sockets
  h.server = http.createServer((_, res) => res.end("stub")).listen(0, "127.0.0.1");
  h.server.on("upgrade", (req, sock) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = h.sockets.push(sock) - 1;
    const state = { buf: Buffer.alloc(0) };
    sock.on("data", (d) => {
      for (const msg of readFrames(state, d)) h.received.push({ conn, msg });
    });
    sock.on("error", () => {});
    sock.write(frame({ type: "session_start", session_id: `stub${conn}`, resumed: false }));
  });
  await new Promise((res) => h.server.once("listening", res));
  h.vite = await startVite();
  h.context = await chromium.launchPersistentContext(makeTempDir("nutq-harness-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  // The message frames the page sent on connection `conn` (default: all), as { content }.
  h.messages = (conn) => h.received.filter((r) => r.msg.type === "message" && (conn === undefined || r.conn === conn)).map((r) => r.msg);
  h.close = async () => {
    await h.context?.close();
    h.vite?.child.kill();
    for (const s of h.sockets) s.destroy();
    h.server?.close();
  };

  h.openPage = async (query) => {
    const page = await h.context.newPage();
    await page.route(/\/src\/vendor\/transcriber\.ts/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_TRANSCRIBER }));
    await page.addInitScript(() => {
      window.__sp = { utterances: [], cancels: 0 };
      window.__commitOnStop = false;
      window.__now = 1000000;
      Date.now = () => window.__now;
      window.speechSynthesis.speak = (u) => window.__sp.utterances.push(u);
      window.speechSynthesis.cancel = () => window.__sp.cancels++;
      navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [{ getSettings: () => ({}) }] });
    });
    await page.goto(`${h.vite.url}?${query}`);
    await page.fill("#ws-url", `ws://127.0.0.1:${h.server.address().port}/ws/chat`);
    await page.fill("#agent-alias", "stub");
    await page.fill("#auth-token", "stub-token");
    const connect = async () => {
      await page.click("#connect-btn");
      await page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("connected"), null, { timeout: 15000 });
      await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: 15000 });
    };
    await connect();
    const p = { page, connect, conn: h.sockets.length - 1 };
    // Frames from the stub gateway to the page, on connection `conn` (default: the newest).
    p.send = async (obj, conn = h.sockets.length - 1) => {
      h.sockets[conn].write(frame(obj));
      await page.waitForTimeout(150);
    };
    p.state = () =>
      page.evaluate(() => ({
        cancels: window.__sp.cancels,
        spoken: window.__sp.utterances.map((u) => u.text),
        hint: document.getElementById("mic-hint").textContent,
        status: document.getElementById("conn-status").textContent,
        micDisabled: document.getElementById("mic-btn").disabled,
        micText: document.getElementById("mic-btn").textContent,
        events: [...document.getElementById("log").textContent.matchAll(/EVENT (\{.*\})/g)].map((m) => JSON.parse(m[1])),
      }));
    p.mic = async () => {
      await page.click("#mic-btn");
      await page.waitForTimeout(150);
    };
    p.advance = (ms) => page.evaluate((ms) => (window.__now += ms), ms);
    p.texts = (...t) => page.evaluate((t) => (window.__texts = t), t);
    p.commitOnStop = () => page.evaluate(() => (window.__commitOnStop = true));
    // An utterance: tap to start listening, tap to stop (the stop commits the next text). The clock then moves past the
    // re-arm window so the next tap is a deliberate one.
    p.utterance = async () => {
      await p.mic();
      await p.mic();
      await p.advance(5000);
    };
    p.waitLog = (text, ms = 4000) => page.waitForFunction((t) => document.getElementById("log").textContent.includes(t), text, { timeout: ms }).catch(() => {});
    return p;
  };
  return h;
}

export const eventNames = (events, ...of) => events.filter((e) => of.includes(e.event)).map((e) => e.event);
export const eventsOf = (events, name) => events.filter((e) => e.event === name);
