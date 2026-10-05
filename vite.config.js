// Production builds only: the eval runners' "Download events JSONL" button is not shipped (main.ts never touches it outside eval mode,
// which is itself off in a production build). Dev, and the runners' own config (eval/runner/vite.test.config.mjs), keep it.
export default {
  plugins: [
    {
      name: "strip-eval-ui",
      apply: "build",
      transformIndexHtml: (html) => html.replace(/\s*<button id="eval-download-btn"[\s\S]*?<\/button>/, ""),
    },
  ],
};
