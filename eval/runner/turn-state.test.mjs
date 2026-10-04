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
      const { ReplyState } = await import("/src/turn-state.ts");
      const out = {};
      let s = new ReplyState();
      out.fresh = s.inFlight;
      out.firstSend = s.trySend();
      out.afterSend = s.inFlight;
      out.secondSend = s.trySend(); // blocked, nothing changes
      out.afterBlocked = s.inFlight;
      out.clearing = clearing.map((f) => {
        const st = new ReplyState();
        st.trySend();
        const returned = st.frame(f);
        const canSendAgain = st.trySend();
        return { f, returned, inFlightAfter: canSendAgain ? "cleared" : "still", };
      });
      out.notClearing = notClearing.map((f) => {
        const st = new ReplyState();
        st.trySend();
        const returned = st.frame(f);
        return { f, returned, inFlight: st.inFlight, blocksSend: !st.trySend() };
      });
      s = new ReplyState();
      s.trySend();
      s.closed();
      out.afterClose = { inFlight: s.inFlight, canSend: s.trySend() };
      s = new ReplyState();
      out.doneWhileIdle = { returned: s.frame({ type: "done" }), inFlight: s.inFlight };
      out.closeWhileIdle = (() => { const x = new ReplyState(); x.closed(); return x.inFlight; })();
      // a refused second message (EMPTY_CONTENT) then the real end of the turn
      s = new ReplyState();
      s.trySend();
      s.frame({ type: "error", code: "EMPTY_CONTENT" });
      const stillBlocked = !s.trySend();
      s.frame({ type: "chunk", content: "a" });
      s.frame({ type: "done" });
      out.sequence = { stillBlocked, afterDone: s.inFlight, canSendAfter: s.trySend() };
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
