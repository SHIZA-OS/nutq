// Browser storage that throws on every access (blocked site data, some private windows): the page still loads and renders, the
// microphone still starts and stops, and a pairing token pasted in is used for the visit even though it cannot be saved. Real page
// in headless Chrome against the stub gateway (page-harness.mjs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./page-harness.mjs";

let h;
let p;
const r = {};

const blockStorage = () => {
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, { get: () => { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  }
  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));
};

before(async () => {
  h = await startHarness();
  p = await h.openPage("", { init: { content: `(${blockStorage})()` } });
  await p.commitOnStop();
  r.loaded = await p.page.evaluate(() => ({ log: document.getElementById("log").textContent, errors: window.__errors }));
  await p.page.evaluate(() => document.getElementById("ws-url").dispatchEvent(new Event("change"))); // reads the saved token
  await p.utterance();
  r.mic = await p.state();
  await p.page.evaluate(() => {
    document.getElementById("pair-fallback-token").value = "placeholder-token";
    document.getElementById("pair-fallback-save-btn").click(); // tries to save it
  });
  r.pasted = await p.page.evaluate(() => ({ field: document.getElementById("auth-token").value, log: document.getElementById("log").textContent, errors: window.__errors }));
});

after(async () => {
  await h?.close();
});

test("the page finishes loading with storage blocked", () => {
  assert.deepEqual(r.loaded.errors, []);
  assert.match(r.loaded.log, /Page loaded/);
});

test("the microphone starts and stops", () => {
  assert.deepEqual(r.mic.events.filter((e) => e.event.startsWith("mic_button")).map((e) => e.event), ["mic_button_press", "mic_button_release"]);
});

test("a pasted pairing token is used for the visit although it cannot be saved", () => {
  assert.equal(r.pasted.field, "placeholder-token");
  assert.match(r.pasted.log, /Saved manually-pasted pairing token/);
  assert.deepEqual(r.pasted.errors, []);
});
