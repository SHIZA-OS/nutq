// House rules for what is committed, checked mechanically: no em dash anywhere, no token that looks real, and every relative
// link in the markdown files points at a file that exists. public/vendor holds third-party license and notice files kept
// verbatim, so it is exempt from the em dash rule (ONNX Runtime's ThirdPartyNotices.txt contains one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO } from "./vite-server.mjs";

const DASH = String.fromCharCode(0x2014); // written as a code so this file has no em dash itself

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
  .split("\0")
  .filter((p) => p && existsSync(join(REPO, p)) && !/\.(onnx|wasm|woff2)$/.test(p) && p !== "package-lock.json");
const text = new Map(tracked.map((p) => [p, readFileSync(join(REPO, p), "utf8")]));

export const emDashes = (files) => [...files].filter(([p, t]) => !p.startsWith("public/vendor/") && t.includes(DASH)).map(([p]) => p);
export const tokens = (files) => [...files].filter(([, t]) => /zc_[0-9a-f]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}/.test(t)).map(([p]) => p);
export const brokenLinks = (files) => {
  const out = [];
  for (const [p, t] of files) {
    if (!p.endsWith(".md")) continue;
    for (const m of t.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (target && !existsSync(join(REPO, dirname(p), target))) out.push(`${p}: ${m[1]}`);
    }
  }
  return out;
};

test("no em dash in any committed text file", () => assert.deepEqual(emDashes(text), []));
test("no token that looks real in any committed file", () => assert.deepEqual(tokens(text), []));
test("every relative markdown link resolves", () => assert.deepEqual(brokenLinks(text), []));

test("the checks themselves catch what they are for", () => {
  assert.deepEqual(emDashes(new Map([["a.md", `one ${DASH} two`], ["public/vendor/x.txt", DASH]])), ["a.md"]);
  assert.deepEqual(tokens(new Map([["a.md", `token zc_${"a1".repeat(32)}`], ["b.md", "zc_<64 hex>"]])), ["a.md"]);
  assert.deepEqual(brokenLinks(new Map([["README.md", "[x](docs/NOPE.md) [y](LICENSE) [z](https://e.com) [w](#a)"]])), ["README.md: docs/NOPE.md"]);
});
