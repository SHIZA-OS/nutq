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
}

function init() {
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
