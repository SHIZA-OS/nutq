// Production builds only:
// - The eval runners' "Download events JSONL" button is not shipped (main.ts never touches it outside eval mode, which is itself off in a
//   production build). Dev, and the runners' own config (eval/runner/vite.test.config.mjs), keep it.
// - The ONNX Runtime JavaScript in the bundle (onnxruntime-web 1.27.0) names a 26 MB wasm of its own, which the bundler emits into
//   dist/assets. The page never requests it: src/vendor/model.ts points wasmPaths at the 1.22.0 files in public/vendor (prod-build.test.mjs
//   checks the request log). ponytail: the file is dropped from the output, not kept out of the bundle; if wasmPaths is ever removed, ORT
//   would ask for the dropped file and 404, and this plugin should go.
export default {
  plugins: [
    {
      name: "strip-eval-ui",
      apply: "build",
      transformIndexHtml: (html) => html.replace(/\s*<button id="eval-download-btn"[\s\S]*?<\/button>/, ""),
    },
    {
      name: "drop-unused-ort-wasm",
      apply: "build",
      generateBundle(_, bundle) {
        for (const name of Object.keys(bundle)) if (/^assets\/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      },
    },
  ],
};
