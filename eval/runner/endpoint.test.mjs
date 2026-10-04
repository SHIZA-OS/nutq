// Tests the text-dependent end-of-turn rule in src/turn-policy.ts (endHint, waitFor, and TurnPolicy with a
// wait function), in a headless Chrome page served by Vite. The fixed-wait behavior stays pinned by
// turn-policy.test.mjs; this file only covers what the text adds.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-endpoint-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { TurnPolicy, endHint, waitFor, waitFromParams, SEMANTIC_WAITS } = await import("/src/turn-policy.ts");
    const out = {};
    const hints = [
      "Thank you.", "What time is it?", "Stop!", "Bring the blue folder to the office", "Stop", "", "   ",
      // an open-list word wins over terminal punctuation
      "I want to book a flight and.", "Is it in the?", "I think so.", "Seven people are coming to dinner tonight. For",
      "UM", "Um,", "and",
      // digits are words, not open
      "Add 25 and 17.", "Add 25 and", "Call me back in 15 minutes", "At 25 and 17",
      // trailing ... , ; : - stay open
      "wait...", "wait…", "well,", "go;", "go:", "well -", "Yes. ...",
      // trailing space is ignored
      "Thank you. ", "and ",
    ];
    out.hints = Object.fromEntries(hints.map((t) => [t, endHint(t)]));
    const W = { done: 300, unknown: 1500, open: 3500, floor: 200, ceiling: 3000 };
    out.waits = {
      done: waitFor("Thank you.", W, 0),
      unknown: waitFor("Stop", W, 0),
      noText: waitFor(null, W, 0),
      emptyText: waitFor("", W, 0),
      openClamped: waitFor("and", W, 0), // 3500 clamped to the ceiling 3000
      doneInFlight: waitFor("Thank you.", W, 1), // a commit is in flight: at least the unknown wait
      openInFlight: waitFor("and", W, 2),
      floored: waitFor("Thank you.", { ...W, done: 50 }, 0),
    };
    out.semanticWaits = SEMANTIC_WAITS;

    // a wait function: the wait comes from the text at the moment the deadline is asked for
    const mk = () => new TurnPolicy((text, n) => waitFor(text, W, n));
    let p = mk();
    p.speechEnd(1000); // no text yet: the unknown wait
    out.noText = p.endsAt();
    p.transcript("Thank you.", 1100); // text arrives after arming: the deadline moves
    out.doneLater = { endsAt: p.endsAt(), before: p.tick(1000 + 299), at: p.tick(1000 + 300) };

    p = mk();
    p.transcript("I want a flight and", 900); // text before the speech end
    p.speechEnd(1000);
    out.openBefore = p.endsAt();
    p.transcript("I want a flight and a hotel.", 1100);
    out.openThenDone = p.endsAt();

    // a speech start clears it; text that arrives later must not arm it
    p = mk();
    p.speechEnd(1000);
    p.speechStart(1200);
    p.transcript("Thank you.", 1300);
    out.clearedThenText = { endsAt: p.endsAt(), tick: p.tick(1e9) };
    p.speechEnd(2000);
    out.rearmed = p.endsAt();

    // text that makes the deadline already past ends the turn when it arrives, not retroactively
    p = mk();
    p.speechEnd(1000); // unknown: deadline 2500
    out.stillWaiting = p.tick(2000);
    p.transcript("Thank you.", 2100); // done: deadline would be 1300, but nobody knew until 2100
    out.lateText = { endsAt: p.endsAt(), tick: p.tick(2100) };

    // commits in flight hold the short wait back to the unknown wait
    p = mk();
    p.speechEnd(1000);
    p.transcript("Thank you.", 1000);
    p.setCommitsInFlight(1, 1000);
    out.inFlight = p.endsAt();
    p.setCommitsInFlight(0, 1200);
    out.landed = p.endsAt();
    out.currentWait = p.wait();

    // a misfire arms like a speech end, a manual stop ends now, an ended turn stays ended
    p = mk();
    p.transcript("Stop", 100);
    p.misfire(1000);
    out.misfire = p.endsAt();
    out.manual = p.manualStop(1100);
    p.transcript("and", 1200);
    out.afterEnd = { endsAt: p.endsAt(), tick: p.tick(1e9) };

    // a fixed number ignores the text entirely
    p = new TurnPolicy(2000);
    p.transcript("and", 0);
    p.speechEnd(100);
    out.fixed = { endsAt: p.endsAt(), wait: p.wait() };

    // tier 2 of the open list, a sweep arm that is off by default: auxiliary verbs, subject-only pronouns, "<modal> you"
    const t2 = ["What is", "Can you", "So do I", "Thank you.", "Please send it.", "I think she", "What time is it?", "Bring the folder", "he"];
    out.tier2 = { off: Object.fromEntries(t2.map((t) => [t, endHint(t)])), on: Object.fromEntries(t2.map((t) => [t, endHint(t, true)])) };
    out.tier2Wait = [waitFor("What is", { ...W, tier2: true }, 0), waitFor("What is", W, 0)];

    // ?silence and ?endpoint: silence is a fixed wait and wins; endpoint=semantic is opt-in; absent is the 5000 default
    const sem = waitFromParams(null, "semantic");
    out.params = {
      none: waitFromParams(null, null),
      silence: waitFromParams("1200", null),
      silenceWins: waitFromParams("1200", "semantic"),
      silenceClamped: waitFromParams("100", "semantic"),
      emptySilence: typeof waitFromParams("", "semantic"),
      otherEndpoint: [waitFromParams(null, ""), waitFromParams(null, "fixed"), waitFromParams(null, "Semantic")],
      semanticType: typeof sem,
      semanticDone: sem("Thank you.", 0),
      semanticOpen: sem("and", 0),
      semanticInFlight: sem("Thank you.", 1),
      expected: [waitFor("Thank you.", SEMANTIC_WAITS, 0), waitFor("and", SEMANTIC_WAITS, 0), waitFor("Thank you.", SEMANTIC_WAITS, 1)],
    };
    return out;
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("terminal punctuation alone reads as done; no punctuation and no open word reads as unknown", () => {
  for (const t of ["Thank you.", "What time is it?", "Stop!", "Thank you. "]) assert.equal(r.hints[t], "done", t);
  for (const t of ["Bring the blue folder to the office", "Stop", "", "   "]) assert.equal(r.hints[t], "unknown", JSON.stringify(t));
});

test("an open-list word wins over terminal punctuation: and. the? so. are open", () => {
  for (const t of ["I want to book a flight and.", "Is it in the?", "I think so.", "Seven people are coming to dinner tonight. For", "UM", "and", "and "]) {
    assert.equal(r.hints[t], "open", t);
  }
});

test("digits are words: a digit ending is not open, even after an open word", () => {
  assert.equal(r.hints["Add 25 and 17."], "done");
  assert.equal(r.hints["At 25 and 17"], "unknown");
  assert.equal(r.hints["Call me back in 15 minutes"], "unknown");
  assert.equal(r.hints["Add 25 and"], "open");
});

test("a trailing ellipsis, comma, semicolon, colon or hyphen is open, even after a closed word", () => {
  for (const t of ["Um,", "wait...", "wait…", "well,", "go;", "go:", "well -", "Yes. ..."]) assert.equal(r.hints[t], "open", t);
});

test("waitFor: one wait per hint, no text counts as unknown, clamped to the floor and ceiling", () => {
  assert.deepEqual(r.waits, { done: 300, unknown: 1500, noText: 1500, emptyText: 1500, openClamped: 3000, doneInFlight: 1500, openInFlight: 3000, floored: 200 });
});

test("the placeholder waits are ordered and inside the clamp, and the ceiling is the existing 8000", () => {
  const w = r.semanticWaits;
  assert.ok(w.floor <= w.done && w.done <= w.unknown && w.unknown <= w.open && w.open <= w.ceiling);
  assert.equal(w.ceiling, 8000);
});

test("with no text the deadline uses the unknown wait, and text that arrives after arming moves it", () => {
  assert.equal(r.noText, 2500);
  assert.deepEqual(r.doneLater, { endsAt: 1300, before: null, at: { at: 1300, reason: "auto_silence" } });
});

test("text before the speech end counts, and a later piece recomputes the deadline", () => {
  assert.equal(r.openBefore, 1000 + 3000);
  assert.equal(r.openThenDone, 1000 + 300);
});

test("a speech start clears the deadline for good: text arriving later does not arm it, the next speech end does", () => {
  assert.deepEqual(r.clearedThenText, { endsAt: null, tick: null });
  assert.equal(r.rearmed, 2000 + 300);
});

test("text that moves the deadline into the past ends the turn when the text arrived, not retroactively", () => {
  assert.equal(r.stillWaiting, null);
  assert.deepEqual(r.lateText, { endsAt: 2100, tick: { at: 2100, reason: "auto_silence" } });
});

test("a commit in flight holds a short wait back to the unknown wait until it lands", () => {
  assert.equal(r.inFlight, 1000 + 1500);
  assert.equal(r.landed, 1000 + 300);
  assert.equal(r.currentWait, 300);
});

test("a misfire arms, a manual stop ends now, and text after the end changes nothing", () => {
  assert.equal(r.misfire, 1000 + 1500);
  assert.deepEqual(r.manual, { at: 1100, reason: "manual" });
  assert.deepEqual(r.afterEnd, { endsAt: null, tick: { at: 1100, reason: "manual" } });
});

test("a fixed number ignores the text entirely", () => assert.deepEqual(r.fixed, { endsAt: 2100, wait: 2000 }));

test("without ?endpoint=semantic the wait is the fixed one: 5000 by default, ?silence=<ms> clamped, other endpoint values ignored", () => {
  assert.equal(r.params.none, 5000);
  assert.equal(r.params.silence, 1200);
  assert.deepEqual(r.params.otherEndpoint, [5000, 5000, 5000]);
});

test("?silence is an override: with it, ?endpoint=semantic is ignored and the wait is fixed (and clamped)", () => {
  assert.equal(r.params.silenceWins, 1200);
  assert.equal(r.params.silenceClamped, 800);
});

test("?endpoint=semantic alone, or with an empty ?silence=, gives the text-dependent wait with the SEMANTIC_WAITS values", () => {
  assert.equal(r.params.semanticType, "function");
  assert.equal(r.params.emptySilence, "function");
  assert.deepEqual([r.params.semanticDone, r.params.semanticOpen, r.params.semanticInFlight], r.params.expected);
});

test("tier 2 is off by default: auxiliary verbs and pronouns at the end are not open", () => {
  assert.deepEqual(Object.values(r.tier2.off), ["unknown", "unknown", "unknown", "done", "done", "unknown", "done", "unknown", "unknown"]);
});

test("tier 2 on: an auxiliary verb, I/we/they/he/she or a modal before you at the end is open; thank you and send it are not", () => {
  assert.deepEqual(r.tier2.on, {
    "What is": "open", "Can you": "open", "So do I": "open", "Thank you.": "done", "Please send it.": "done",
    "I think she": "open", "What time is it?": "done", "Bring the folder": "unknown", he: "open",
  });
});

test("waitFor takes tier 2 from the waits object, off when it is absent", () => assert.deepEqual(r.tier2Wait, [3000, 1500]));
