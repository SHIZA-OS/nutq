# Roadmap

Priority-ordered, based on where the project stands after Phase 1 (see
[PROGRESS.md](PROGRESS.md)).

## 1. Solve the real pairing flow

`require_pairing` was re-enabled after the Phase 1 test (see [PROGRESS.md](PROGRESS.md)), so
future tests can no longer route around pairing the way the first test's debugging did. A
proper pairing flow, using the real `zc_<64hex>` bearer token rather than the 6-digit
one-time code, needs to be worked out and documented before the next round of testing. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the distinction between the two tokens.

## 2. Properly fix the config.toml model-field parsing bug

The `ZEROCLAW_providers__models__anthropic__default__model` environment variable is a working
workaround, not a fix. The underlying bug, where
`[providers.models.anthropic.<alias>].model` is written correctly to `config.toml` but read
back as `<unset>` by the daemon's own config reader, should be fixed properly in the
SHIZA-OS/zeroclaw fork rather than permanently relied on via env var.

## 3. Build the real interaction model

Push-to-talk is done as part of Phase 1. The next steps in the interaction model, in order,
are continuous listening (no manual push-to-talk trigger) and then local barge-in (the user
interrupting the agent's speech mid-reply, handled client-side).

## 4. Evaluate Piper as the real TTS replacement

The current Web Speech API TTS is a placeholder. Piper should be evaluated as the real
text-to-speech engine for Nutq.

## 5. Resolve the Moonshine dependency risk

Moonshine's upstream source repository has been archived in favor of a separate project
called "Moonshine Voice." The npm package Nutq currently depends on is still current, but the
archival of the source repo is a risk worth resolving (understanding what "Moonshine Voice"
means for long-term support, or evaluating alternatives) before depending further on it.

## 6. Package Nutq as a reusable embeddable widget

Once the interaction model (item 3) and the TTS choice (item 4) are settled, package Nutq as
a reusable, embeddable widget rather than a standalone app.
