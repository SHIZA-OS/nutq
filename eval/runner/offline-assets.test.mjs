// First-load smoke test with every third-party host blocked: the real page, the real Transcriber and the real speech model
// in headless Chrome against a stub gateway. The model weights, both ONNX Runtime wasm builds, the VAD model and worklet, and the
// fonts must all come from the app's own origin, so a blocked CDN must change nothing. Any request to another host (other than the
// stub gateway's WebSocket) fails the test. The VAD's audio worklet is fetched by the audio thread, which neither Playwright's
// response events nor its routes see, so it is checked differently: the base paths must be same-origin, the worklet file must be
// served there, and vad-web must not have logged that it fell back to the ScriptProcessor.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./page-harness.mjs";

const BLOCKED = /^https?:\/\/(cdn\.jsdelivr\.net|download\.moonshine\.ai|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const MUST_LOAD = [
  "moonshine/model/base/quantized/encoder_model.onnx",
  "moonshine/model/base/quantized/decoder_model_merged.onnx",
  "onnxruntime-web-1.22.0/ort-wasm-simd-threaded.jsep.mjs",
  "onnxruntime-web-1.22.0/ort-wasm-simd-threaded.jsep.wasm",
  "onnxruntime-web-1.14.0/ort-wasm-simd.wasm",
  "vad-web-0.0.24/silero_vad_v5.onnx",
  ".woff2",
];

let h;
const r = { blocked: [], foreign: [], ok: [], pageErrors: [], console: [] };

before(async () => {
  h = await startHarness();
  await h.context.route(BLOCKED, (route) => {
    r.blocked.push(route.request().url());
    return route.abort();
  });
  const page = await h.context.newPage();
  page.on("pageerror", (e) => r.pageErrors.push(String(e)));
  page.on("console", (m) => r.console.push(m.text()));
  page.on("response", (res) => {
    const u = res.url();
    if (!u.startsWith(h.vite.url) && !u.startsWith("data:") && !u.startsWith("blob:")) r.foreign.push(u);
    else if (res.ok()) r.ok.push(u);
  });
  // A real MediaStream from an oscillator, so the VAD gets a stream and starts its audio worklet.
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
  await page.goto(h.vite.url);
  await page.fill("#ws-url", `ws://127.0.0.1:${h.server.address().port}/ws/chat`);
  await page.fill("#agent-alias", "stub");
  await page.fill("#auth-token", "stub-token");
  await page.click("#connect-btn");
  await page.waitForFunction(() => !document.getElementById("mic-btn").disabled, null, { timeout: 90000 });
  await page.click("#mic-btn");
  await page.waitForFunction(() => document.getElementById("mic-btn").textContent !== "Start listening", null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  r.hint = await page.textContent("#mic-hint");
  r.status = await page.textContent("#conn-status");
  r.fontsLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded").length;
  });
  r.log = await page.textContent("#log");
  r.bases = await page.evaluate(async () => {
    const { Settings } = await import("/src/vendor/constants.ts");
    const worklet = await fetch(Settings.BASE_ASSET_PATH.SILERO_VAD + "vad.worklet.bundle.min.js");
    return { ...Settings.BASE_ASSET_PATH, origin: location.origin, worklet: worklet.status, workletText: (await worklet.text()).includes("vad-helper-worklet") };
  });
});

after(async () => {
  await h?.close();
});

test("loads and connects with the third-party hosts blocked", () => {
  assert.match(r.status, /connected/);
  assert.deepEqual(r.pageErrors, []);
  assert.doesNotMatch(r.log, /Speech model unavailable|platform|unsupported/i);
});

test("no request goes to a third-party host", () => {
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.foreign, []);
});

for (const path of MUST_LOAD) {
  test(`served from the app's own origin: ${path}`, () => {
    assert.ok(r.ok.some((u) => u.includes(path)), `no successful request for ${path}`);
  });
}

test("the page's fonts load", () => {
  assert.ok(r.fontsLoaded > 0);
});

test("the VAD worklet and every asset base path are same-origin", () => {
  for (const k of ["MOONSHINE", "ONNX_RUNTIME", "SILERO_VAD"]) assert.ok(r.bases[k].startsWith(r.bases.origin + "/"), `${k} is ${r.bases[k]}`);
  assert.equal(r.bases.worklet, 200);
  assert.ok(r.bases.workletText);
  assert.ok(!r.console.some((t) => t.includes("falling back to ScriptProcessor")), "vad-web fell back to the ScriptProcessor");
});
