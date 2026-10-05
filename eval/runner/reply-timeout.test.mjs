// The reply timeout (REPLY_TIMEOUT_MS) closes the socket: a late done after a timeout could clear the next turn's in-flight flag
// (the gateway has no turn id), and ZeroClaw may still be running the old turn, so a new message would be steering. Real page in
// headless Chrome against a stub gateway (page-harness.mjs); the 60 s timer is a fake the test fires, the clock is fake too.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, frame, eventNames, eventsOf } from "./page-harness.mjs";

let h;
const r = {};

before(async () => {
  h = await startHarness();

  // A timeout with a message held and a sentence being read out: the socket is closed, speech cancelled, the held message dropped,
  // and the page connects again by itself with the same agent and token.
  let p = await h.openPage("tts_stream=1");
  await p.commitOnStop();
  await p.texts("first words", "second words", "third words", "fourth words");
  await p.utterance(); // sent: in flight
  r.timers = { whileInFlight: await p.page.evaluate(() => window.__longCount()) };
  await p.send({ type: "chunk", content: "A long enough sentence is here. " });
  await p.page.evaluate(() => window.__sp.utterances[0].onstart({}));
  await p.mic();
  await p.mic(); // held "second words"
  r.t = { before: await p.state(), conn: p.conn };
  await p.page.evaluate(() => window.__fireLong());
  await p.page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("reconnected"), null, { timeout: 8000 }).catch(() => {});
  r.t.after = await p.state();
  r.t.upgrades = h.upgrades;
  await p.page.waitForTimeout(300);
  r.t.oldClosedByClient = h.closeRequested.has(p.conn);
  r.t.newUrl = h.urls[p.conn + 1] ?? null;
  r.t.oldUrl = h.urls[p.conn];

  // Late traffic from the old socket must not touch the new connection: a new turn is in flight on it, and then the old socket
  // delivers a done, a chunk and its close.
  await p.utterance(); // "third words": sent on the new connection
  r.t.newMsgs = h.messages(p.conn + 1).map((m) => m.content);
  await p.send({ type: "chunk", content: "Another long sentence for the new turn. " }, p.conn + 1);
  await p.page.evaluate(() => window.__sp.utterances.at(-1).onstart({}));
  r.late = { before: await p.state() };
  h.sockets[p.conn].write(frame({ type: "done", full_response: "late", tokens_used: 1 }));
  h.sockets[p.conn].write(frame({ type: "chunk", content: "Late words from the old turn. " }));
  await p.page.waitForTimeout(200);
  h.sockets[p.conn].destroy(); // the old socket's close arrives now, after the new connection is up
  await p.page.waitForTimeout(400);
  // Chrome drops what an old socket would deliver after close(), so the handlers are also called by hand, as if it had: a frame, an
  // error, an open and a close, all from the first socket.
  await p.page.evaluate(() => {
    const old = window.__wsInstances.filter((s) => s.url.includes("/ws/chat"))[0];
    old.onmessage({ data: JSON.stringify({ type: "done", full_response: "late", tokens_used: 1 }) });
    old.onmessage({ data: JSON.stringify({ type: "aborted" }) });
    old.onerror(new Event("error"));
    old.onopen(new Event("open"));
    old.onclose({ code: 1006, reason: "late", wasClean: false });
  });
  await p.page.waitForTimeout(100);
  r.late.after = await p.state();
  await p.mic();
  await p.mic(); // "fourth words": the new turn is still in flight, so this is held and not sent
  r.late.held = await p.state();
  r.late.newMsgs = h.messages(p.conn + 1).length;
  await p.send({ type: "done", full_response: "x", tokens_used: 1 }, p.conn + 1);
  r.late.end = await p.state();
  r.late.endMsgs = h.messages(p.conn + 1).length;

  // A timeout with nothing held while a sentence is being read out: speech is cancelled, there is no held_dropped, and the hint is
  // the ordinary one after the reconnect. (A held message means the reply was muted by the tap, so with one nothing is speaking.)
  p = await h.openPage("tts_stream=1");
  await p.commitOnStop();
  await p.utterance();
  await p.send({ type: "chunk", content: "A long enough sentence is here. " });
  await p.page.evaluate(() => window.__sp.utterances[0].onstart({}));
  const beforePlain = await p.state();
  await p.page.evaluate(() => window.__fireLong());
  await p.page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("reconnected"), null, { timeout: 8000 }).catch(() => {});
  r.plain = await p.state();
  r.plain.before = beforePlain;

  // A reply that ends normally has no timer left, so nothing times out later.
  p = await h.openPage("tts_stream=0");
  await p.commitOnStop();
  await p.utterance();
  await p.send({ type: "done", full_response: "x", tokens_used: 1 });
  r.ended = { timers: await p.page.evaluate(() => window.__longCount()), fired: await p.page.evaluate(() => window.__fireLong()), state: await p.state(), upgrades: h.upgrades };

  // While the automatic reconnect is still connecting (the stub holds the upgrade back) there is no connection: the status says
  // connecting and the mic is disabled; when it opens, the status says why.
  p = await h.openPage("tts_stream=0");
  await p.commitOnStop();
  await p.utterance();
  h.upgradeDelay = 800;
  await p.page.evaluate(() => window.__fireLong());
  await p.page.waitForTimeout(250);
  r.connecting = await p.state();
  await p.page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("reconnected"), null, { timeout: 8000 }).catch(() => {});
  r.connecting.opened = await p.state();
  h.upgradeDelay = 0;

  // The reconnect cannot even start (the gateway URL was changed to something invalid): the page is left with no socket, and fixing
  // the URL and pressing Connect connects, as a plain connect.
  p = await h.openPage("tts_stream=0");
  await p.commitOnStop();
  await p.utterance();
  const goodUrl = await p.page.inputValue("#ws-url");
  await p.page.fill("#ws-url", "not a url");
  await p.page.evaluate(() => window.__fireLong());
  await p.page.waitForTimeout(200);
  r.badUrl = await p.state();
  await p.page.fill("#ws-url", goodUrl);
  await p.connect();
  r.badUrl.fixed = await p.state();

  // The reconnect fails: the existing disconnected state, one attempt only, and a later manual Connect is a plain connect.
  p = await h.openPage("tts_stream=0");
  await p.commitOnStop();
  await p.texts("first words", "second words");
  await p.utterance();
  await p.mic();
  await p.mic(); // held
  h.refuse = true;
  const before = h.upgrades;
  await p.page.evaluate(() => window.__fireLong());
  await p.page.waitForFunction(() => document.getElementById("conn-status").textContent.includes("disconnected"), null, { timeout: 8000 }).catch(() => {});
  await p.page.waitForTimeout(1500); // no second attempt in that time
  r.failed = { state: await p.state(), attempts: h.upgrades - before };
  h.refuse = false;
  await p.connect();
  r.failed.manual = await p.state();
});

after(async () => {
  await h?.close();
});

const dropped = (events) => eventsOf(events, "held_dropped").map(({ reason, chars }) => ({ reason, chars }));

test("the reply timer exists exactly while a reply is in flight", () => {
  assert.equal(r.timers.whileInFlight, 1);
  assert.equal(r.ended.timers, 0);
  assert.equal(r.ended.fired, 0);
});

test("a timeout keeps turn_timeout, closes the socket, cancels speech and drops the held message with reason timeout", () => {
  const { before, after } = r.t;
  assert.deepEqual(eventsOf(after.events, "turn_timeout").map((e) => e.ms), [60000]);
  assert.equal(r.t.oldClosedByClient, true);
  assert.deepEqual(dropped(after.events), [{ reason: "timeout", chars: "second words".length }]);
  assert.equal(before.hint, "Will send when the answer finishes");
  assert.deepEqual(eventNames(after.events, "held_sent", "send_held").filter((n) => n === "held_sent"), []);
});

test("it reconnects once by itself with the same agent and token, and says so in the status", () => {
  assert.equal(r.t.upgrades, 2); // the first connection and one more
  assert.equal(r.t.newUrl, r.t.oldUrl);
  assert.match(r.t.newUrl, /agent=stub/);
  assert.match(r.t.newUrl, /token=stub-token/);
  assert.equal(r.t.after.status, "Answer timed out, reconnected");
  assert.equal(r.t.after.micDisabled, false);
  assert.equal(r.t.after.hint, "Message not sent, the answer timed out"); // the dropped message is visible
});

test("while the automatic reconnect is connecting there is no connection: status connecting, mic disabled, then the status says why it opened", () => {
  assert.equal(r.connecting.status, "connecting…");
  assert.equal(r.connecting.micDisabled, true);
  assert.equal(r.connecting.opened.status, "Answer timed out, reconnected");
  assert.equal(r.connecting.opened.micDisabled, false);
});

test("a new message after the reconnect goes out on the new connection", () => {
  assert.equal(r.t.newMsgs.length, 1);
  assert.ok(r.t.newMsgs[0].endsWith("third words"));
});

test("late frames and the late close of the old socket do not touch the new connection: still connected, still in flight, speech not cancelled", () => {
  const { before, after, held } = r.late;
  assert.deepEqual(eventNames(after.events, "done_received").length, eventNames(before.events, "done_received").length);
  assert.deepEqual(eventNames(after.events, "ws_closed").length, eventNames(before.events, "ws_closed").length);
  assert.equal(after.status, "Answer timed out, reconnected"); // not "disconnected": the old close did not reach the new connection
  assert.equal(after.micDisabled, false);
  assert.equal(after.cancels, before.cancels);
  assert.equal(eventNames(after.events, "tts_cancelled").length, eventNames(before.events, "tts_cancelled").length);
  assert.equal(before.hint, "Tap to start listening"); // the dropped-message notice went away at the mic press
  assert.equal(r.late.newMsgs, 1); // still one message on the new connection: the new turn was not seen as ended
  assert.deepEqual(eventsOf(held.events, "send_held").map((e) => e.chars).slice(-1), ["fourth words".length]);
});

test("the new turn ends by its own done on the new connection and sends what was held", () => {
  assert.equal(r.late.endMsgs, 2);
  assert.deepEqual(eventsOf(r.late.end.events, "held_sent").map((e) => e.end).slice(-1), ["done"]);
});

test("a timeout cancels what is being read out, as tts_cancelled canceled", () => {
  assert.equal(r.plain.cancels, r.plain.before.cancels + 1);
  assert.deepEqual(eventsOf(r.plain.events, "tts_cancelled").map((e) => e.reason), ["canceled"]);
});

test("if the reconnect cannot start (invalid URL) there is no socket left to close: fixing the URL and pressing Connect connects", () => {
  assert.equal(r.badUrl.status, "invalid url");
  assert.equal(r.badUrl.micDisabled, true);
  assert.equal(r.badUrl.fixed.status, "connected");
});

test("a timeout with nothing held drops nothing and leaves the ordinary hint", () => {
  assert.deepEqual(dropped(r.plain.events), []);
  assert.equal(r.plain.status, "Answer timed out, reconnected");
  assert.equal(r.plain.hint, "Tap to start listening");
});

test("if the reconnect fails the state is the existing disconnected one, with a single attempt and no further retry", () => {
  assert.equal(r.failed.attempts, 1);
  assert.equal(r.failed.state.status, "disconnected");
  assert.equal(r.failed.state.micDisabled, true);
  assert.deepEqual(dropped(r.failed.state.events), [{ reason: "timeout", chars: "second words".length }]);
});

test("a manual Connect after a failed automatic reconnect is a plain connect: no timeout wording", () => {
  assert.equal(r.failed.manual.status, "connected");
});
