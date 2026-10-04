// Tests src/turn-state.ts, the reply-in-flight state, in a headless Chrome page served by Vite (the real module,
// no copy of the logic here). Runs with the rest of the suite via `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

const CLEARING = [
  { type: "done" },
  { type: "aborted" },
  { type: "error", code: "PROVIDER_ERROR" },
  { type: "error", code: "AUTH_ERROR" },
  { type: "error", code: "AGENT_ERROR" },
];
const NOT_CLEARING = [
  { type: "error", code: "EMPTY_CONTENT" },
  { type: "error", code: "INVALID_JSON" },
  { type: "error", code: "STEERING_QUEUE_FULL" },
  { type: "error", code: "STEERING_CLOSED" },
  { type: "error", code: "SOP_RESOLVE_FAILED" },
  { type: "error", code: "SOP_LOCK_POISONED" },
  { type: "error", code: "SESSION_QUEUE_TIMEOUT" },
  { type: "error", code: "INVALID_APPROVAL_RESPONSE" },
  { type: "error", code: "UNKNOWN_MESSAGE_TYPE" },
  { type: "error", code: "NEEDS_ONBOARDING" },
  { type: "error" }, // no code at all
  { type: "error", code: 42 }, // not a string
  { type: "chunk", content: "hi" },
  { type: "thinking", content: "..." },
  { type: "tool_call", id: "1", name: "x", args: {} },
  { type: "tool_result", id: "1", name: "x", output: "" },
  { type: "approval_request", request_id: "r" },
  { type: "plan", entries: [] },
  { type: "history_trimmed" },
  { type: "session_start", session_id: "s" },
  { type: "connected" },
  { type: "sop_approval_result", run_id: "x", outcome: "approved" },
  { type: "cron_result" },
  {}, // no type
];

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-turnstate-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(
    async ({ clearing, notClearing }) => {
      const { ReplyState, REPLY_TIMEOUT_MS } = await import("/src/turn-state.ts");
      const out = {};
      let s = new ReplyState();
      out.fresh = s.inFlight;
      out.firstSend = s.trySend(0);
      out.afterSend = s.inFlight;
      out.secondSend = s.trySend(5); // blocked, nothing changes
      out.afterBlocked = s.inFlight;
      out.clearing = clearing.map((f) => {
        const st = new ReplyState();
        st.trySend(0);
        const returned = st.frame(f);
        const deadlineAfterClear = st.timesOutAt();
        const canSendAgain = st.trySend(1);
        return { f, returned, inFlightAfter: canSendAgain ? "cleared" : "still", deadlineAfterClear };
      });
      out.notClearing = notClearing.map((f) => {
        const st = new ReplyState();
        st.trySend(0);
        const returned = st.frame(f);
        return { f, returned, inFlight: st.inFlight, blocksSend: !st.trySend(1), deadline: st.timesOutAt() };
      });
      s = new ReplyState();
      s.trySend(0);
      s.closed();
      out.afterClose = { inFlight: s.inFlight, canSend: s.trySend(1), }; 
      s = new ReplyState();
      out.doneWhileIdle = { returned: s.frame({ type: "done" }), inFlight: s.inFlight };
      out.closeWhileIdle = (() => { const x = new ReplyState(); x.closed(); return x.inFlight; })();
      // a refused second message (EMPTY_CONTENT) then the real end of the turn
      s = new ReplyState();
      s.trySend(0);
      s.frame({ type: "error", code: "EMPTY_CONTENT" });
      const stillBlocked = !s.trySend(1);
      s.frame({ type: "chunk", content: "a" });
      s.frame({ type: "done" });
      out.sequence = { stillBlocked, afterDone: s.inFlight, canSendAfter: s.trySend(2) };
      // the safety timeout, with a fake clock
      out.REPLY_TIMEOUT_MS = REPLY_TIMEOUT_MS;
      s = new ReplyState();
      out.idleTimer = { timesOutAt: s.timesOutAt(), tick: s.tick(1e12) };
      s.trySend(1000);
      out.timeout = {
        timesOutAt: s.timesOutAt(),
        justBefore: s.tick(1000 + REPLY_TIMEOUT_MS - 1),
        stillInFlight: s.inFlight,
        atDeadline: s.tick(1000 + REPLY_TIMEOUT_MS),
        afterTimeout: { inFlight: s.inFlight, timesOutAt: s.timesOutAt(), tickAgain: s.tick(1e12), canSend: s.trySend(70000), newDeadline: s.timesOutAt() },
      };
      s = new ReplyState();
      s.trySend(0);
      s.frame({ type: "chunk", content: "x" });
      s.frame({ type: "error", code: "STEERING_CLOSED" });
      out.deadlineNotMoved = s.timesOutAt(); // activity and refused messages do not extend it
      s = new ReplyState();
      s.trySend(0);
      s.frame({ type: "done" });
      out.tickAfterDone = { tick: s.tick(1e12), timesOutAt: s.timesOutAt() }; // a normal clear cancels the timeout
      s = new ReplyState();
      s.trySend(0);
      s.closed();
      out.tickAfterClose = { tick: s.tick(1e12), timesOutAt: s.timesOutAt() };
      s = new ReplyState(500);
      s.trySend(100);
      out.custom = { timesOutAt: s.timesOutAt(), at: s.tick(600) };

      // The mute: set only while a reply is in flight, ended by every point that ends the flag.
      s = new ReplyState();
      out.muteIdle = { returned: s.mute(), muted: s.muted, firstChunk: s.firstMutedChunk() };
      s.trySend(0);
      out.muteFlight = { before: s.muted, returned: s.mute(), muted: s.muted, again: s.mute() };
      out.muteEndedBy = clearing.map((f) => {
        const st = new ReplyState();
        st.trySend(0);
        st.mute();
        st.frame(f);
        return { f, muted: st.muted };
      });
      out.muteKeptBy = notClearing.map((f) => {
        const st = new ReplyState();
        st.trySend(0);
        st.mute();
        st.frame(f);
        return { f, muted: st.muted };
      });
      s = new ReplyState();
      s.trySend(0);
      s.mute();
      s.closed();
      out.muteClosed = s.muted;
      s = new ReplyState();
      s.trySend(1000);
      s.mute();
      const justBefore = (s.tick(1000 + REPLY_TIMEOUT_MS - 1), s.muted);
      s.tick(1000 + REPLY_TIMEOUT_MS);
      out.muteTimeout = { justBefore, afterTimeout: s.muted };
      // The next turn starts unmuted, with a fresh once-per-turn chunk report.
      s = new ReplyState();
      s.trySend(0);
      s.mute();
      const first = [s.firstMutedChunk(), s.firstMutedChunk(), s.firstMutedChunk()];
      s.frame({ type: "done" });
      s.trySend(1);
      const nextTurn = { muted: s.muted, firstChunk: s.firstMutedChunk() };
      s.mute();
      out.muteChunk = { first, nextTurn, nextTurnMuted: s.firstMutedChunk() };
      return out;
    },
    { clearing: CLEARING, notClearing: NOT_CLEARING },
  );
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("a fresh state has no reply in flight; the first trySend marks one and a second is refused without changing anything", () => {
  assert.equal(r.fresh, false);
  assert.equal(r.firstSend, true);
  assert.equal(r.afterSend, true);
  assert.equal(r.secondSend, false);
  assert.equal(r.afterBlocked, true);
});

test("done, aborted, and an error with PROVIDER_ERROR, AUTH_ERROR or AGENT_ERROR each clear the flag", () => {
  assert.equal(r.clearing.length, CLEARING.length);
  for (const c of r.clearing) {
    assert.equal(c.returned, true, JSON.stringify(c.f));
    assert.equal(c.inFlightAfter, "cleared", JSON.stringify(c.f));
  }
});

test("EMPTY_CONTENT, INVALID_JSON, STEERING_*, SOP_* and every other non-ending frame leave the flag set", () => {
  assert.equal(r.notClearing.length, NOT_CLEARING.length);
  for (const c of r.notClearing) {
    assert.equal(c.returned, false, JSON.stringify(c.f));
    assert.equal(c.inFlight, true, JSON.stringify(c.f));
    assert.equal(c.blocksSend, true, JSON.stringify(c.f));
  }
});

test("a closed socket clears the flag", () => assert.deepEqual(r.afterClose, { inFlight: false, canSend: true }));

test("a done or a close while nothing is in flight changes nothing", () => {
  assert.deepEqual(r.doneWhileIdle, { returned: false, inFlight: false });
  assert.equal(r.closeWhileIdle, false);
});

test("a refused mid-turn message does not end the turn; the real end does", () => {
  assert.deepEqual(r.sequence, { stillBlocked: true, afterDone: false, canSendAfter: true });
});

test("a normal clear leaves no deadline, so the caller's timer is cancelled with it", () => {
  for (const c of r.clearing) assert.equal(c.deadlineAfterClear, null, JSON.stringify(c.f));
  assert.deepEqual(r.afterClose, { inFlight: false, canSend: true });
  assert.deepEqual(r.tickAfterDone, { tick: false, timesOutAt: null });
  assert.deepEqual(r.tickAfterClose, { tick: false, timesOutAt: null });
});

test("frames that do not end the turn keep the deadline", () => {
  for (const c of r.notClearing) assert.equal(c.deadline, 60000, JSON.stringify(c.f));
  assert.equal(r.deadlineNotMoved, 60000); // sent at 0, a chunk and a refused message did not move it
});

test("the safety timeout is 60000 ms from the send, clears the flag once, and a new send gets a new deadline", () => {
  assert.equal(r.REPLY_TIMEOUT_MS, 60000);
  assert.deepEqual(r.idleTimer, { timesOutAt: null, tick: false });
  assert.equal(r.timeout.timesOutAt, 61000);
  assert.equal(r.timeout.justBefore, false);
  assert.equal(r.timeout.stillInFlight, true);
  assert.equal(r.timeout.atDeadline, true);
  assert.deepEqual(r.timeout.afterTimeout, { inFlight: false, timesOutAt: null, tickAgain: false, canSend: true, newDeadline: 130000 });
});

test("the timeout can be set", () => assert.deepEqual(r.custom, { timesOutAt: 600, at: true }));

test("mute() with no reply in flight does nothing; with one in flight it mutes, and muting again is harmless", () => {
  assert.deepEqual(r.muteIdle, { returned: false, muted: false, firstChunk: false });
  assert.deepEqual(r.muteFlight, { before: false, returned: true, muted: true, again: true });
});

test("the mute ends with done, aborted, each turn-failure error, a closed socket and the timeout", () => {
  assert.equal(r.muteEndedBy.length, CLEARING.length);
  for (const c of r.muteEndedBy) assert.equal(c.muted, false, JSON.stringify(c.f));
  assert.equal(r.muteClosed, false);
  assert.deepEqual(r.muteTimeout, { justBefore: true, afterTimeout: false });
});

test("frames that do not end the turn leave the mute set", () => {
  assert.equal(r.muteKeptBy.length, NOT_CLEARING.length);
  for (const c of r.muteKeptBy) assert.equal(c.muted, true, JSON.stringify(c.f));
});

test("firstMutedChunk is true once per muted turn and not at all when not muted; the next turn starts unmuted and fresh", () => {
  assert.deepEqual(r.muteChunk, { first: [true, false, false], nextTurn: { muted: false, firstChunk: false }, nextTurnMuted: true });
});
