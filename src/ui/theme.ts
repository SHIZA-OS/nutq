// Presentation only: the theme switch, the tab icons, and everything shown that is derived from what main.ts already
// writes into the DOM (status pills, mic button, env note). It imports nothing from the logic modules and never calls
// into them; the one thing it does to the app is forward the banner's Connect click to the real #connect-btn.

export type Theme = "zeroclaw" | "shiza";

export const THEME_KEY = "theme";

// The tab icons per theme. index.html carries a copy of this mapping in its head script (it has to run before first
// paint); theme.test.mjs fails if the two differ.
export const THEMES: Record<Theme, { icon32: string; icon180: string }> = {
  zeroclaw: { icon32: "/brand/favicon-zeroclaw-32.png", icon180: "/brand/favicon-zeroclaw-180.png" },
  shiza: { icon32: "/brand/favicon-shiza-32.png", icon180: "/brand/favicon-shiza-180.png" },
};

// Anything that is not exactly a known theme (nothing saved, a stale value, a tampered one) is the default.
export function parseTheme(raw: unknown): Theme {
  return raw === "shiza" ? "shiza" : "zeroclaw";
}

export function themeIcon(theme: Theme, size: 32 | 180 = 32): string {
  return size === 32 ? THEMES[theme].icon32 : THEMES[theme].icon180;
}

// --- Status text to what the page shows ------------------------------------------------------------------------------
// ONE table. The keys are the exact strings main.ts passes to setStatus (and the mic button's label). A text that is
// not in it, for example after a copy change in main.ts, is "neutral": it degrades to a grey "N/A", never to a wrong
// state and never to an error.

export type Tone = "ok" | "warn" | "idle" | "error" | "neutral";
export type Row = { badge: string; tone: Tone };

const row = (tone: Tone, badge: string): Row => ({ badge, tone });
const NEUTRAL: Row = row("neutral", "N/A");

type MicEntry = { mic: Row; model: Row; banner: { title: string; detail: string } | null };

export const STATUS = {
  // #mic-status: feeds the mic row, the moonshine-stt row and the model banner of the zeroclaw theme
  mic: {
    "model not loaded": { mic: row("idle", "IDLE"), model: row("warn", "WAIT"), banner: { title: "Speech model not loaded", detail: "connect to the gateway to load moonshine-stt" } },
    "loading model…": { mic: row("idle", "IDLE"), model: row("idle", "LOADING"), banner: { title: "Loading speech model", detail: "moonshine-stt · local WASM" } },
    ready: { mic: row("idle", "IDLE"), model: row("ok", "OK"), banner: null },
    "listening…": { mic: row("ok", "LIVE"), model: row("ok", "OK"), banner: null },
    "model load failed": { mic: row("idle", "IDLE"), model: row("error", "FAILED"), banner: null },
    "model unavailable": { mic: row("idle", "IDLE"), model: row("error", "FAILED"), banner: null },
    "microphone unavailable": { mic: row("error", "ERROR"), model: row("ok", "OK"), banner: null },
    error: { mic: row("idle", "IDLE"), model: row("error", "ERROR"), banner: null },
  } as Record<string, MicEntry>,
  // #conn-status: feeds the ws/chat row and the connection card
  conn: {
    "connecting…": row("idle", "WAIT"),
    connected: row("ok", "OK"),
    "Answer timed out, reconnected": row("ok", "OK"),
    disconnected: row("warn", "OFF"),
    error: row("error", "ERROR"),
    "invalid url": row("error", "ERROR"),
  } as Record<string, Row>,
  // #pair-status: feeds the pairing card (its tone only)
  pair: {
    "not paired": "warn",
    "pairing…": "idle",
    paired: "ok",
    "paired (saved token)": "ok",
    "paired (manual)": "ok",
    "invalid code": "error",
    "invalid url": "error",
    "rate limited": "error",
    "manual pairing needed": "error",
    error: "error",
  } as Record<string, Tone>,
  // #env-note: unhidden by main.ts when the browser has no speech synthesis
  speech: { available: row("ok", "OK"), unavailable: row("warn", "OFF") },
  // The mic button's label while listening (main.ts sets "Start listening" otherwise)
  listeningLabel: "Stop listening",
};

const MIC_NEUTRAL: MicEntry = { mic: NEUTRAL, model: NEUTRAL, banner: null };

function lookup<T>(table: Record<string, T>, text: string | null | undefined, fallback: T): T {
  const key = (text ?? "").trim();
  return Object.hasOwn(table, key) ? table[key] : fallback;
}

export const describeMic = (text: string | null | undefined): MicEntry => lookup(STATUS.mic, text, MIC_NEUTRAL);
export const describeConn = (text: string | null | undefined): Row => lookup(STATUS.conn, text, NEUTRAL);
export const describePair = (text: string | null | undefined): Tone => lookup<Tone>(STATUS.pair, text, "neutral");

// --- Canvases (SHIZA theme) ---------------------------------------------------------------------------------------
// A starry sky behind the page and the "pollen" cloud behind the mic button. Both only draw: the pollen reads the mode from
// <html data-mic> and data-model (published by refresh() from the DOM main.ts writes) and clicking it is clicking the real
// #mic-btn, which covers the stage (the canvas ignores the pointer). <html data-canvas> says what the loop is doing:
// "running" (SHIZA, tab visible, motion allowed: the pollen loop runs, about 30 fps unless listening), "static" (SHIZA with
// reduced motion: one still frame, redrawn on a state change or resize) or "stopped" (ZeroClaw theme or hidden tab: no animation
// frame is requested at all). The sky is never animated: it is drawn on a theme switch, a visibility change and a resize.

type Dot = { x: number; y: number; z: number; r: number; s: number; c: string; ph: number; ox: number; oy: number; mote: boolean; sx: number; sy: number; depth: number; size: number };

const PALETTE = ["#8B5CFF", "#8B5CFF", "#8B5CFF", "#8B5CFF", "#787FF7", "#787FF7", "#787FF7", "#C178FF", "#C178FF", "#F5F2FF"];
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const pick = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

const stars = Array.from({ length: 280 }, () => {
  const bias = Math.random() < 0.55; // towards the upper right, where the nebula sits
  return { x: bias ? 0.45 + Math.random() * 0.55 : Math.random(), y: bias ? Math.random() * 0.55 : Math.random(), s: 0.3 + Math.random() * 1.1, a: 0.25 + Math.random() * 0.6 };
});
const dust = Array.from({ length: 140 }, () => ({ u: Math.random(), off: (Math.random() - 0.5) * 0.09, s: 0.4 + Math.random() * 1.2, a: 0.2 + Math.random() * 0.6 }));

const dots: Dot[] = [];
for (let i = 0; i < 360; i++) {
  const y = 1 - (i / 359) * 2;
  const rr = Math.sqrt(1 - y * y);
  const th = GOLDEN * i;
  const shell = Math.random() < 0.72;
  dots.push({ x: Math.cos(th) * rr, y, z: Math.sin(th) * rr, r: shell ? 0.9 + Math.random() * 0.14 : 0.25 + Math.random() * 0.6, s: 0.7 + Math.random() * 1.5, c: pick(), ph: Math.random() * 6.28, ox: 0, oy: 0, mote: false, sx: 0, sy: 0, depth: 0, size: 0 });
}
for (let j = 0; j < 46; j++) { // loose motes drifting around the cloud
  const a = Math.random() * 6.283;
  const b = Math.acos(2 * Math.random() - 1);
  dots.push({ x: Math.sin(b) * Math.cos(a), y: Math.cos(b), z: Math.sin(b) * Math.sin(a), r: 1.25 + Math.random() * 0.6, s: 0.5 + Math.random() * 0.9, c: pick(), ph: Math.random() * 6.28, ox: 0, oy: 0, mote: true, sx: 0, sy: 0, depth: 0, size: 0 });
}

let skyCanvas: HTMLCanvasElement;
let pollenCanvas: HTMLCanvasElement;
let angle = 0;
let level = 0; // eased towards levelTarget, which the meter below sets from the microphone
let levelTarget = 0;

// For tests: how loud the pollen currently thinks the microphone is (0 to 1).
export const pollenLevel = () => level;
let burst = 0;
let pointer = { x: 0, y: 0, active: false };

// Fits the canvas to its CSS box (at most `maxDpr` device pixels per CSS pixel) and returns a context drawing in CSS pixels.
function fit(cv: HTMLCanvasElement, maxDpr: number) {
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  const ctx = cv.getContext("2d");
  if (!ctx || !w || !h) return null;
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const streak = (u: number, w: number, h: number) => [
  w * (0.38 + 0.66 * u),
  h * (0.34 - 0.27 * u + Math.sin(u * 5.2) * 0.035 + Math.sin(u * 2.1) * 0.02 - 0.12 * Math.sin(u * Math.PI)),
];

// Drawn once, not animated: on a theme switch, a visibility change and a resize (see syncCanvas). A continuous full-screen
// loop was the largest CPU cost of the SHIZA theme.
function drawSky() {
  const f = fit(skyCanvas, 1.5);
  if (!f) return;
  const { ctx, w, h } = f;
  const big = Math.max(w, h);
  const blob = (x: number, y: number, r: number, rgba: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  blob(w * 0.82, h * 0.1, big * 0.55, "rgba(98,52,214,0.24)");
  blob(w * 0.98, h * -0.02, big * 0.35, "rgba(139,92,255,0.20)");
  blob(w * 0.62, h * 0.24, big * 0.22, "rgba(193,120,255,0.07)");
  blob(w * 0.02, h * 0.95, big * 0.4, "rgba(120,127,247,0.07)");

  ctx.globalCompositeOperation = "lighter";
  stars.forEach((st, i) => {
    ctx.globalAlpha = st.a;
    ctx.fillStyle = i % 5 === 0 ? "#C9B8FF" : "#F5F2FF";
    ctx.beginPath();
    ctx.arc(st.x * w, st.y * h, st.s, 0, 6.283);
    ctx.fill();
  });

  // the light streak: wide haze, mid glow, bright core
  for (const [lw, alpha, color] of [[46, 0.035, "#8B5CFF"], [16, 0.07, "#9D74FF"], [3, 0.22, "#C9B8FF"], [1, 0.55, "#EDE6FF"]] as const) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let k = 0; k <= 60; k++) {
      const [x, y] = streak(k / 60, w, h);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "#DCCEFF";
  for (const d of dust) { // dust along the streak
    const [x, y] = streak(d.u, w, h);
    ctx.globalAlpha = d.a * (0.3 + 0.7 * d.u);
    ctx.beginPath();
    ctx.arc(x, y + d.off * h, d.s, 0, 6.283);
    ctx.fill();
  }

  // the flare where the streak brightens
  const [fx, fy] = streak(0.78, w, h);
  const fr = 70;
  const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr);
  fg.addColorStop(0, "rgba(255,255,255,0.9)");
  fg.addColorStop(0.12, "rgba(214,196,255,0.55)");
  fg.addColorStop(0.45, "rgba(139,92,255,0.18)");
  fg.addColorStop(1, "rgba(139,92,255,0)");
  ctx.globalAlpha = 1;
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.arc(fx, fy, fr, 0, 6.283);
  ctx.fill();
  const lg = ctx.createLinearGradient(fx - 140, fy, fx + 140, fy);
  lg.addColorStop(0, "rgba(201,184,255,0)");
  lg.addColorStop(0.5, "rgba(237,230,255,0.7)");
  lg.addColorStop(1, "rgba(201,184,255,0)");
  ctx.fillStyle = lg;
  ctx.fillRect(fx - 140, fy - 0.75, 280, 1.5);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// How the cloud looks for what the page says: listening (bright, quicker), ready, loading the model (dim, fast swirl), or
// disabled for any other reason (not loaded, no connection, an error: dimmest and nearly still).
function pollenMode() {
  const d = document.documentElement.dataset;
  if (d.mic === "listening") return { spin: 0.42, alpha: 1 };
  if (d.mic === "disabled") return d.model === "idle" ? { spin: 0.6, alpha: 0.55 } : { spin: 0.07, alpha: 0.35 };
  return { spin: 0.16, alpha: 0.85 };
}

function drawPollen(t: number, dt: number, still: boolean) {
  const f = fit(pollenCanvas, 2);
  if (!f) return;
  const { ctx, w, h } = f;
  const mode = pollenMode();
  level += ((still ? 0 : levelTarget) - level) * 0.12;
  burst *= 0.92;
  if (!still) angle += mode.spin * dt;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const tilt = 0.38;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.32;
  const fov = 3.2;

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5); // the soft core glow, dimmed with the mode like the dots
  g.addColorStop(0, `rgba(139,92,255,${Math.min(0.9, (0.1 + level * 0.18 + burst * 0.12) * (mode.alpha / 0.85)).toFixed(3)})`);
  g.addColorStop(1, "rgba(139,92,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = "lighter";
  for (const q of dots) {
    const x = q.x * ca + q.z * sa;
    let z = -q.x * sa + q.z * ca;
    const y = q.y * ct - z * st;
    z = q.y * st + z * ct;
    let rad = q.r;
    if (!still) {
      rad *= 1 + 0.035 * Math.sin(t * 0.9 + q.ph);
      if (q.mote) rad += 0.08 * Math.sin(t * 0.4 + q.ph);
    }
    rad *= 1 + level * 0.32 * (0.55 + 0.45 * Math.sin(t * 7 + q.ph * 3)) + burst * 0.28;
    const sc = fov / (fov + z * rad);
    const sx = cx + x * rad * R * sc;
    const sy = cy + y * rad * R * sc;
    let tx = 0;
    let ty = 0;
    if (pointer.active) { // the cursor pushes dots away, and they spring back
      const dx = sx - pointer.x;
      const dy = sy - pointer.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (d < 95) {
        const k = (1 - d / 95) ** 2 * 46;
        tx = (dx / d) * k;
        ty = (dy / d) * k;
      }
    }
    q.ox += (tx - q.ox) * 0.18;
    q.oy += (ty - q.oy) * 0.18;
    q.sx = sx + q.ox;
    q.sy = sy + q.oy;
    q.depth = (1 - (z * rad) / 1.6) / 2; // about 0 at the back, 1 at the front
    q.size = q.s * sc * (1 + level * 0.5);
  }
  for (const q of dots) {
    ctx.globalAlpha = Math.max(0.06, Math.min(1, (0.22 + 0.78 * q.depth) * mode.alpha * (q.mote ? 0.55 : 1)));
    ctx.fillStyle = q.c;
    ctx.beginPath();
    ctx.arc(q.sx, q.sy, q.size, 0, 6.283);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// --- Real microphone level ----------------------------------------------------------------------------------------
// main.ts announces the microphone stream with a window event right after getUserMedia succeeds ("mic-stream", detail
// { stream }) and announces its end ("mic-stream-end") when listening stops. The meter below is a read-only listener: its own
// AudioContext and AnalyserNode fed from the stream, never connected to any output, the stream itself untouched. It exists
// only while the pollen is animating (SHIZA, tab visible, motion allowed) and is closed on stop, a theme switch or a hidden tab.

type Meter = { ctx: AudioContext; src: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> };
let micStream: MediaStream | null = null;
let meter: Meter | null = null;

function openMeter() {
  if (meter || !micStream) return;
  const ctx = new AudioContext();
  try {
    const src = ctx.createMediaStreamSource(micStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser); // and nowhere else
    meter = { ctx, src, analyser, buf: new Float32Array(analyser.fftSize) };
    ctx.resume().catch(() => {});
  } catch {
    micStream = null; // something we cannot measure (not a real MediaStream): the cloud just stays at rest
    ctx.close().catch(() => {});
  }
}

function closeMeter() {
  if (!meter) return;
  const { ctx, src, analyser } = meter;
  meter = null;
  src.disconnect();
  analyser.disconnect();
  ctx.close().then(() => console.info(`mic level meter closed, AudioContext ${ctx.state}`), () => {});
}

function syncMeter() {
  if (micStream && canvasMode() === "running") openMeter();
  else closeMeter();
}

// Loudness of the last 1024 samples, scaled so ordinary speech (RMS around 0.05 to 0.15) moves the cloud well without pinning it.
function readLevel(): number {
  if (!meter) return 0;
  meter.analyser.getFloatTimeDomainData(meter.buf);
  let sum = 0;
  for (const v of meter.buf) sum += v * v;
  return Math.min(1, Math.sqrt(sum / meter.buf.length) * 6);
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let raf = 0;
let timer = 0;
let lastDraw = 0;
const IDLE_FRAME_MS = 30; // the gap between pollen frames while not listening: about 30 fps on a 60 Hz screen

function canvasMode(): "running" | "static" | "stopped" {
  if (document.documentElement.dataset.theme !== "shiza" || document.hidden) return "stopped";
  return reducedMotion.matches ? "static" : "running";
}

// The pollen at full rate only while listening (when it follows the voice), otherwise about 30 fps. dt is the time since the
// last frame, so the spin speed does not depend on the rate.
function frame(now: number) {
  raf = 0;
  const dt = Math.min(0.05, (now - lastDraw) / 1000);
  lastDraw = now;
  levelTarget = readLevel();
  drawPollen(now / 1000, dt, false);
  nextFrame();
}

// While idle the next animation frame is not even requested until the gap has passed: a frame that is requested and then skipped
// still makes the browser run its whole main-thread frame (style, layout, paint checks), which cost more than drawing.
function nextFrame() {
  const wait = document.documentElement.dataset.mic === "listening" ? 0 : IDLE_FRAME_MS - (performance.now() - lastDraw);
  if (wait > 1) {
    timer = window.setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(frame);
    }, wait);
  } else {
    raf = requestAnimationFrame(frame);
  }
}

// Starts, stops or redraws according to canvasMode(); called whenever the theme, tab visibility or motion setting changes.
// The sky is drawn here, once, and again on a resize; only the pollen has a loop.
function syncCanvas() {
  const m = canvasMode();
  document.documentElement.dataset.canvas = m;
  syncMeter();
  if (m !== "stopped") drawSky();
  if (m === "running") {
    if (!raf && !timer) {
      lastDraw = performance.now();
      nextFrame();
    }
    return;
  }
  cancelAnimationFrame(raf);
  clearTimeout(timer);
  raf = 0;
  timer = 0;
  redrawStill();
}

// With reduced motion the pollen is one still frame; a new state or size is a new frame.
function redrawStill() {
  if (canvasMode() === "static") drawPollen(0, 0, true);
}

function initCanvases() {
  skyCanvas = document.createElement("canvas");
  skyCanvas.className = "sky";
  pollenCanvas = document.createElement("canvas");
  pollenCanvas.className = "pollen";
  for (const cv of [skyCanvas, pollenCanvas]) cv.setAttribute("aria-hidden", "true");
  document.body.prepend(skyCanvas);
  document.querySelector(".mic-stage")!.prepend(pollenCanvas);

  const mic = byId("mic-btn");
  mic.addEventListener("pointermove", (e) => {
    const r = pollenCanvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top, active: true };
  });
  mic.addEventListener("pointerleave", () => { pointer.active = false; });
  mic.addEventListener("click", () => { burst = 1; }); // a disabled button gets no click, so a refused press does not pulse
  window.addEventListener("mic-stream", (e) => {
    closeMeter(); // a stream replaced without an end in between
    micStream = (e as CustomEvent<{ stream: MediaStream }>).detail?.stream ?? null;
    syncMeter();
  });
  window.addEventListener("mic-stream-end", () => {
    micStream = null;
    syncMeter();
  });
  document.addEventListener("visibilitychange", syncCanvas);
  reducedMotion.addEventListener("change", syncCanvas);
  window.addEventListener("resize", () => {
    if (canvasMode() !== "stopped") drawSky();
    redrawStill();
  });
}

// --- DOM wiring ---------------------------------------------------------------------------------------------------

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function loadTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "zeroclaw"; // storage blocked or throwing: the default, and the switch still works for this visit
  }
}

function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ponytail: a failed save is dropped; the theme just does not persist
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  byId<HTMLLinkElement>("tab-icon").href = themeIcon(theme, 32);
  byId<HTMLLinkElement>("touch-icon").href = themeIcon(theme, 180);
  byId("theme-switch").setAttribute("aria-checked", String(theme === "shiza"));
  syncCanvas();
}

function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

// Reads the DOM main.ts maintains and publishes it as data-* on <html> (for the CSS and, later, the canvases) plus the
// zeroclaw theme's health rows and banner. Read-only with respect to everything main.ts owns.
function refresh() {
  const root = document.documentElement;
  const micBtn = byId<HTMLButtonElement>("mic-btn");
  const mic = describeMic(byId("mic-status").textContent);
  const conn = describeConn(byId("conn-status").textContent);
  const connText = (byId("conn-status").textContent ?? "").trim();
  const note = byId("env-note");
  const speech = note.hidden ? STATUS.speech.available : STATUS.speech.unavailable;

  root.dataset.mic = micBtn.disabled ? "disabled" : (micBtn.textContent ?? "").trim() === STATUS.listeningLabel ? "listening" : "ready";
  root.dataset.model = mic.model.tone;
  root.dataset.conn = conn.tone;
  root.dataset.pair = describePair(byId("pair-status").textContent);

  const rows: Record<string, [Row, string]> = {
    mic: [mic.mic, ""],
    model: [mic.model, (byId("mic-status").textContent ?? "").trim()],
    socket: [conn, connText],
    speech: [speech, note.hidden ? "" : (note.textContent ?? "").trim()],
  };
  for (const li of document.querySelectorAll<HTMLElement>(".health-row")) {
    const [r, sub] = rows[li.dataset.row ?? ""] ?? [NEUTRAL, ""];
    if (li.dataset.tone !== r.tone) li.dataset.tone = r.tone;
    setText(li.querySelector(".health-badge")!, r.badge);
    setText(li.querySelector(".health-sub")!, sub);
  }

  const banner = byId("model-banner");
  banner.hidden = mic.banner === null;
  if (mic.banner) {
    setText(byId("model-banner-title"), mic.banner.title);
    setText(byId("model-banner-detail"), mic.banner.detail);
  }
  byId("banner-connect").hidden = conn.tone === "ok";
  redrawStill();
}

function init() {
  initCanvases();
  applyTheme(loadTheme());
  byId("theme-switch").addEventListener("click", () => {
    const next: Theme = document.documentElement.dataset.theme === "shiza" ? "zeroclaw" : "shiza";
    applyTheme(next);
    saveTheme(next);
  });
  // The banner's Connect is the real Connect button, pressed: one code path.
  byId("banner-connect").addEventListener("click", () => byId("connect-btn").click());

  const observer = new MutationObserver(refresh);
  for (const id of ["mic-btn", "mic-status", "conn-status", "pair-status", "env-note"]) {
    observer.observe(byId(id), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled", "hidden"] });
  }
  refresh();
}

init();
