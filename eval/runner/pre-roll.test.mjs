// Tests the real src/vendor/pre-roll.ts, compiled and driven in Node
// (no copy of the logic here). Runs with the rest of the suite via
// `npm test`.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./load-ts.mjs";

let r; // scenario results, each a list of the frame ids that take() returned

before(async () => {
  r = structuredClone(await (async () => {
    const { PreRoll } = await loadTs("vendor/pre-roll");
    const frame = (i) => new Float32Array([i]); // one sample whose value is the frame id
    const ids = (frames) => frames.map((f) => f[0]);
    const fill = (p, from, to) => { for (let i = from; i <= to; i++) p.push(frame(i)); };
    const out = {};

    let p = new PreRoll(4);
    fill(p, 0, 9);
    out.lastN = ids(p.take(false));
    out.takeClears = ids(p.take(false));

    p = new PreRoll(4);
    fill(p, 0, 1);
    out.fewerThanN = ids(p.take(false));

    p = new PreRoll(0);
    fill(p, 0, 5);
    out.sizeZero = ids(p.take(false));

    // speech started while the speech buffer already holds frames (e.g. after a misfire)
    p = new PreRoll(4);
    fill(p, 0, 5);
    out.bufferHasFrames = ids(p.take(true));
    out.afterBufferHasFrames = ids(p.take(false));

    p = new PreRoll(4);
    fill(p, 0, 3);
    p.clear();
    out.cleared = ids(p.take(false));

    // speech restarts shortly after a pause: frames 6..9 were prepended and committed with
    // the first utterance; only frames pushed since may come back, never the old ones
    p = new PreRoll(4);
    fill(p, 0, 9);
    out.firstStart = ids(p.take(false));
    fill(p, 20, 21);
    out.secondStart = ids(p.take(false));
    return out;
  })());
});

test("keeps only the most recent N frames, oldest first", () => assert.deepEqual(r.lastN, [6, 7, 8, 9]));
test("take() empties the ring", () => assert.deepEqual(r.takeClears, []));
test("fewer frames than N returns what there is", () => assert.deepEqual(r.fewerThanN, [0, 1]));
test("size 0 disables pre-roll", () => assert.deepEqual(r.sizeZero, []));
test("returns nothing when the speech buffer already has frames, and still empties the ring", () => {
  assert.deepEqual(r.bufferHasFrames, []);
  assert.deepEqual(r.afterBufferHasFrames, []);
});
test("clear() drops buffered frames", () => assert.deepEqual(r.cleared, []));
test("a restart after a pause prepends only frames pushed since the last start", () => {
  assert.deepEqual(r.firstStart, [6, 7, 8, 9]);
  assert.deepEqual(r.secondStart, [20, 21]);
});
