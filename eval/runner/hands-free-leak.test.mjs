// Hands-free leak check and reopen delay: ten turns in a row in each theme. After every turn, while the mic is closed (waiting for the
// answer, then speaking it), no track from getUserMedia may be live and the open AudioContexts must not grow; while listening there is
// one live track. The Transcriber is the real one (its stop() releases the stream and the source node, and its one AudioContext is
// reused), with a stand-in model and VAD and a stand-in microphone (hands-free-harness.mjs). The page's clock is the real one here, so
// listen_reopen's delay_ms (from the turn being fully over to the mic being live) is a real number. HEADLESS, FAKE-DEVICE TIMINGS:
// they say nothing about a real microphone, a real room or a real voice. The table is printed as "LEAK" and "DELAY" lines.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, eventsOf } from "./page-harness.mjs";
import { answer, finishSpeech, mic, openHandsFree, say, waitHint, waitMessages } from "./hands-free-harness.mjs";

const TURNS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

for (const theme of ["zeroclaw", "shiza"]) {
  test(`${TURNS} hands-free turns in the ${theme} theme: no live track between turns, contexts flat`, async () => {
    const p = await openHandsFree(h, "listen=hands-free&silence=800", { theme, real: true });
    assert.equal(await p.page.evaluate(() => document.documentElement.dataset.theme), theme);
    await p.mic();
    await waitHint(p, "Listening");
    const rows = [];
    for (let i = 1; i <= TURNS; i++) {
      await say(p, `question ${i}`);
      await waitMessages(h, p, i);
      await waitHint(p, "Waiting for the answer");
      await sleep(150); // the level meter closes its own context asynchronously
      const waiting = await mic(p);
      await p.send({ type: "chunk", content: "Here is the answer." });
      await p.send({ type: "done", full_response: "Here is the answer.", tokens_used: 1 });
      await waitHint(p, "Speaking the answer");
      const speaking = await mic(p);
      await finishSpeech(p);
      await waitHint(p, "Listening");
      await sleep(150);
      const listening = await mic(p);
      rows.push({ turn: i, tracks: listening.tracks, waiting: [waiting.live, waiting.contexts], speaking: [speaking.live, speaking.contexts], listening: [listening.live, listening.contexts] });
    }
    const delays = eventsOf((await p.state()).events, "listen_reopen").map((e) => e.delay_ms);
    console.log(`LEAK ${theme}: turn | tracks handed out | waiting (live tracks, open contexts) | speaking | listening`);
    for (const r of rows) console.log(`LEAK ${theme}: ${String(r.turn).padStart(2)} | ${String(r.tracks).padStart(2)} | ${r.waiting.join(", ")} | ${r.speaking.join(", ")} | ${r.listening.join(", ")}`);
    console.log(`DELAY ${theme}: ms ${delays.join(" ")} | min ${Math.min(...delays)} median ${median(delays)} max ${Math.max(...delays)} (headless, fake device)`);

    assert.equal(rows.length, TURNS);
    for (const r of rows) {
      assert.equal(r.waiting[0], 0, `turn ${r.turn}: a live track while waiting`);
      assert.equal(r.speaking[0], 0, `turn ${r.turn}: a live track while speaking`);
      assert.equal(r.listening[0], 1, `turn ${r.turn}: exactly one live track while listening`);
      assert.equal(r.tracks, r.turn + 1, `turn ${r.turn}: one stream per listening run`);
      assert.equal(r.waiting[1], rows[0].waiting[1], `turn ${r.turn}: open contexts grew while waiting`);
      assert.equal(r.speaking[1], rows[0].speaking[1], `turn ${r.turn}: open contexts grew while speaking`);
      assert.equal(r.listening[1], rows[0].listening[1], `turn ${r.turn}: open contexts grew while listening`);
    }
    assert.equal(delays.length, TURNS);
    // The guard is 300 ms, so no reopen can be faster than that.
    assert.ok(Math.min(...delays) >= 300, `a reopen after ${Math.min(...delays)} ms, under the 300 ms guard`);
  });
}
