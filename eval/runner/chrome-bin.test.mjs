// Every browser launch reads the Chrome path from CHROME_BIN and falls back to /usr/bin/google-chrome; none hard-codes the path alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./vite-server.mjs";

export const bare = (src) => src.split("\n").flatMap((line, i) => (line.includes("/usr/bin/google-chrome") && !/process\.env\.CHROME_BIN \|\| "\/usr\/bin\/google-chrome"/.test(line) && !line.trim().startsWith("//") ? [i + 1] : []));

test("no eval file hard-codes the Chrome path alone", () => {
  const dir = join(REPO, "eval/runner");
  const found = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && f !== "chrome-bin.test.mjs")
    .flatMap((f) => bare(readFileSync(join(dir, f), "utf8")).map((n) => `${f}:${n}`));
  assert.deepEqual(found, []);
});

test("the check flags a bare path and accepts the env form", () => {
  assert.deepEqual(bare('a\nconst C = "/usr/bin/google-chrome";\nconst D = process.env.CHROME_BIN || "/usr/bin/google-chrome";\n// /usr/bin/google-chrome'), [2]);
});
