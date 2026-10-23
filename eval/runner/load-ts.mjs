// Imports a src/ TypeScript module in Node, for tests of modules that touch no browser API (no Chrome, no Vite). The module and the
// relative modules it imports are compiled with the typescript devDependency into a temp dir that is removed on exit.
// ponytail: relative imports only, found by regex; no path aliases or non-TS imports. Node >=22.18 strips types itself, then drop this.

import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "./vite-server.mjs";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const OUT = makeTempDir("nutq-ts-");
const OPTIONS = { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } };

function compile(name) {
  const dest = join(OUT, `${name}.mjs`);
  if (existsSync(dest)) return dest;
  const js = ts.transpileModule(readFileSync(join(SRC, `${name}.ts`), "utf8"), OPTIONS).outputText;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, js); // written before its imports are compiled, so an import cycle stops here
  writeFileSync(dest, js.replace(/(from\s+")(\.{1,2}\/[^"]+)(")/g, (_, a, spec, c) => {
    compile(posix.join(posix.dirname(name), spec));
    return `${a}${spec}.mjs${c}`;
  }));
  return dest;
}

// name is the path under src/ without the extension, for example "speech-queue" or "vendor/pre-roll".
export const loadTs = (name) => import(pathToFileURL(compile(name)).href);
