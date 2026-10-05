# Nutq

Nutq (نطق, "utterance") is a client-side voice agent widget for ZeroClaw. It runs entirely
in the browser and talks to any ZeroClaw instance over its `/ws/chat` WebSocket, with no
changes required to ZeroClaw core.

The pipeline, in short: microphone audio is transcribed locally in-browser with Moonshine
(WASM, no server round-trip for STT), the transcript is sent to a ZeroClaw agent over
`/ws/chat`, and the agent's reply is spoken back with the Web Speech API. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow and protocol details,
including the pairing-token gotcha and a known upstream config-parsing bug.

For where the project stands and how it got there, see
[docs/PROGRESS.md](docs/PROGRESS.md). For what's next, in priority order, see
[docs/ROADMAP.md](docs/ROADMAP.md). For setup, tests and commit conventions, see
[CONTRIBUTING.md](CONTRIBUTING.md). What the project bundles or loads from third parties is in
[docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).

## Commands

- `npm install`, then `npm run dev` (dev server, eval mode available) or `npm run build` (type check, then the
  production build into `dist/`).
- `npm test` runs every `eval/runner/*.test.mjs`. `npx tsc --noEmit` must report no errors.

## House rules

These apply to everything written in this repo: code, comments, docs, and commit messages.

- **No em dashes, anywhere.** Use commas, colons, semicolons, or restructure the sentence.
- **Never invent or estimate a fact.** If something isn't confirmed from the real source
  (code, config, logs), say so plainly or mark it TBD. Don't guess at numbers, dates, or
  behavior.
- **Never commit a token, key or password**, real or example-looking. Pairing tokens in tests and docs are placeholders.
- **Eval instrumentation is dev-only.** Eval mode, its URL params and the event code are gated on
  `import.meta.env.PROD` in `src/main.ts`, so a production build ships none of it. Keep new eval-only code behind the
  same flag; `eval/runner/prod-build.test.mjs` fails if an event name reaches the bundle.
- **Anything third-party that is added or bundled gets a license check and an entry in
  [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)**, with its license file next to it.
- **Writing to a ZeroClaw container's `config.toml`** must go through `docker exec -i`, never a
  plain `docker exec`. Without `-i`, the write truncates the file.
- **`docker compose up -d` vs `--force-recreate` vs `restart`:** a plain `docker compose up -d`
  picks up compose-file changes. Changes to a mounted volume or to `config.toml` require
  `docker compose up -d --force-recreate` to actually take effect. `docker compose restart`
  picks up neither, and will silently leave the container running on stale state.
