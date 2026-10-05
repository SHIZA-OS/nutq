// Tests src/speech-text.ts, the reply-to-speakable-text cleaner and the reply prefixes, in a headless Chrome page served
// by Vite (the real module, no copy of the logic here). Runs with the rest of the suite via `npm test`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { makeTempDir, startVite } from "./vite-server.mjs";

let context;
let vite;
let r;

// Input text to the expected speakable text, one row per rule. Checked in the page, compared here.
const CASES = [
  ["plain text is unchanged", "Hello there. How are you?", "Hello there. How are you?"],
  ["bold, italic, double underscore and underscore emphasis lose their markers", "This is **very** important and *quite* odd and __also__ _this_.", "This is very important and quite odd and also this."],
  ["snake_case words keep their underscores", "Set my_var_name to one.", "Set my_var_name to one."],
  ["a heading loses its hashes and ends like a sentence", "# Title\nSome text here.", "Title. Some text here."],
  ["bullet markers go and each item is its own sentence", "- First item\n* Second item\n+ Third item\n• Fourth item", "First item. Second item. Third item. Fourth item."],
  ["number markers go", "1. Open it\n2) Close it", "Open it. Close it."],
  ["a decimal at the start of a line is not a list marker", "3.5 million is a lot.", "3.5 million is a lot."],
  ["inline code keeps its words and loses the backticks", "Run `npm test` now.", "Run npm test now."],
  ["a fenced code block is not read out", "Before.\n```js\nconst a = 1;\n```\nAfter.", "Before. After."],
  ["a link keeps its label, an image its alt text", "See [the docs](https://example.com/docs) now. ![a chart](x.png)", "See the docs now. a chart."],
  ["bare URLs are dropped and the punctuation around them is tidied", "Visit https://example.com/page, then www.foo.org/x for more.", "Visit, then for more."],
  ["a table becomes one sentence per row, the separator row is dropped", "| Name | Age |\n|---|---|\n| Ann | 30 |", "Name, Age. Ann, 30."],
  ["a horizontal rule is dropped", "Above.\n---\nBelow.", "Above. Below."],
  ["a block quote loses its marker", "> Quoted line", "Quoted line."],
  ["emoji are dropped", "Great job 🎉👍 team ✅", "Great job team."],
  [". , ? ! : ; are kept", "Wait, what? Yes: ok; fine!", "Wait, what? Yes: ok; fine!"],
  ["a line that already ends in : keeps it, others get a full stop", "Ingredients:\nEggs\nMilk", "Ingredients: Eggs. Milk."],
  ["HTML tags are dropped", "A <b>bold</b> move.", "A bold move."],
  ["a stray unpaired marker is dropped", "**First. Second.", "First. Second."],
  ["blank lines between paragraphs make no extra pause text", "One.\n\nTwo.", "One. Two."],
  ["Arabic text with its own question mark is left alone", "مرحبا بك. كيف حالك؟", "مرحبا بك. كيف حالك؟"],
  ["a closing quote after the full stop counts as the end", 'He said "go."', 'He said "go."'],
  ["an em dash with spaces becomes a comma pause", "Tests pass \u2014 unit and e2e.", "Tests pass, unit and e2e."],
  ["an en dash or an em dash with no spaces does too", "A\u2014B and then C\u2013D", "A, B and then C, D."],
  ["a dash between two numbers is 'to', spaced or not", "Pages 10\u201320 and 5 \u2014 7 and 1990\u20132000\u20132010.", "Pages 10 to 20 and 5 to 7 and 1990 to 2000 to 2010."],
  ["a dash next to a number on one side only keeps the comma rule", "Page 5 \u2014 see 7 or $5\u2013$10 or 5\u2013ish or later \u2014 7 more", "Page 5, see 7 or $5, $10 or 5, ish or later, 7 more."],
  ["a dash next to a comma does not double it", "Hello, \u2014 world.", "Hello, world."],
  ["a dash after a full stop leaves the full stop alone", "He stopped. \u2014 Then left.", "He stopped. Then left."],
  ["a dash before closing punctuation, at the start or at the end of a line is dropped", "Wait \u2014.\n\u2014 leading and trailing \u2014", "Wait. leading and trailing."],
  ["a hyphen is not a dash", "A well-known fact.", "A well-known fact."],
  ["only a code block, a rule, markers or whitespace leaves nothing", "```\ncode\n```", ""],
  ["whitespace only", "   \n  ", ""],
  ["a rule only", "---", ""],
  ["markers only", "**", ""],
];

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-speechtext-"), {
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(vite.url);
  r = await page.evaluate(async (cases) => {
    const { speakable } = await import("/src/speech-text.ts");
    const out = {};
    out.cases = cases.map(([, input]) => speakable(input).text);
    // A code fence that spans two streamed units: the second call is told it starts inside code.
    const a = speakable("Look:\n```bash\nnpm i");
    const b = speakable("npm run build\n```\nDone now.", a.inCode);
    out.fence = { a, b };
    out.fenceClosedWhole = speakable("Before.\n```\ncode\n```\nAfter.").inCode;
    // Cleaning twice gives the same text as cleaning once.
    const sample = "# Title\n- **One** item with `code` and [a link](http://x.y)\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nx\n```\nEnd 🎉";
    out.idempotent = [speakable(sample).text, speakable(speakable(sample).text).text];
    const { replyPrefix } = await import("/src/speech-text.ts");
    out.prefix = { none: replyPrefix(null), empty: replyPrefix(""), short: replyPrefix("short"), voice: replyPrefix("voice"), upper: replyPrefix("VOICE"), shortUpper: replyPrefix("SHORT"), other: replyPrefix("loud") };
    return out;
  }, CASES);
});

after(async () => {
  await context?.close();
  vite?.child.kill();
});

for (const [i, [name, input, expected]] of CASES.entries()) {
  test(`speakable: ${name}`, () => assert.equal(r.cases[i], expected, JSON.stringify(input)));
}

test("speakable: a code fence can span streamed units; the caller carries inCode from one call to the next", () => {
  assert.deepEqual(r.fence.a, { text: "Look:", inCode: true });
  assert.deepEqual(r.fence.b, { text: "Done now.", inCode: false });
  assert.equal(r.fenceClosedWhole, false);
});

test("speakable: cleaning cleaned text again changes nothing", () => {
  assert.equal(r.idempotent[0], r.idempotent[1]);
});

// The prefix the eval runs before ?reply= existed were sent with. Pinned byte for byte so those runs stay reproducible.
const OLD_PREFIX = "Respond in 1-2 short, complete sentences, suitable for being spoken aloud. Be concise but don't cut off mid-thought.\n\n";

test("replyPrefix: ?reply=short is the opt-out and is byte-identical to the original prefix", () => {
  assert.deepEqual(r.prefix.short, { style: "short", prefix: OLD_PREFIX });
});

test("replyPrefix: voice is the default: anything but exactly short (nothing, empty, other text, other case) is voice", () => {
  for (const k of ["none", "empty", "voice", "upper", "shortUpper", "other"]) assert.equal(r.prefix[k].style, "voice", k);
  assert.deepEqual(r.prefix.none, r.prefix.voice);
});

test("replyPrefix: the voice style asks for a thorough spoken answer with spoken signposts, no padding, no markup", () => {
  const { style, prefix } = r.prefix.voice;
  assert.equal(style, "voice");
  assert.ok(prefix.endsWith("\n\n"));
  assert.match(prefix, /do not shorten it to be brief, but do not pad it either: no restating the question, no filler, stop when the answer is complete\./);
  assert.match(prefix, /no markdown at all/);
  assert.match(prefix, /tables, code blocks, dashes or emojis/);
  assert.match(prefix, /Never say a URL/);
  assert.match(prefix, /First, \.\.\. Second, \.\.\. Third, \.\.\./);
  assert.ok(!prefix.includes("\u2014"), "no em dash");
});
