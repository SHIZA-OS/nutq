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
[docs/ROADMAP.md](docs/ROADMAP.md).

## House rules

These apply to everything written in this repo: code, comments, docs, and commit messages.

- **No em dashes, anywhere.** Use commas, colons, semicolons, or restructure the sentence.
- **Never invent or estimate a fact.** If something isn't confirmed from the real source
  (code, config, logs), say so plainly or mark it TBD. Don't guess at numbers, dates, or
  behavior.
- **Git identity for this repo** is `SHIZA-OS` / `opensource@shiza.ai`, pushed via the
  `github-shiza-os` SSH alias (see the `origin` remote). Don't push under any other identity.
- **Writing to the ZeroClaw fork's `config.toml`** must go through `docker exec -i`, never a
  plain `docker exec`. Without `-i`, the write truncates the file.
- **`docker compose up -d` vs `--force-recreate` vs `restart`:** a plain `docker compose up -d`
  picks up compose-file changes. Changes to a mounted volume or to `config.toml` require
  `docker compose up -d --force-recreate` to actually take effect. `docker compose restart`
  picks up neither, and will silently leave the container running on stale state.
