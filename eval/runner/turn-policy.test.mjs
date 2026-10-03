// Tests src/turn-policy.ts, the end-of-turn policy, in a headless Chrome page served by Vite (the real
// module, no copy of the logic here). Runs with the rest of the suite via `node --test eval/runner/`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-turnpolicy-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { TurnPolicy, SILENCE_COMMIT_MS } = await import("/src/turn-policy.ts");
    const out = { SILENCE_COMMIT_MS };

    let p = new TurnPolicy();
    out.fresh = { endsAt: p.endsAt(), tick: p.tick(1e9) };

    p = new TurnPolicy();
    p.speechEnd(1000);
    out.armed = { endsAt: p.endsAt(), before: p.tick(5999), at: p.tick(6000) };

    p = new TurnPolicy();
    p.speechEnd(1000);
    out.lateTick = p.tick(9000); // checked long after the deadline: still ends at the deadline

    p = new TurnPolicy();
    p.speechEnd(1000);
    p.speechStart(3000);
    out.cleared = { endsAt: p.endsAt(), tick: p.tick(7000) };
    p.speechEnd(4000);
    out.rearmedAfterStart = p.endsAt();

    p = new TurnPolicy();
    p.speechEnd(1000);
    p.speechEnd(2000);
    out.secondEndRearms = { endsAt: p.endsAt(), tick: p.tick(6999) };

    // a misfire arms auto-silence like a speech end, and re-arms it from the later time
    p = new TurnPolicy();
    p.misfire(2000);
    out.misfireArms = { endsAt: p.endsAt(), before: p.tick(6999), at: p.tick(7000) };
    p = new TurnPolicy();
    p.speechEnd(1000);
    p.misfire(2000);
    out.misfireAfterEnd = { endsAt: p.endsAt() };
    // a later speech start clears a misfire's deadline, and a later misfire arms it again
    p = new TurnPolicy();
    p.misfire(2000);
    p.speechStart(3000);
    out.misfireThenStart = { endsAt: p.endsAt(), tick: p.tick(1e9) };
    p.misfire(4000);
    out.misfireThenStartThenMisfire = p.endsAt();
    // a misfire after the turn ended does nothing
    p = new TurnPolicy();
    p.manualStop(1500);
    p.misfire(2000);
    out.misfireAfterEnd2 = { endsAt: p.endsAt(), tick: p.tick(1e9) };

    p = new TurnPolicy();
    p.speechEnd(1000);
    out.manual = { stop: p.manualStop(2500), endsAt: p.endsAt(), tickLater: p.tick(9000) };
    out.manualAgain = p.manualStop(3000);
    p.speechEnd(4000);
    p.speechStart(4500);
    out.afterEnd = { endsAt: p.endsAt(), tick: p.tick(1e9) };

    p = new TurnPolicy();
    p.speechEnd(1000);
    p.tick(6000);
    out.manualAfterAuto = p.manualStop(7000);

    p = new TurnPolicy(2000);
    p.speechEnd(100);
    out.custom = { endsAt: p.endsAt(), tick: p.tick(2100) };
    return out;
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("the auto-silence time is 5000 ms", () => assert.equal(r.SILENCE_COMMIT_MS, 5000));

test("a turn with no speech end has no end", () => assert.deepEqual(r.fresh, { endsAt: null, tick: null }));

test("a speech end arms auto-silence 5000 ms later, and it ends the turn exactly then", () => {
  assert.equal(r.armed.endsAt, 6000);
  assert.equal(r.armed.before, null);
  assert.deepEqual(r.armed.at, { at: 6000, reason: "auto_silence" });
  assert.deepEqual(r.lateTick, { at: 6000, reason: "auto_silence" });
});

test("a speech start clears it, and a later speech end arms it again", () => {
  assert.deepEqual(r.cleared, { endsAt: null, tick: null });
  assert.equal(r.rearmedAfterStart, 9000);
});

test("a second speech end re-arms from the later one", () => assert.deepEqual(r.secondEndRearms, { endsAt: 7000, tick: null }));

test("a misfire arms auto-silence like a speech end, and a later speech start still clears it", () => {
  assert.deepEqual(r.misfireArms, { endsAt: 7000, before: null, at: { at: 7000, reason: "auto_silence" } });
  assert.deepEqual(r.misfireAfterEnd, { endsAt: 7000 }); // re-armed from the later event
  assert.deepEqual(r.misfireThenStart, { endsAt: null, tick: null });
  assert.equal(r.misfireThenStartThenMisfire, 9000);
  assert.deepEqual(r.misfireAfterEnd2, { endsAt: null, tick: { at: 1500, reason: "manual" } });
});

test("a manual stop ends the turn now with reason manual and cancels auto-silence", () => {
  assert.deepEqual(r.manual.stop, { at: 2500, reason: "manual" });
  assert.equal(r.manual.endsAt, null);
  assert.deepEqual(r.manual.tickLater, { at: 2500, reason: "manual" });
});

test("once a turn has ended it stays ended: a second stop returns the first end, later events do nothing", () => {
  assert.deepEqual(r.manualAgain, { at: 2500, reason: "manual" });
  assert.deepEqual(r.afterEnd, { endsAt: null, tick: { at: 2500, reason: "manual" } });
  assert.deepEqual(r.manualAfterAuto, { at: 6000, reason: "auto_silence" });
});

test("the silence time can be set", () => assert.deepEqual(r.custom, { endsAt: 2100, tick: { at: 2100, reason: "auto_silence" } }));
