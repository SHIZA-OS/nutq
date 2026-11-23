// "Forget token": the saved pairing token can be removed from this browser, for the current gateway URL only. A token is
// never removed by anything else: not a plain socket close, and not an AUTH_ERROR frame (the gateway sends that for a failed
// model-provider call on an already authenticated socket, ws.rs ws_turn_failure_frame; a rejected pairing token is an HTTP
// 401 on the upgrade, which the browser shows as a bare close with no session_start). Real page in headless Chrome against
// the stub gateway (page-harness.mjs); every token here is an obvious fake.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./page-harness.mjs";

const HINT = "Removed from this browser. It still works on ZeroClaw until revoked: zeroclaw gateway get-paircode --rotate revokes all tokens, --rotate-device <id> revokes one.";
const OTHER_KEY = "nutq:pairing-token:ws://other.example/ws/chat";

let h;
let p;
let key; // the storage key for the stub gateway's URL
const r = {};
const read = (k) => p.page.evaluate((k) => localStorage.getItem(k), k);
const ui = () =>
  p.page.evaluate(() => ({
    disabled: document.getElementById("forget-token-btn").disabled,
    field: document.getElementById("auth-token").value,
    pair: document.getElementById("pair-status").textContent,
    hint: document.getElementById("forget-token-hint").textContent,
  }));
const savePasted = (token) =>
  p.page.evaluate((token) => {
    document.getElementById("pair-fallback-token").value = token;
    document.getElementById("pair-fallback-save-btn").click();
  }, token);

before(async () => {
  h = await startHarness();
  p = await h.openPage("");
  key = `nutq:pairing-token:ws://127.0.0.1:${h.server.address().port}/ws/chat`;
  r.empty = await ui();

  await savePasted("test-token-123");
  await p.page.evaluate((k) => localStorage.setItem(k, "test-token-other"), OTHER_KEY);
  r.saved = await ui();

  // A model-provider AUTH_ERROR on a live socket, then a plain close: neither removes the token.
  await p.send({ type: "error", code: "AUTH_ERROR", message: "invalid api key" });
  r.afterAuthError = { stored: await read(key), ui: await ui() };
  h.sockets.at(-1).destroy();
  await p.waitLog("WebSocket closed");
  r.afterClose = { stored: await read(key), ui: await ui() };

  await p.page.click("#forget-token-btn");
  r.forgot = { ui: await ui(), stored: await read(key), other: await read(OTHER_KEY), events: (await p.state()).events };
});

after(async () => {
  await h?.close();
});

test("the button is disabled while nothing is stored for the URL", () => {
  assert.equal(r.empty.disabled, true);
});

test("saving a token enables it", () => {
  assert.equal(r.saved.disabled, false);
});

test("an AUTH_ERROR frame and a plain socket close both leave the token alone", () => {
  assert.equal(r.afterAuthError.stored, "test-token-123");
  assert.equal(r.afterClose.stored, "test-token-123");
  assert.equal(r.afterClose.ui.disabled, false);
});

test("forget removes this URL's key and no other", () => {
  assert.equal(r.forgot.stored, null);
  assert.equal(r.forgot.other, "test-token-other");
});

test("forget clears the field, shows the unpaired state and the hint, and disables the button", () => {
  assert.deepEqual(r.forgot.ui, { disabled: true, field: "", pair: "not paired", hint: HINT });
});

test("forget logs token_forgotten with a reason and no token value", () => {
  const ev = r.forgot.events.filter((e) => e.event === "token_forgotten");
  assert.equal(ev.length, 1);
  assert.deepEqual(Object.keys(ev[0]).sort(), ["event", "reason", "timestamp_ms"]);
  assert.equal(ev[0].reason, "user");
});
