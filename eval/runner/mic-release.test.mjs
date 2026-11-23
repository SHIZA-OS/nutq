// Every end of listening gives the microphone back. Each press opens its own getUserMedia stream; stopping must end that
// stream's tracks (the browser's recording indicator goes off) and disconnect its source node from the Transcriber's one
// AudioContext, which is reused by the next press. The real Transcriber runs in headless Chrome; only the VAD is a stand-in
// (no model is loaded), so the press, attach, stop sequence is the real code. The last case is the stop that arrives while
// getUserMedia is still pending, through the page with the harness's fake Transcriber.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./page-harness.mjs";

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});

test("ten presses leave no live track and no source node still connected", async () => {
  const page = await h.context.newPage();
  await page.goto(h.vite.url);
  const r = await page.evaluate(async () => {
    const { Transcriber } = await import("/src/vendor/transcriber.ts");
    const t = new Transcriber("moonshine/tiny", {});
    const sink = t.audioContext.createGain();
    t.vadModel = { receive: (node) => node.connect(sink), pause() {} };
    const nodes = new Set();
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...a) {
      if (this instanceof MediaStreamAudioSourceNode) nodes.add(this);
      return connect.apply(this, a);
    };
    const disconnect = AudioNode.prototype.disconnect;
    AudioNode.prototype.disconnect = function (...a) {
      nodes.delete(this);
      return disconnect.apply(this, a);
    };
    const source = new AudioContext(); // the stand-in microphone, outside the page's own context
    const live = [];
    for (let i = 0; i < 10; i++) {
      const d = source.createMediaStreamDestination();
      source.createOscillator().connect(d);
      live.push(d.stream.getAudioTracks()[0]);
      t.attachStream(d.stream);
      await t.stop();
    }
    return { live: live.filter((x) => x.readyState === "live").length, connected: nodes.size, state: t.audioContext.state };
  });
  assert.equal(r.live, 0);
  assert.equal(r.connected, 0);
  assert.notEqual(r.state, "closed", "the context is reused by the next press, so it stays open");
  await page.close();
});

test("a stop pressed while getUserMedia is pending does not leave the microphone open", async () => {
  const p = await h.openPage("", {
    init: {
      content: `(${() => {
        window.__stopped = 0;
        window.__gumGate = new Promise((r) => (window.__openMic = r));
        navigator.mediaDevices.getUserMedia = async () => {
          await window.__gumGate;
          return { getAudioTracks: () => [{ getSettings: () => ({}), stop: () => window.__stopped++ }] };
        };
      }})()`,
    },
  });
  await p.mic(); // start: getUserMedia is pending
  await p.mic(); // stop, before the stream has arrived
  await p.page.evaluate(() => window.__openMic());
  await p.page.waitForTimeout(300);
  assert.equal(await p.page.evaluate(() => window.__stopped), 1);
});
