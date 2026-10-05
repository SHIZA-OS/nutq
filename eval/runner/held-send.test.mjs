// Hold and send: an utterance that finishes while a reply is in flight is held, not dropped, and goes out when the turn ends
// (done, aborted or a turn-failure error), never before: a message sent mid-turn is steering in ZeroClaw. Real page in headless
// Chrome against a stub gateway that records every message frame the page sends (page-harness.mjs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, eventNames, eventsOf } from "./page-harness.mjs";

let h;
const r = {};
const HOLD_HINT = "Will send when the answer finishes";

before(async () => {
  h = await startHarness();

  // Hold, then send at done. ?reply=voice so the reply style is visible in the frame.
  let p = await h.openPage("reply=voice");
  await p.commitOnStop();
  await p.texts("first words", "second words");
  await p.utterance(); // sent: a reply is in flight
  await p.send({ type: "chunk", content: "Part of the answer. " });
  await p.mic(); // the tap mutes the reply
  await p.mic(); // release: the stop commits "second words"
  r.hold = { held: await p.state(), sent: h.messages(p.conn).length };
  await p.advance(1234);
  await p.send({ type: "done", full_response: "Part of the answer. ", tokens_used: 1 });
  r.hold.after = await p.state();
  r.hold.msgs = h.messages(p.conn);
  await p.send({ type: "done", full_response: "Answer to the held one.", tokens_used: 1 });
  r.hold.second = await p.state();

  // Two utterances during one reply are one held message; waited_ms counts from the first.
  p = await h.openPage("");
  await p.commitOnStop();
  await p.texts("first words", "second part", "third part");
  await p.utterance();
  await p.mic();
  await p.mic();
  r.append = { one: await p.state() };
  await p.advance(500);
  await p.mic(); // an earlier release is far in the past here: this press is deliberate
  await p.mic();
  await p.advance(700);
  r.append.two = await p.state();
  r.append.sentBefore = h.messages(p.conn).length;
  await p.send({ type: "done", full_response: "x", tokens_used: 1 });
  r.append.after = await p.state();
  r.append.msgs = h.messages(p.conn);

  // Frames that do not end the turn send nothing; an aborted turn sends.
  p = await h.openPage("");
  await p.commitOnStop();
  await p.texts("first words", "second words");
  await p.utterance();
  await p.mic();
  await p.mic();
  for (const f of [
    { type: "chunk", content: "More. " },
    { type: "thinking", content: "..." },
    { type: "tool_call", id: "1", name: "x", args: {} },
    { type: "tool_result", id: "1", name: "x", output: "" },
    { type: "plan", entries: [] },
    { type: "error", code: "EMPTY_CONTENT", message: "x" },
    { type: "approval_request", request_id: "r1", tool: "x", arguments_summary: "", timeout_secs: 5 },
  ]) {
    await p.send(f);
  }
  r.notEnding = { state: await p.state(), msgs: h.messages(p.conn).length, approvals: h.received.filter((x) => x.conn === p.conn && x.msg.type === "approval_response").length };
  await p.send({ type: "aborted" });
  r.aborted = { state: await p.state(), msgs: h.messages(p.conn) };

  // A turn-failure error sends too.
  p = await h.openPage("");
  await p.commitOnStop();
  await p.texts("first words", "second words");
  await p.utterance();
  await p.mic();
  await p.mic();
  await p.send({ type: "error", code: "PROVIDER_ERROR", message: "x" });
  r.failed = { state: await p.state(), msgs: h.messages(p.conn) };

  // The socket closes with a message held: it is dropped, said so, and nothing goes out on the next connection.
  p = await h.openPage("");
  await p.commitOnStop();
  await p.texts("first words", "second words");
  await p.utterance();
  await p.mic();
  await p.mic();
  h.sockets[p.conn].destroy();
  await p.waitLog("WebSocket closed");
  await p.page.waitForTimeout(150);
  r.closed = { state: await p.state() };
  await p.connect();
  await p.send({ type: "done", full_response: "x", tokens_used: 1 });
  r.closed.reconnected = await p.state();
  await p.commitOnStop();
  await p.texts("fresh words");
  await p.utterance(); // a new turn on the new connection; its end must not release the dropped message
  await p.send({ type: "done", full_response: "x", tokens_used: 1 });
  r.closed.newConnMsgs = h.messages(p.conn + 1).map((m) => m.content);
  r.closed.end = await p.state();

  // An empty utterance during a reply is not held.
  p = await h.openPage("");
  await p.commitOnStop();
  await p.texts("first words");
  await p.utterance();
  await p.page.evaluate(() => (window.__commitOnStop = false));
  await p.mic();
  await p.mic();
  await p.send({ type: "done", full_response: "x", tokens_used: 1 });
  r.empty = { state: await p.state(), msgs: h.messages(p.conn).length };

  // The turn ends while the user has the mic open again: the held message goes out, the new answer is muted (nothing is read over
  // the live mic), the release 0 ms after that send is a release and not ignored, and what was said is held for that answer.
  p = await h.openPage("tts_stream=1");
  await p.commitOnStop();
  await p.texts("first words", "second words", "third words");
  await p.utterance();
  await p.mic();
  await p.mic(); // held "second words"
  await p.advance(5000);
  await p.mic(); // listening again
  await p.send({ type: "done", full_response: "x", tokens_used: 1 });
  r.live = { sent: await p.state() };
  await p.send({ type: "chunk", content: "A long enough sentence is here. " });
  r.live.chunk = await p.state();
  await p.mic(); // release, 0 ms after the held send on the fake clock
  r.live.release = await p.state();
  await p.send({ type: "done", full_response: "A long enough sentence is here. ", tokens_used: 1 });
  r.live.end = await p.state();
  r.live.msgs = h.messages(p.conn);

  // No turn is ever sent mid-turn, and a late hold does not reorder: the wire order is the order of the turns.
  r.all = [r.hold.after, r.append.after, r.aborted.state, r.failed.state, r.closed.reconnected, r.empty.state, r.live.end];
});

after(async () => {
  await h?.close();
});

const sendHeld = (events) => eventsOf(events, "send_held").map((e) => e.chars);
const heldSent = (events) => eventsOf(events, "held_sent").map(({ chars, waited_ms, end }) => ({ chars, waited_ms, end }));
const triggers = (events) => eventsOf(events, "ws_message_sent").map((e) => e.send_trigger);

test("an utterance finished during a reply is held, not sent and not dropped: send_held with its length, the hint, no send_blocked", () => {
  assert.deepEqual(sendHeld(r.hold.held.events), ["second words".length]);
  assert.equal(r.hold.sent, 1); // only the first message is on the wire
  assert.equal(r.hold.held.hint, HOLD_HINT);
  assert.deepEqual(eventNames(r.hold.held.events, "send_blocked"), []);
  for (const s of r.all) assert.deepEqual(eventNames(s.events, "send_blocked"), []);
});

test("at done the held message is sent through the normal path: same reply style, speech cancelled, send_trigger held, held_sent with the wait", () => {
  const { msgs, after } = r.hold;
  assert.equal(msgs.length, 2);
  const prefix = msgs[0].content.slice(0, -"first words".length);
  assert.notEqual(prefix, "");
  assert.equal(msgs[1].content, prefix + "second words");
  assert.deepEqual(heldSent(after.events), [{ chars: 12, waited_ms: 1234, end: "done" }]);
  assert.deepEqual(triggers(after.events), ["manual", "held"]);
  assert.equal(eventsOf(after.events, "ws_message_sent").at(-1).reply_style, "voice");
  assert.equal(after.cancels, r.hold.held.cancels + 1); // sendTranscript's cancelSpeech()
  assert.equal(after.hint, "Tap to start listening"); // the hold hint is gone
});

test("a held send with the mic closed does not mute the new answer: it is read out as any answer", () => {
  assert.deepEqual(r.hold.second.spoken, ["Answer to the held one."]);
  assert.equal(eventsOf(r.hold.second.events, "tts_muted").length, 1); // only the first answer's, from the tap
});

test("the held message is sent after the ending frame is handled, so done_received belongs to the turn it ended", () => {
  assert.deepEqual(eventNames(r.hold.after.events, "done_received", "held_sent", "ws_message_sent").slice(-3), ["done_received", "held_sent", "ws_message_sent"]);
});

test("a second utterance is appended with a space; there is one held message, one send, and the wait counts from the first hold", () => {
  assert.deepEqual(sendHeld(r.append.two.events), ["second part".length, "second part third part".length]);
  assert.equal(r.append.sentBefore, 1);
  assert.equal(r.append.msgs.length, 2);
  assert.ok(r.append.msgs[1].content.endsWith("second part third part"));
  assert.deepEqual(heldSent(r.append.after.events), [{ chars: 22, waited_ms: 1200, end: "done" }]);
});

test("frames that do not end the turn send nothing (chunk, thinking, tool frames, a non-turn error, an approval request)", () => {
  assert.equal(r.notEnding.msgs, 1);
  assert.equal(r.notEnding.state.hint, HOLD_HINT);
  assert.deepEqual(heldSent(r.notEnding.state.events), []);
  assert.equal(r.notEnding.approvals, 1); // the auto-deny is not a message
});

test("an aborted turn sends the held message (end aborted); a turn-failure error does too (end error)", () => {
  assert.equal(r.aborted.msgs.length, 2);
  assert.deepEqual(heldSent(r.aborted.state.events).map((e) => e.end), ["aborted"]);
  assert.equal(r.failed.msgs.length, 2);
  assert.deepEqual(heldSent(r.failed.state.events).map((e) => e.end), ["error"]);
  assert.deepEqual(triggers(r.failed.state.events), ["manual", "held"]);
});

test("a closed socket drops the held message: held_dropped reason closed with its length, a visible hint, and nothing sent later", () => {
  const dropped = eventsOf(r.closed.state.events, "held_dropped").map(({ reason, chars }) => ({ reason, chars }));
  assert.deepEqual(dropped, [{ reason: "closed", chars: 12 }]);
  assert.equal(r.closed.state.hint, "Message not sent, the connection closed");
  assert.equal(r.closed.reconnected.hint, "Tap to start listening");
  assert.equal(r.closed.newConnMsgs.length, 1); // only the fresh utterance: the dropped one does not come back at the next turn's end
  assert.ok(r.closed.newConnMsgs[0].endsWith("fresh words"));
  assert.deepEqual(heldSent(r.closed.end.events), []);
});

test("an empty utterance during a reply is not held (send_skipped as before)", () => {
  assert.deepEqual(eventNames(r.empty.state.events, "send_held", "held_sent"), []);
  assert.equal(eventsOf(r.empty.state.events, "send_skipped").length, 1);
  assert.equal(r.empty.msgs, 1);
});

test("the turn ends while listening: the held message is sent and the new answer is muted, nothing is read over the open mic", () => {
  assert.deepEqual(triggers(r.live.sent.events), ["manual", "held"]);
  assert.deepEqual(r.live.chunk.spoken, []);
  // The first answer's own done (muted by the earlier tap), then the new answer's chunk.
  assert.deepEqual(eventsOf(r.live.chunk.events, "tts_muted").map((e) => e.point), ["done", "chunk"]);
});

test("a release 0 ms after a held send is a release, not ignored, and the utterance is held for the new answer, then sent", () => {
  assert.deepEqual(eventNames(r.live.release.events, "mic_press_ignored"), []);
  assert.equal(eventsOf(r.live.release.events, "mic_button_release").length, 3);
  assert.deepEqual(sendHeld(r.live.release.events).slice(-1), ["third words".length]);
  assert.deepEqual(triggers(r.live.end.events), ["manual", "held", "held"]);
  assert.equal(r.live.msgs.length, 3);
  assert.ok(r.live.msgs[2].content.endsWith("third words"));
});
