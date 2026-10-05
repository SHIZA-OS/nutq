// package.json matches what the shipped code imports: every bare import under src/ is a dependency (not a devDependency, which
// a production install would skip), and every dependency is imported by something under src/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./vite-server.mjs";

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : []));

export const imported = (sources) => {
  const out = new Set();
  for (const s of sources) {
    for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'\n;]*?\bfrom\s*["']([^"'.][^"']*)["']|(?:^|\n)\s*import\s*["']([^"'.][^"']*)["']|\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      out.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
  return out;
};

const used = imported(files(join(REPO, "src")).map((f) => readFileSync(f, "utf8")));

test("every package src/ imports is a dependency", () => {
  assert.deepEqual([...used].filter((p) => !(p in (pkg.dependencies ?? {}))).sort(), []);
});

test("every dependency is imported by src/", () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).filter((p) => !used.has(p)).sort(), []);
});

test("the import scanner finds the forms in use", () => {
  const found = imported([`import * as ort from "onnxruntime-web";\nimport { A } from "@scope/pkg/sub";\nimport "side-effect";\nconst m = await import("lazy");\nimport x from "./local";\nexport { y } from "re-export";`]);
  assert.deepEqual([...found].sort(), ["@scope/pkg", "lazy", "onnxruntime-web", "re-export", "side-effect"]);
});
