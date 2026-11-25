// Shared by hands-free.test.mjs and hands-free-leak.test.mjs: the real page in headless Chrome against the stub gateway
// (page-harness.mjs), with
//  - the REAL src/vendor/transcriber.ts, so start(), attachStream() and stop() (the release of the stream and the source node, the one
//    reused AudioContext) are the real code; only the model load and the VAD are stand-ins (nothing is downloaded, no speech is
//    recognised), and a stop commits the next text of window.__texts when window.__commitOnStop is set, like the harness's fake;
//  - a stand-in microphone: every getUserMedia call returns a stream from a WebAudio oscillator (real MediaStreamTracks whose
//    readyState goes "ended" when stopped), so the live tracks can be counted. This is not Chrome's fake capture device, so the
//    page's permission and device code is the harness's stub, not Chrome's;
//  - counters: window.__mic.tracks (every track handed out), window.__mic.calls, and every AudioContext the page makes.
// Speech is driven by the test: window.__tcb is the page's own transcriber callbacks, and the speech synthesis stub never ends an
// utterance by itself (finishSpeech() does).

export const CLOCK_REAL = `Date.now = () => Math.round(performance.timeOrigin + performance.now());`;

// Serves the real transcriber under another URL and a subclass of it under the usual one.
export const realTranscriber = async (route) => {
  if (route.request().url().includes("real=1")) return route.continue();
  await route.fulfill({
    contentType: "text/javascript",
    body: `import { Transcriber as Real } from "/src/vendor/transcriber.ts?real=1";
export class Transcriber extends Real {
  constructor(model, callbacks, ...rest) {
    super(model, callbacks, ...rest);
    window.__tcb = callbacks;
  }
  async load() {
    this.callbacks.onModelLoadStarted();
    this.vadModel = { receive: (node) => node.connect(window.__sink ??= this.audioContext.createGain()), start() {}, pause() {} };
    this.callbacks.onModelLoaded();
  }
  async start() {
    await super.start(); // calls onTranscribeStarted, then the (stand-in) VAD start and audioContext.resume()
    if (window.__startGate) await window.__startGate; // a test holds the start here to look at the page before it resolves
  }
  async stop() {
    if (window.__commitOnStop) this.callbacks.onTranscriptionCommitted((window.__texts ?? []).shift() ?? "hello there");
    await super.stop();
  }
}`,
  });
};

// An init script (runs in the page before it): the stand-in microphone, the AudioContext counter, the hint recorder, and a saved theme.
export const initScript = (theme) => `(${(theme) => {
  if (theme) localStorage.setItem("theme", theme);
  window.__mic = { tracks: [], calls: 0 };
  window.__ctxs = [];
  const RealAudioContext = window.AudioContext;
  window.AudioContext = class extends RealAudioContext {
    constructor(...a) {
      super(...a);
      window.__ctxs.push(this);
    }
  };
  let source;
  navigator.mediaDevices.getUserMedia = async () => {
    window.__mic.calls++;
    if (!source) {
      source = new RealAudioContext(); // the stand-in microphone's own context: not the page's, so not counted
      source.__source = true;
      window.__ctxs.push(source);
    }
    const d = source.createMediaStreamDestination();
    source.createOscillator().connect(d);
    window.__mic.tracks.push(d.stream.getAudioTracks()[0]);
    return d.stream;
  };
  // The speech engine's own state, which the loop's watchdog looks at: speaking from speak() until the test plays the end (finishSpeech)
  // or the page cancels. A test sets window.__synth.speaking / .pending to model an engine that dies silently or one still talking.
  window.__synth = { speaking: false, pending: false };
  Object.defineProperty(speechSynthesis, "speaking", { get: () => window.__synth.speaking, configurable: true });
  Object.defineProperty(speechSynthesis, "pending", { get: () => window.__synth.pending, configurable: true });
  const speak = speechSynthesis.speak;
  speechSynthesis.speak = (u) => {
    window.__synth.speaking = true;
    speak(u);
  };
  const cancel = speechSynthesis.cancel;
  speechSynthesis.cancel = () => {
    window.__synth.speaking = window.__synth.pending = false;
    cancel();
  };
  // Every text the hint under the mic button showed, in order.
  window.__hints = [];
  addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("mic-hint");
    window.__hints.push(el.textContent);
    new MutationObserver(() => window.__hints.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
}})(${JSON.stringify(theme ?? null)})`;

export const openHandsFree = (h, query, { theme, real = false } = {}) =>
  h.openPage(query, { init: { content: initScript(theme) + (real ? `;${CLOCK_REAL}` : "") }, transcriber: realTranscriber });

export const mic = (p) =>
  p.page.evaluate(() => ({
    live: window.__mic.tracks.filter((t) => t.readyState === "live").length,
    tracks: window.__mic.tracks.length,
    calls: window.__mic.calls,
    contexts: window.__ctxs.filter((c) => !c.__source && c.state !== "closed").length,
    hint: document.getElementById("mic-hint").textContent,
    pill: document.getElementById("mic-status").textContent,
    switch: document.getElementById("hands-free-switch").getAttribute("aria-checked"),
  }));

export const waitHint = (p, text, ms = 6000) =>
  p.page.waitForFunction((t) => document.getElementById("mic-hint").textContent === t, text, { timeout: ms });

// The user says something: speech starts, the next text is what a stop commits, speech ends (the page's auto-silence then sends).
export const say = (p, text) =>
  p.page.evaluate((t) => {
    window.__commitOnStop = true;
    (window.__texts ??= []).push(t);
    window.__tcb.onSpeechStart(0);
    window.__tcb.onSpeechEnd();
  }, text);

// Waits for the stub gateway to have received `n` messages on this page's connection.
export const waitMessages = async (h, p, n, ms = 8000) => {
  const end = Date.now() + ms; // the real clock: this runs in node
  while (h.messages(p.conn).length < n) {
    if (Date.now() > end) throw new Error(`only ${h.messages(p.conn).length} of ${n} messages arrived`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// Plays every utterance the page has asked the speech engine for and not yet played, start then end. Returns how many.
export const finishSpeech = (p) =>
  p.page.evaluate(() => {
    const us = window.__sp.utterances;
    let n = 0;
    for (let i = window.__played ?? 0; i < us.length; i++) {
      us[i].onstart?.({});
      us[i].onend?.({});
      n++;
    }
    window.__played = us.length;
    window.__synth.speaking = window.__synth.pending = false;
    return n;
  });

// The gateway answers the newest message: one chunk and a done, then the speech is played to its end.
export const answer = async (p, text = "Here is the answer.") => {
  await p.send({ type: "chunk", content: text });
  await p.send({ type: "done", full_response: text, tokens_used: 1 });
  await p.page.waitForFunction(() => window.__sp.utterances.length > (window.__played ?? 0), null, { timeout: 4000 }).catch(() => {});
  return finishSpeech(p);
};
