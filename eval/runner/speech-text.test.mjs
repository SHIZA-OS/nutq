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
  ["only a code block, a rule, markers or whitespace leaves nothing", "```\ncode\n```", ""],
  ["whitespace only", "   \n  ", ""],
  ["a rule only", "---", ""],
  ["markers only", "**", ""],
];

before(async () => {
  vite = await startVite();
  context = await chromium.launchPersistentContext(makeTempDir("nutq-speechtext-"), {
    executablePath: "/usr/bin/google-chrome",
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
