// What a first-time user sees when something is missing or goes wrong: the speech model fails to load (blocked or failed download)
// and loads on a retry, the first-use line while it loads, a denied or missing microphone, a page that cannot reach the
// microphone, a browser without speech synthesis, and a browser without WebAssembly. The model-load cases use the real Transcriber and the
// real model files (served locally, so blocking them is what a failed download looks like); the rest use the harness's fake Transcriber.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./page-harness.mjs";

const MODEL_FILES = /\/vendor\/moonshine\/model\/base\/quantized\//;
let h;
const r = {};

const read = (page) =>
  page.evaluate(() => ({
    hint: document.getElementById("mic-hint").textContent,
    log: document.getElementById("log").textContent,
    status: document.getElementById("mic-status").textContent,
    micText: document.getElementById("mic-btn").textContent,
    micDisabled: document.getElementById("mic-btn").disabled,
    retryVisible: !!document.getElementById("retry-model-btn") && !document.getElementById("retry-model-btn").hidden,
    envNote: document.getElementById("env-note") && !document.getElementById("env-note").hidden ? document.getElementById("env-note").textContent : "",
  }));

before(async () => {
  h = await startHarness();

  // 1. The real Transcriber, the model files blocked: a failed load, then a retry that works.
  const page = await h.context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
  });
  let blocked = true;
  let release;
  const gate = new Promise((res) => (release = res));
  await page.route(MODEL_FILES, async (route) => {
    if (blocked) return route.abort();
    await gate; // a retry that is held, so the hint can be read while the model loads
    return route.continue();
  });
  await page.goto(h.vite.url);
  await page.fill("#ws-url", `ws://127.0.0.1:${h.server.address().port}/ws/chat`);
  await page.fill("#agent-alias", "stub");
  await page.fill("#auth-token", "stub-token");
  await page.click("#connect-btn");
  await page.waitForFunction(() => document.getElementById("mic-status").textContent.includes("failed"), null, { timeout: 60000 });
  r.failed = await read(page);
  blocked = false;
  await page.click("#retry-model-btn");
  await page.waitForTimeout(500);
  r.loading = await read(page);
  release();
  await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: 90000 });
  r.retried = await read(page);
  r.pageErrors = pageErrors;

  // 2. The microphone.
  const p = await h.openPage("");
  const denied = (name) => p.page.evaluate((name) => (navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("no", name); }), name);
  await denied("NotAllowedError");
  await p.mic();
  r.micDenied = await read(p.page);
  await p.page.evaluate(() => (navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [{ getSettings: () => ({}) }] })));
  await p.advance(5000);
  await p.mic();
  r.micRetry = await read(p.page);
  await p.mic(); // stop again

  await denied("NotFoundError");
  await p.advance(5000);
  await p.mic();
  r.micMissing = await read(p.page);

  // A browser that cannot query the microphone permission (the query throws): the page goes on to ask for the microphone itself.
  await p.page.evaluate(() => {
    navigator.permissions.query = async () => { throw new TypeError("not a valid PermissionName"); };
    window.__gum = 0;
    navigator.mediaDevices.getUserMedia = async () => (window.__gum++, { getAudioTracks: () => [{ getSettings: () => ({}) }] });
  });
  await p.advance(5000);
  await p.mic();
  r.micNoQuery = { ...(await read(p.page)), gum: await p.page.evaluate(() => window.__gum) };
  await p.mic(); // stop again
  await p.page.evaluate(() => (navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("no", "NotFoundError"); }));

  await p.page.evaluate(() => (navigator.permissions.query = async () => ({ state: "denied" })));
  await p.advance(5000);
  await p.mic();
  r.micPolicy = await read(p.page);

  await p.page.evaluate(() => Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true }));
  await p.advance(5000);
  await p.mic();
  r.micInsecure = await read(p.page);

  // 3. Speech synthesis missing.
  const noSpeech = await h.openPage("", {
    init: () => {
      delete Window.prototype.speechSynthesis;
      delete window.speechSynthesis;
    },
  });
  r.noSpeech = await read(noSpeech.page);
  r.noSpeechPresent = await noSpeech.page.evaluate(() => "speechSynthesis" in window);

  // 4. WebAssembly missing.
  const noWasm = await h.openPage("", { init: () => delete window.WebAssembly, connectNow: false });
  await noWasm.page.click("#connect-btn");
  await noWasm.page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("connected"), null, { timeout: 15000 });
  await noWasm.page.waitForTimeout(300);
  r.noWasm = await read(noWasm.page);
});

after(async () => {
  await h?.close();
});

test("a failed model load says what is likely wrong, not that the platform is unsupported", () => {
  assert.match(r.failed.hint, /could not be loaded/i);
  assert.match(r.failed.hint, /network/i);
  assert.match(r.failed.hint, /blocked/i);
  assert.doesNotMatch(r.failed.log, /platform|not supported/i);
  assert.match(r.failed.log, /could not be loaded/i);
  assert.ok(r.failed.retryVisible);
  assert.ok(r.failed.micDisabled);
});

test("the retry loads the model and hides itself", () => {
  assert.equal(r.retried.micDisabled, false);
  assert.equal(r.retried.retryVisible, false);
  assert.match(r.retried.hint, /Tap to start listening/);
  assert.deepEqual(r.pageErrors, []);
});

test("while the model loads the hint says it happens on first use", () => {
  assert.match(r.loading.hint, /Loading the speech model/);
  assert.match(r.loading.hint, /63 MB/);
  assert.match(r.loading.hint, /first use/i);
  assert.equal(r.loading.retryVisible, false);
});

test("a denied microphone says it is blocked and how to allow it, and the button recovers", () => {
  assert.match(r.micDenied.hint, /blocked/i);
  assert.match(r.micDenied.hint, /allow/i);
  assert.equal(r.micDenied.micText, "Start listening");
  assert.equal(r.micRetry.micText, "Stop listening"); // the next tap tries again
  assert.doesNotMatch(r.micRetry.hint, /blocked/i);
});

test("a missing microphone says so", () => {
  assert.match(r.micMissing.hint, /no microphone/i);
  assert.equal(r.micMissing.micText, "Start listening");
});

test("a browser that cannot query the microphone permission still gets to ask for it", () => {
  assert.equal(r.micNoQuery.gum, 1); // the page asked for the microphone itself
  assert.equal(r.micNoQuery.micText, "Stop listening");
});

test("a microphone denied in the browser's settings gets the blocked message without asking again", () => {
  assert.match(r.micPolicy.hint, /blocked/i);
  assert.equal(r.micPolicy.micText, "Start listening");
});

test("a page that cannot reach the microphone says it needs https or localhost", () => {
  assert.match(r.micInsecure.hint, /https/i);
  assert.match(r.micInsecure.hint, /localhost/i);
  assert.equal(r.micInsecure.micText, "Start listening");
});

test("no speech synthesis: a visible note, and the page still connects", () => {
  assert.equal(r.noSpeechPresent, false);
  assert.match(r.noSpeech.envNote, /speak|speech synthesis/i);
  assert.equal(r.noSpeech.micDisabled, false);
});

test("no WebAssembly: a clear message, no retry, no load attempt", () => {
  assert.match(r.noWasm.hint, /WebAssembly/);
  assert.equal(r.noWasm.retryVisible, false);
  assert.equal(r.noWasm.micDisabled, true);
});
