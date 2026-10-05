// Tests src/sentence-splitter.ts, the streamed-reply sentence splitter, in a headless Chrome page served by Vite
// (the real module, no copy of the logic here). Runs with the rest of the suite via `npm test`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-splitter-"), {
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async () => {
    const { SentenceSplitter } = await import("/src/sentence-splitter.ts");
    // What each delta closed, then what flush() returned.
    const run = (deltas) => {
      const s = new SentenceSplitter();
      return { pushes: deltas.map((d) => s.push(d)), flush: s.flush() };
    };
    const all = (x) => [...x.pushes.flat(), ...x.flush];
    const chunked = (text, n) => {
      const parts = [];
      for (let i = 0; i < text.length; i += n) parts.push(text.slice(i, i + n));
      return parts;
    };
    const out = {};

    out.bigChunk = run(["This is the first sentence. This is the second one! Is this the third?"]);
    out.midWord = run(["This is the fir", "st sentence. Thi", "s is the second", " one. Tail"]);
    out.midNumber = run(["The price is 3.", "5 dollars today. Next one is longer"]);
    out.dotStartsDelta = run(["Version 3", ".5 is out now for all. ok"]);
    out.abbreviations = run(["Dr. Smith met Mr. Jones in the U.S. yesterday, e.g. at noon, i.e. late, vs. early. Then they left the building."]);
    out.abbreviationsMore = run(["Mrs. Khan asked Ms. Ali to call Dr. Rahman. Fine then ok."]);
    out.abbreviationCase = run(["DR. Khan and mrs. Ali arrived on time today. Done now please"]);
    out.openingBracket = run(["Use a tool (e.g. a hammer) for the job today. Next up"]);
    out.merge = run(["Hi. Yes. This one is long enough to stand. Bye. "]);
    out.shortOnly = run(["OK."]);
    out.exactly20 = run(["a".repeat(19) + ". "]);
    out.nineteen = run(["a".repeat(18) + ". ", "b".repeat(19) + ". "]);
    out.noTerminator = run(["No terminator here at all"]);
    out.whitespaceOnly = run(["   "]);
    out.quote = run(['He said "Go home now." Then left the room today. ']);
    out.run = run(["Really now, is that true?! Yes it is, truly. "]);
    out.ellipsis = run(["Well... I think so today. "]);

    // A newline closes a unit too, so list items without a full stop are not one sentence.
    out.bullets = run(["- Eggs and a dozen more\n- Milk and some bread too\n"]);
    out.shortLines = run(["Eggs\nMilk\nBread and butter and jam\n"]);
    out.blankLines = run(["First line is long enough here.\n\n\nSecond line is long enough too.\n"]);
    out.blankAfterHeld = run(["Eggs\n\n\nMilk and bread and butter\n"]);
    out.stopThenNewline = run(["Done with this step now.\nNext"]);
    out.heldNewlineFlush = run(["Eggs\n"]);
    const listText = "Intro line that is long enough.\n- Eggs and a dozen more\n- Milk\n- Bread and butter and jam\n\nLast paragraph has no end";
    const listWhole = all(run([listText]));
    out.newlineChunking = { whole: listWhole, same: [1, 2, 3, 5, 7, 11].map((n) => JSON.stringify(all(run(chunked(listText, n)))) === JSON.stringify(listWhole)) };

    // pendingChars: the text the splitter holds that has not come out (an unfinished sentence and short closed ones).
    const pend = new SentenceSplitter();
    out.pending = [pend.pendingChars];
    pend.push("Partial text with no end");
    out.pending.push(pend.pendingChars);
    pend.push(" yet. Hi. ok");
    out.pending.push(pend.pendingChars); // "Hi." is held (3) and "ok" is unfinished (2)
    pend.reset();
    out.pending.push(pend.pendingChars);

    // Flush clears the state, and so does reset().
    const s = new SentenceSplitter();
    s.push("Partial text with no end");
    out.flushOnce = s.flush();
    out.flushTwice = s.flush();
    s.push("Held. And a partial tail");
    s.reset();
    out.afterReset = s.flush();
    out.reusable = [s.push("A fresh sentence follows here. "), s.flush()];

    // However the deltas are cut, the sentences are the same as from one chunk.
    const text = 'Dr. Smith said "Go home now." Version 3.5 costs $4.25 today! Is that fine?! Well... yes. U.S. rules apply, e.g. here. The last one has no end';
    const whole = all(run([text]));
    out.chunking = { whole, same: [1, 2, 3, 5, 7, 11].map((n) => JSON.stringify(all(run(chunked(text, n)))) === JSON.stringify(whole)) };

    // Unicode: Arabic, emoji (a surrogate pair cut between two deltas), mixed scripts. No crash, no lost text.
    const arabic = "مرحبا بك في نطق. كيف حالك اليوم؟ أنا بخير شكرا لك. ";
    out.arabic = { all: all(run(chunked(arabic, 3))), arabicText: arabic.trim() };
    const emoji = "Great job everyone 👋 that was nice. 😀 Next sentence is right here. ";
    const cut = emoji.indexOf("👋") + 1; // between the two halves of the pair
    out.emoji = { all: all(run([emoji.slice(0, cut), emoji.slice(cut)])), emojiText: emoji.trim() };
    out.mixed = all(run(["日本語のテキスト。 English follows the line here. Ça va très bien aujourd'hui. "]));
    return out;
  });
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

test("a reply that arrives as one big chunk closes all its sentences at once; the unterminated end waits for flush", () => {
  assert.deepEqual(r.bigChunk.pushes, [["This is the first sentence.", "This is the second one!"]]);
  assert.deepEqual(r.bigChunk.flush, ["Is this the third?"]);
});

test("deltas split mid-word: a sentence closes only once its terminator and the whitespace after it have arrived", () => {
  assert.deepEqual(r.midWord.pushes, [[], ["This is the first sentence."], [], ["This is the second one."]]);
  assert.deepEqual(r.midWord.flush, ["Tail"]);
});

test("a number split across deltas stays whole: 3.5 is not a sentence end", () => {
  assert.deepEqual(r.midNumber.pushes, [[], ["The price is 3.5 dollars today."]]);
  assert.deepEqual(r.midNumber.flush, ["Next one is longer"]);
  assert.deepEqual(r.dotStartsDelta.pushes, [[], ["Version 3.5 is out now for all."]]);
  assert.deepEqual(r.dotStartsDelta.flush, ["ok"]);
});

test("Dr. Mr. Mrs. Ms. e.g. i.e. vs. U.S. do not end a sentence, whatever their case", () => {
  assert.deepEqual(r.abbreviations.pushes, [["Dr. Smith met Mr. Jones in the U.S. yesterday, e.g. at noon, i.e. late, vs. early."]]);
  assert.deepEqual(r.abbreviations.flush, ["Then they left the building."]);
  assert.deepEqual(r.abbreviationsMore.pushes, [["Mrs. Khan asked Ms. Ali to call Dr. Rahman."]]);
  assert.deepEqual(r.abbreviationsMore.flush, ["Fine then ok."]);
  assert.deepEqual(r.abbreviationCase.pushes, [["DR. Khan and mrs. Ali arrived on time today."]]);
  assert.deepEqual(r.openingBracket.pushes, [["Use a tool (e.g. a hammer) for the job today."]]);
});

test("a fragment under 20 characters is merged into the next sentence; exactly 20 stands alone", () => {
  assert.deepEqual(r.merge.pushes, [["Hi. Yes. This one is long enough to stand."]]);
  assert.deepEqual(r.merge.flush, ["Bye."]);
  assert.deepEqual(r.exactly20.pushes, [["a".repeat(19) + "."]]);
  assert.deepEqual(r.nineteen.pushes, [[], ["a".repeat(18) + ". " + "b".repeat(19) + "."]]);
  assert.deepEqual(r.shortOnly, { pushes: [[]], flush: ["OK."] });
});

test("flush returns the tail even without a terminator, and anything still held; then the splitter is empty", () => {
  assert.deepEqual(r.noTerminator, { pushes: [[]], flush: ["No terminator here at all"] });
  assert.deepEqual(r.whitespaceOnly, { pushes: [[]], flush: [] });
  assert.deepEqual(r.flushOnce, ["Partial text with no end"]);
  assert.deepEqual(r.flushTwice, []);
});

test("reset drops what is buffered and held; the splitter is reusable", () => {
  assert.deepEqual(r.afterReset, []);
  assert.deepEqual(r.reusable, [["A fresh sentence follows here."], []]);
});

test("closing quotes, runs like ?! and ellipses close a sentence correctly", () => {
  assert.deepEqual(r.quote.pushes, [['He said "Go home now."', "Then left the room today."]]);
  assert.deepEqual(r.run.pushes, [["Really now, is that true?!"]]);
  assert.deepEqual(r.run.flush, ["Yes it is, truly."]);
  assert.deepEqual(r.ellipsis.pushes, [["Well... I think so today."]]);
});

test("however the deltas are cut (1 to 11 characters), the sentences are the same as from one chunk", () => {
  assert.deepEqual(r.chunking.whole, [
    'Dr. Smith said "Go home now."',
    "Version 3.5 costs $4.25 today!",
    "Is that fine?! Well...",
    "yes. U.S. rules apply, e.g. here.",
    "The last one has no end",
  ]);
  assert.deepEqual(r.chunking.same, [true, true, true, true, true, true]);
});

test("Unicode text does not crash and loses nothing: Arabic, an emoji cut between its surrogate halves, mixed scripts", () => {
  assert.equal(r.arabic.all.join(" "), r.arabic.arabicText);
  assert.equal(r.emoji.all.join(" "), r.emoji.emojiText);
  assert.equal(r.mixed.join(" "), "日本語のテキスト。 English follows the line here. Ça va très bien aujourd'hui.");
});

test("a newline closes a unit: list items without a full stop are separate", () => {
  assert.deepEqual(r.bullets.pushes, [["- Eggs and a dozen more", "- Milk and some bread too"]]);
  assert.deepEqual(r.stopThenNewline.pushes, [["Done with this step now."]]);
  assert.deepEqual(r.stopThenNewline.flush, ["Next"]);
});

test("short lines are merged as before but keep their line break, so each is still its own line for the cleaner", () => {
  assert.deepEqual(r.shortLines.pushes, [["Eggs\nMilk\nBread and butter and jam"]]);
  assert.deepEqual(r.heldNewlineFlush, { pushes: [[]], flush: ["Eggs"] });
});

test("blank lines produce no unit", () => {
  assert.deepEqual(r.blankLines.pushes, [["First line is long enough here.", "Second line is long enough too."]]);
  assert.deepEqual(r.blankAfterHeld.pushes, [["Eggs\nMilk and bread and butter"]]);
});

test("with newlines in the text, however the deltas are cut, the units are the same as from one chunk", () => {
  assert.deepEqual(r.newlineChunking.whole, [
    "Intro line that is long enough.",
    "- Eggs and a dozen more",
    "- Milk\n- Bread and butter and jam",
    "Last paragraph has no end",
  ]);
  assert.deepEqual(r.newlineChunking.same, [true, true, true, true, true, true]);
});

test("pendingChars is the length of the unfinished text plus the short sentences held, and 0 after reset", () => {
  assert.deepEqual(r.pending, [0, 24, 5, 0]);
});
