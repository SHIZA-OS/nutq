# Contributing to Nutq

## Setup

You need Node.js `^20.19.0` or `>=22.12.0` and npm, plus Google Chrome for the tests. The tests and eval drivers launch the
binary named by the `CHROME_BIN` environment variable, and `/usr/bin/google-chrome` when it is not set:

```
CHROME_BIN=/path/to/chrome npm test
```

```
git clone https://github.com/SHIZA-OS/nutq.git
cd nutq
npm install
npm run dev        # http://localhost:5173, with eval mode available (?eval=1)
```

## Tests

- `npx tsc --noEmit` must report no errors.
- `npm test` runs every `eval/runner/*.test.mjs` with `node --test`. Run one file with
  `node --test eval/runner/<name>.test.mjs`. Check the exit code of the command, not only the summary it prints.
- Most page tests drive real headless Chrome against the dev server and a stub gateway (`eval/runner/page-harness.mjs`).
  A few load the real speech model, which is served from `public/vendor/`.
- Some tests and eval drivers (`prod-build.test.mjs`, `smoke-evals.test.mjs`, `run-wer.mjs`, `replay-commits.mjs`) need the
  project's recorded test audio (one `<case id>.wav` per case), which is not in the repository and has no default location.
  Give the directory with the `EVAL_AUDIO_DIR` environment variable or the drivers' `--audio-dir` flag (the flag wins). The
  tests skip themselves when it is not set; a driver stops at once and says so. `eval/wer/record.sh --out <dir>` (or
  `EVAL_AUDIO_DIR`) records the case set listed in `eval/wer/cases.jsonl`.

## How changes are made here

- **Read the code you will touch first**, then write the failing test, then the change.
- **Mutation-check your tests.** After a test passes, break the code it is meant to guard in the smallest way that should
  make it fail, and run the test again. If it still passes, the test does not guard what you thought; strengthen it. Report
  the mutants that survived rather than leaving them out. The `PROGRESS.md` entries show the habit in use.
- **Keep eval instrumentation out of production.** Eval mode, its URL parameters and the event code are gated on
  `import.meta.env.PROD`. `eval/runner/prod-build.test.mjs` builds the app and fails if an event name reaches the bundle.
- **Anything third-party that you bundle or load** needs its license checked, its license file next to it, and an entry in
  `docs/THIRD_PARTY.md`.
- Do not touch the speech-to-text, voice activity or turn-taking logic without the evaluation drivers' numbers to show the
  effect; `docs/eval-harness-design.md` describes them.

## Commits

- One thin slice per commit, with tests passing and `tsc` clean at every commit.
- Message style, as in the history: `feat:`, `fix:`, `docs:`, `eval:`, `build:` and a short summary; a body when the
  reasoning is not obvious from the diff.
- No em dashes anywhere (code, comments, docs, commit messages). Do not state a number, date or behavior you have not
  confirmed from the code, config or a measurement; write TBD instead.
- Never commit a token, key or password, real or realistic-looking.
- Commit under your own identity.
