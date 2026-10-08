// The two themes (src/ui/theme.ts, index.html's head script, src/style.css): saved-theme parsing with its fallback, the theme to
// tab-icon mapping, every status string main.ts writes mapped to what the page shows (and anything else to neutral), the head
// script agreeing with the module, the switch and its persistence, one DOM (no duplicate ids), the layout at 480px, and reduced
// motion. Runs in headless Chrome against the Vite dev server; nothing here touches a gateway or the speech model.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { REPO, startVite } from "./vite-server.mjs";

let vite;
let browser;
const MAIN = readFileSync(join(REPO, "src/main.ts"), "utf8");
const HTML = readFileSync(join(REPO, "index.html"), "utf8");

before(async () => {
  vite = await startVite();
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome", headless: true });
});
after(async () => {
  await browser?.close();
  vite?.child.kill();
});

// A page with the given saved theme (undefined: nothing saved), optionally 480 wide, reduced motion, or with storage that throws.
async function open({ saved, width = 1280, reduced = false, brokenStorage = false, block = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  if (brokenStorage) {
    await context.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error("storage blocked"); };
      Storage.prototype.setItem = () => { throw new Error("storage blocked"); };
    });
  } else if (saved !== undefined) {
    await context.addInitScript((v) => localStorage.setItem("theme", v), saved);
  }
  // Counts animation frames requested, so a test can tell "drawing" from "no animation work at all".
  await context.addInitScript(() => {
    window.__raf = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => { window.__raf++; return raf(cb); };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${e}\n${e.stack ?? ""}`));
  for (const pattern of block) await page.route(pattern, (route) => route.abort());
  await page.goto(vite.url);
  await page.waitForFunction(() => document.getElementById("theme-switch")?.getAttribute("aria-checked") !== null);
  return { page, context, errors };
}

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const icons = (page) => page.evaluate(() => [document.getElementById("tab-icon").href, document.getElementById("touch-icon").href].map((h) => new URL(h).pathname));
const inPage = (page, fn, arg) => page.evaluate(async ([src, a]) => { const m = await import("/src/ui/theme.ts"); return new Function("m", "a", `return (${src})(m, a)`)(m, a); }, [fn.toString(), arg]);

test("parseTheme: shiza only when exactly shiza, everything else the default", async () => {
  const { page, context } = await open();
  const got = await inPage(page, (m) => [undefined, null, "", "zeroclaw", "shiza", "SHIZA", " shiza", "dark", 1, {}].map((v) => m.parseTheme(v)));
  assert.deepEqual(got, ["zeroclaw", "zeroclaw", "zeroclaw", "zeroclaw", "shiza", "zeroclaw", "zeroclaw", "zeroclaw", "zeroclaw", "zeroclaw"]);
  await context.close();
});

test("themeIcon: each theme has its own 32 and 180 pixel icon", async () => {
  const { page, context } = await open();
  const got = await inPage(page, (m) => ["zeroclaw", "shiza"].flatMap((t) => [m.themeIcon(t), m.themeIcon(t, 32), m.themeIcon(t, 180)]));
  assert.deepEqual(got, [
    "/brand/favicon-zeroclaw-32.png", "/brand/favicon-zeroclaw-32.png", "/brand/favicon-zeroclaw-180.png",
    "/brand/favicon-shiza-32.png", "/brand/favicon-shiza-32.png", "/brand/favicon-shiza-180.png",
  ]);
  await context.close();
});

// What main.ts passes to setStatus (read from its source, so a new string there fails this test until the table has it), plus
// the three statuses index.html starts with.
function statusStrings(element) {
  const out = new Set();
  for (const line of MAIN.split("\n")) {
    const m = line.match(new RegExp(`setStatus\\(${element},(.*)\\)`));
    if (!m) continue;
    const lits = [...m[1].matchAll(/"([^"]+)"/g)].map((l) => l[1]);
    for (const lit of lits.slice(0, -1)) out.add(lit); // the last literal is the kind (idle, ok, warn, error)
  }
  return [...out];
}

test("every status string main.ts writes has an entry; the table has nothing main.ts does not write", async () => {
  const { page, context } = await open();
  const table = await inPage(page, (m) => ({ mic: Object.keys(m.STATUS.mic), conn: Object.keys(m.STATUS.conn), pair: Object.keys(m.STATUS.pair) }));
  for (const [key, el, initial] of [["mic", "micStatus", "model not loaded"], ["conn", "connStatus", "disconnected"], ["pair", "pairStatus", "not paired"]]) {
    const written = new Set([...statusStrings(el), initial]);
    assert.ok(written.size >= 6, `${key}: read ${written.size} strings from main.ts`);
    assert.deepEqual([...written].filter((s) => !table[key].includes(s)), [], `${key}: written by main.ts but not in the table`);
    assert.deepEqual(table[key].filter((s) => !written.has(s)), [], `${key}: in the table but never written`);
  }
  await context.close();
});

test("each known status maps to its row, badge and tone", async () => {
  const { page, context } = await open();
  const got = await inPage(page, (m) => ({
    mic: Object.fromEntries(Object.keys(m.STATUS.mic).map((t) => [t, [m.describeMic(t).mic.tone + ":" + m.describeMic(t).mic.badge, m.describeMic(t).model.tone + ":" + m.describeMic(t).model.badge, m.describeMic(t).banner?.title ?? null]])),
    conn: Object.fromEntries(Object.keys(m.STATUS.conn).map((t) => [t, m.describeConn(t).tone + ":" + m.describeConn(t).badge])),
    pair: Object.fromEntries(Object.keys(m.STATUS.pair).map((t) => [t, m.describePair(t)])),
  }));
  assert.deepEqual(got.mic, {
    "model not loaded": ["idle:IDLE", "warn:WAIT", "Speech model not loaded"],
    "loading model…": ["idle:IDLE", "idle:LOADING", "Loading speech model"],
    ready: ["idle:IDLE", "ok:OK", null],
    "listening…": ["ok:LIVE", "ok:OK", null],
    "model load failed": ["idle:IDLE", "error:FAILED", null],
    "model unavailable": ["idle:IDLE", "error:FAILED", null],
    "microphone unavailable": ["error:ERROR", "ok:OK", null],
    error: ["idle:IDLE", "error:ERROR", null],
  });
  assert.deepEqual(got.conn, {
    "connecting…": "idle:WAIT",
    connected: "ok:OK",
    "Answer timed out, reconnected": "ok:OK",
    disconnected: "warn:OFF",
    error: "error:ERROR",
    "invalid url": "error:ERROR",
  });
  assert.deepEqual(got.pair, {
    "not paired": "warn", "pairing…": "idle", paired: "ok", "paired (saved token)": "ok", "paired (manual)": "ok",
    "invalid code": "error", "invalid url": "error", "rate limited": "error", "manual pairing needed": "error", error: "error",
  });
  await context.close();
});

test("any other status text is neutral, never an error, whatever it says", async () => {
  const { page, context } = await open();
  const got = await inPage(page, (m) => {
    const texts = ["", "  ", "Listening...", "Connected", "failed hard", "error!", "constructor", "__proto__", "toString", null, undefined];
    return texts.map((t) => [m.describeMic(t), m.describeConn(t), m.describePair(t)].map((d) => (typeof d === "string" ? d : (d.tone ?? `${d.mic.tone}/${d.model.tone}/${d.banner}`))));
  });
  for (const row of got) assert.deepEqual(row, ["neutral/neutral/null", "neutral", "neutral"]);
  await context.close();
});

test("the head script and the module agree on the theme and its icons for every saved value", async () => {
  for (const saved of [undefined, "zeroclaw", "shiza", "SHIZA", "dark", ""]) {
    // The head script alone: the module is blocked, so only index.html's inline script has run.
    const head = await (async () => {
      const { page, context } = await open({ saved, block: ["**/src/ui/theme.ts", "**/src/main.ts"] });
      await page.waitForLoadState("domcontentloaded");
      const r = { theme: await theme(page), icons: await icons(page) };
      await context.close();
      return r;
    })();
    const { page, context } = await open({ saved });
    const expected = await inPage(page, (m, s) => { const t = m.parseTheme(s ?? null); return { theme: t, icons: [m.themeIcon(t, 32), m.themeIcon(t, 180)] }; }, saved ?? null);
    await context.close();
    assert.deepEqual(head, expected, `saved ${JSON.stringify(saved)}`);
  }
});

test("a first visit is zeroclaw with the zeroclaw icon; the switch flips both, saves, and a reload keeps it", async () => {
  const { page, context, errors } = await open();
  assert.equal(await theme(page), "zeroclaw");
  assert.deepEqual(await icons(page), ["/brand/favicon-zeroclaw-32.png", "/brand/favicon-zeroclaw-180.png"]);
  const sw = page.locator("#theme-switch");
  assert.equal(await sw.getAttribute("role"), "switch");
  assert.equal(await sw.getAttribute("aria-checked"), "false");

  await sw.click();
  assert.equal(await theme(page), "shiza");
  assert.deepEqual(await icons(page), ["/brand/favicon-shiza-32.png", "/brand/favicon-shiza-180.png"]);
  assert.equal(await sw.getAttribute("aria-checked"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("theme")), "shiza");

  await page.reload();
  await page.waitForFunction(() => document.getElementById("theme-switch").getAttribute("aria-checked") === "true");
  assert.equal(await theme(page), "shiza");
  assert.deepEqual(await icons(page), ["/brand/favicon-shiza-32.png", "/brand/favicon-shiza-180.png"]);

  await sw.click();
  assert.equal(await theme(page), "zeroclaw");
  assert.equal(await page.evaluate(() => localStorage.getItem("theme")), "zeroclaw");
  assert.deepEqual(errors, []);
  await context.close();
});

test("with storage that throws, the page is zeroclaw and the switch still works for the visit", async () => {
  const { page, context, errors } = await open({ brokenStorage: true });
  assert.equal(await theme(page), "zeroclaw");
  await page.locator("#theme-switch").click();
  assert.equal(await theme(page), "shiza");
  // main.ts reads localStorage unguarded at load (loadSavedTokenForCurrentUrl), so it throws here as it did before the themes;
  // that is not the theme module's, which must throw nothing.
  assert.deepEqual(errors.filter((e) => e.includes("/src/ui/theme")), []);
  await context.close();
});

test("one DOM: every id appears once and every id main.ts looks up exists", async () => {
  const { page, context } = await open();
  const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((e) => e.id));
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  const wanted = [...MAIN.matchAll(/\$(?:<[^>]+>)?\("([\w-]+)"\)/g)].map((m) => m[1]);
  assert.ok(wanted.length > 20, `read ${wanted.length} ids from main.ts`);
  assert.deepEqual(wanted.filter((id) => !ids.includes(id)), []);
  await context.close();
});

test("the mic button keeps its label and a real, clickable box in both themes", async () => {
  for (const saved of ["zeroclaw", "shiza"]) {
    const { page, context } = await open({ saved });
    const btn = page.locator("#mic-btn");
    assert.equal((await btn.textContent()).trim(), "Start listening");
    const box = await btn.boundingBox();
    assert.ok(box && box.width >= 100 && box.height >= 100, `${saved}: ${JSON.stringify(box)}`);
    assert.equal(await btn.isDisabled(), true); // until the model is ready, exactly as before
    await context.close();
  }
});

test("derived state: the health rows, the banner and the data attributes follow the status pills, and unknown text is neutral", async () => {
  const { page, context } = await open();
  const set = (id, text, kind) => page.evaluate(([i, t, k]) => { const e = document.getElementById(i); e.textContent = t; if (k) e.className = `status status-${k}`; }, [id, text, kind]);
  const row = (name) => page.evaluate((n) => { const li = document.querySelector(`.health-row[data-row="${n}"]`); return [li.dataset.tone, li.querySelector(".health-badge").textContent, li.querySelector(".health-sub").textContent]; }, name);
  const banner = () => page.evaluate(() => [document.getElementById("model-banner").hidden, document.getElementById("model-banner-title").textContent, document.getElementById("banner-connect").hidden]);
  const attrs = () => page.evaluate(() => { const d = document.documentElement.dataset; return [d.mic, d.model, d.conn, d.pair]; });

  assert.deepEqual(await banner(), [false, "Speech model not loaded", false]);
  assert.deepEqual(await attrs(), ["disabled", "warn", "warn", "warn"]);

  await set("conn-status", "connected", "ok");
  await set("pair-status", "paired (saved token)", "ok");
  await set("mic-status", "ready", "ok");
  await page.evaluate(() => { document.getElementById("mic-btn").disabled = false; });
  await page.waitForFunction(() => document.documentElement.dataset.mic === "ready");
  assert.deepEqual(await attrs(), ["ready", "ok", "ok", "ok"]);
  assert.deepEqual(await banner(), [true, "Speech model not loaded", true]);
  assert.deepEqual(await row("socket"), ["ok", "OK", "connected"]);
  assert.deepEqual(await row("model"), ["ok", "OK", "ready"]);
  assert.deepEqual(await row("mic"), ["idle", "IDLE", ""]);

  await set("mic-status", "listening…", "ok");
  await page.evaluate(() => { document.getElementById("mic-btn").textContent = "Stop listening"; });
  await page.waitForFunction(() => document.documentElement.dataset.mic === "listening");
  assert.deepEqual(await row("mic"), ["ok", "LIVE", ""]);

  await set("mic-status", "a status text nobody has seen", "error");
  await page.waitForFunction(() => document.documentElement.dataset.model === "neutral");
  assert.deepEqual(await row("model"), ["neutral", "N/A", "a status text nobody has seen"]);
  assert.deepEqual(await row("mic"), ["neutral", "N/A", ""]);

  await page.evaluate(() => { const n = document.getElementById("env-note"); n.textContent = "no speech here"; n.hidden = false; });
  await page.waitForFunction(() => document.querySelector('.health-row[data-row="speech"]').dataset.tone === "warn");
  assert.deepEqual(await row("speech"), ["warn", "OFF", "no speech here"]);
  await context.close();
});

test("the banner's Connect presses the real Connect button, one code path", async () => {
  const { page, context } = await open();
  await page.evaluate(() => {
    window.__connectClicks = 0;
    document.getElementById("connect-btn").addEventListener("click", (e) => { e.stopImmediatePropagation(); window.__connectClicks++; }, true);
  });
  await page.locator("#banner-connect").click();
  assert.equal(await page.evaluate(() => window.__connectClicks), 1);
  await context.close();
});

test("at 480px neither theme scrolls sideways, and the switch, mic and cards are all reachable", async () => {
  for (const saved of ["zeroclaw", "shiza"]) {
    const { page, context } = await open({ saved, width: 480 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(over, 0, `${saved}: ${over}px of horizontal overflow`);
    for (const sel of ["#theme-switch", "#mic-btn", "#pair-btn", "#connect-btn", "#log"]) {
      const box = await page.locator(sel).boundingBox();
      assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= 481, `${saved} ${sel}: ${JSON.stringify(box)}`);
    }
    await context.close();
  }
});

test("reduced motion stops the status dot's pulse and the ZeroClaw mic rings; without it they run", async () => {
  const pulse = (page) => page.evaluate(() => {
    document.getElementById("conn-status").className = "status status-ok";
    document.documentElement.dataset.mic = "listening";
    return [getComputedStyle(document.getElementById("conn-status"), "::before").animationName, getComputedStyle(document.querySelector(".mic-stage"), "::before").animationName];
  });
  for (const [reduced, expected] of [[false, ["dot-pulse", "ring"]], [true, ["none", "none"]]]) {
    const { page, context } = await open({ saved: "zeroclaw", reduced });
    assert.deepEqual(await pulse(page), expected, `reduced=${reduced}`);
    await context.close();
  }
});

test("index.html keeps the eval download button's markup that vite.config.js strips from production builds", () => {
  assert.match(HTML, /\s*<button id="eval-download-btn"[\s\S]*?<\/button>/);
});

// --- canvases (the SHIZA theme's sky and pollen) ---

const frames = (page) => page.evaluate(() => window.__raf);
const canvasMode = (page) => page.evaluate(() => document.documentElement.dataset.canvas);
const drawn = (page, sel) => page.evaluate((q) => { const c = document.querySelector(q); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let a = 0; for (let i = 3; i < d.length; i += 4) a += d[i]; return { w: c.width, h: c.height, alpha: a }; }, sel);
async function settled(page, ms = 400) { const before = await frames(page); await page.waitForTimeout(ms); return (await frames(page)) - before; }
const hideTab = (page, hidden) => page.evaluate((h) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => h }); document.dispatchEvent(new Event("visibilitychange")); }, hidden);

test("canvases: the ZeroClaw theme requests no animation frames and shows no canvas", async () => {
  const { page, context } = await open({ saved: "zeroclaw" });
  assert.equal(await canvasMode(page), "stopped");
  assert.equal(await settled(page), 0);
  for (const sel of [".sky", ".pollen"]) assert.equal(await page.evaluate((q) => getComputedStyle(document.querySelector(q)).display, sel), "none");
  await context.close();
});

test("canvases: the SHIZA theme draws the sky and the pollen, and switching back stops all frames", async () => {
  const { page, context, errors } = await open({ saved: "shiza" });
  assert.equal(await canvasMode(page), "running");
  assert.ok((await settled(page)) > 5, "frames are being requested");
  const sky = await drawn(page, ".sky");
  const pollen = await drawn(page, ".pollen");
  assert.ok(sky.alpha > 0 && pollen.alpha > 0, "both canvases have pixels");
  assert.deepEqual([sky.w > 0, sky.h > 0], [true, true]);

  await page.locator("#theme-switch").click();
  assert.equal(await canvasMode(page), "stopped");
  assert.equal(await settled(page), 0);
  await page.locator("#theme-switch").click();
  assert.equal(await canvasMode(page), "running");
  assert.ok((await settled(page)) > 5);
  assert.deepEqual(errors, []);
  await context.close();
});

test("canvases: a hidden tab stops all frames and a visible one resumes them", async () => {
  const { page, context } = await open({ saved: "shiza" });
  assert.ok((await settled(page)) > 5);
  await hideTab(page, true);
  assert.equal(await canvasMode(page), "stopped");
  assert.equal(await settled(page), 0);
  await hideTab(page, false);
  assert.equal(await canvasMode(page), "running");
  assert.ok((await settled(page)) > 5);
  await context.close();
});

test("canvases: with reduced motion there is one still frame and no animation frames, redrawn when the state changes", async () => {
  const { page, context } = await open({ saved: "shiza", reduced: true });
  assert.equal(await canvasMode(page), "static");
  assert.equal(await settled(page), 0);
  const still = await drawn(page, ".pollen");
  assert.ok(still.alpha > 0 && (await drawn(page, ".sky")).alpha > 0);

  const enable = (listening) => page.evaluate((l) => { document.getElementById("mic-btn").disabled = false; document.getElementById("mic-btn").textContent = l ? "Stop listening" : "Start listening"; }, listening);
  await enable(false);
  await page.waitForFunction(() => document.documentElement.dataset.mic === "ready");
  const ready = await drawn(page, ".pollen");
  await enable(true);
  await page.waitForFunction(() => document.documentElement.dataset.mic === "listening");
  const listening = await drawn(page, ".pollen");
  assert.ok(still.alpha < ready.alpha, `disabled ${still.alpha} is dimmer than ready ${ready.alpha}`);
  assert.ok(ready.alpha < listening.alpha, `ready ${ready.alpha} is dimmer than listening ${listening.alpha}`);
  assert.equal(await settled(page), 0);
  await context.close();
});

test("canvases: the pollen is the mic button, no second path: the canvas ignores the pointer and a click lands on #mic-btn", async () => {
  const { page, context } = await open({ saved: "shiza" });
  await page.evaluate(() => {
    const b = document.getElementById("mic-btn");
    b.disabled = false;
    window.__micClicks = 0;
    b.addEventListener("click", (e) => { e.stopImmediatePropagation(); window.__micClicks++; }, true);
  });
  const stage = await page.locator(".mic-stage").boundingBox();
  const x = stage.x + stage.width / 2;
  const y = stage.y + stage.height / 2;
  assert.equal(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.id, [x, y]), "mic-btn");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".pollen")).pointerEvents), "none");
  await page.mouse.click(x, y);
  assert.equal(await page.evaluate(() => window.__micClicks), 1);
  await context.close();
});

// --- the level meter, driven by the two window events directly (main.ts's side is mic-stream.test.mjs) ---

test("meter: a stream that cannot be measured is ignored; a hidden tab or the ZeroClaw theme closes the meter, a visible SHIZA page reopens it", async () => {
  const { page, context, errors } = await open({ saved: "shiza" });
  await page.mouse.click(5, 5); // a user gesture, so the page's audio contexts may start
  await page.evaluate(() => {
    window.__ctxs = [];
    const Native = window.AudioContext;
    window.AudioContext = class extends Native { constructor(...a) { super(...a); window.__ctxs.push(this); } };
    const c = new Native();
    const d = c.createMediaStreamDestination();
    const o = c.createOscillator();
    o.connect(d);
    o.start();
    window.__stream = d.stream;
  });
  const open_ = () => page.evaluate(() => window.__ctxs.filter((c) => c.state !== "closed").length);

  // not a MediaStream, like the harness's stub
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("mic-stream", { detail: { stream: { getAudioTracks: () => [] } } })));
  await page.waitForTimeout(150);
  assert.equal(await open_(), 0, "nothing left open for a stream it cannot read");

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("mic-stream", { detail: { stream: window.__stream } })));
  await page.waitForFunction(() => window.__ctxs.some((c) => c.state !== "closed"));
  assert.equal(await open_(), 1);

  await hideTab(page, true);
  await page.waitForFunction(() => window.__ctxs.every((c) => c.state === "closed"));
  await hideTab(page, false);
  await page.waitForFunction(() => window.__ctxs.some((c) => c.state !== "closed"));
  assert.equal(await open_(), 1, "reopened on the same stream");

  await page.locator("#theme-switch").click(); // to ZeroClaw
  await page.waitForFunction(() => window.__ctxs.every((c) => c.state === "closed"));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("mic-stream-end")));
  assert.equal(await open_(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
