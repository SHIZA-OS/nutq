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
export function readFrames(state, chunk) {
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
    if ((b[0] & 15) === 8) state.closeFrame = true; // the browser started the closing handshake
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
  // received: { conn, msg } in arrival order, conn = index into sockets. urls[conn] is the upgrade request URL; closed holds the conns whose
  // TCP connection has closed and closeRequested those the browser sent a close frame on (the stub never answers one); upgrades counts every upgrade attempt, and while `refuse` is true an attempt gets a 403 and no conn.
  const h = { sockets: [], received: [], urls: [], closed: new Set(), closeRequested: new Set(), upgrades: 0, refuse: false, upgradeDelay: 0 };
  h.server = http.createServer((_, res) => res.end("stub")).listen(0, "127.0.0.1");
  h.server.on("upgrade", (req, sock) => {
    h.upgrades++;
    if (h.refuse) {
      sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const conn = h.sockets.push(sock) - 1;
    h.urls[conn] = req.url;
    const accepted = () => sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on("close", () => h.closed.add(conn));
    const state = { buf: Buffer.alloc(0) };
    sock.on("data", (d) => {
      for (const msg of readFrames(state, d)) h.received.push({ conn, msg });
      if (state.closeFrame) h.closeRequested.add(conn);
    });
    sock.on("error", () => {});
    const open = () => {
      accepted();
      sock.write(frame({ type: "session_start", session_id: `stub${conn}`, resumed: false }));
    };
    if (h.upgradeDelay) setTimeout(open, h.upgradeDelay);
    else open();
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

  h.openPage = async (query, { keepFirstWait = false } = {}) => {
    const page = await h.context.newPage();
    await page.route(/\/src\/vendor\/transcriber\.ts/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_TRANSCRIBER }));
    await page.addInitScript(() => {
      window.__sp = { utterances: [], cancels: 0 };
      window.__commitOnStop = false;
      // Timers of 60 s or more (the reply timeout) are kept instead of scheduled; __fireLong() runs them, __longCount() counts them.
      const realSet = window.setTimeout.bind(window);
      const realClear = window.clearTimeout.bind(window);
      const long = new Map();
      let nextId = -1;
      // The first utterance of a turn waits FIRST_UTTERANCE_WAIT_MS (700) for more units (src/speech-queue.ts). Most tests are about
      // something else, so that wait is collapsed to 0 ms; first-wait.test.mjs sets __keepFirstWait and fires it with __fireLong().
      window.setTimeout = (fn, ms, ...a) => {
        if (ms === 700 && !window.__keepFirstWait) return realSet(fn, 0, ...a);
        if (ms >= 60000 || ms === 700) {
          const id = nextId--;
          long.set(id, () => fn(...a));
          return id;
        }
        return realSet(fn, ms, ...a);
      };
      window.clearTimeout = (id) => (long.delete(id) ? undefined : realClear(id));
      window.__fireLong = () => {
        const fns = [...long.values()];
        long.clear();
        fns.forEach((f) => f());
        return fns.length;
      };
      window.__longCount = () => long.size;
      // Every WebSocket the page makes, so a test can call an old socket's handlers as if it delivered something late.
      window.__wsInstances = [];
      window.WebSocket = class extends window.WebSocket {
        constructor(...a) {
          super(...a);
          window.__wsInstances.push(this);
        }
      };
      window.__now = 1000000;
      Date.now = () => window.__now;
      window.speechSynthesis.speak = (u) => window.__sp.utterances.push(u);
      window.speechSynthesis.cancel = () => window.__sp.cancels++;
      navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [{ getSettings: () => ({}) }] });
    });
    if (keepFirstWait) await page.addInitScript(() => (window.__keepFirstWait = true));
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
      h.sockets[conn]?.write(frame(obj)); // a connection that does not exist is a test failure to report, not a throw here
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
      await page.click("#mic-btn", { timeout: 3000 }).catch(() => {}); // a disabled button is a state the assertions report, not a throw here
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
