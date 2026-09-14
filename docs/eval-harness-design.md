# Nutq Evaluation Harness: Design Spec

Status: design only, nothing implemented yet. Written for a Claude Code session to build against.
Supersedes nothing; this is the first concrete design pass on the metrics framework from Handoff 5.

## 1. Goal

Turn the fully-specified but unbuilt metrics framework (staged latency, WER, answer correctness,
intent preservation, session completion rate, cost per turn, client-side resource footprint) into a
real, runnable harness that produces a report after each eval run, so future changes (STT model size,
system prompt, TTS strategy) can be judged against numbers instead of impressions.

Explicitly not deciding here: pass/fail thresholds. Per Handoff 5, that stays a real team decision
once baseline numbers exist. This spec produces the numbers, not the judgment calls on them.

## 2. Where This Lives

Recommend a new directory inside `SHIZA-OS/nutq`: `eval/`. Keeps it versioned alongside the widget
it's testing, and keeps the eval-set data (which will accumulate real transcripts over time) in the
same repo history.

```
nutq/
  eval/
    cases/               # eval set, one file per case or a single JSON/YAML manifest
    runner/              # orchestration scripts
    reports/             # generated output, gitignored except a sample
    README.md
```

Not a separate repo. No reason to split it, and the whole point is fast iteration against Nutq's own
code, not a standalone product.

## 3. Data Sources, Confirmed Available

Two sources already exist per Handoff 5, neither needs new infra:

- **Client-side**: Nutq's own log panel. Currently only logs "committed transcript" and "reply
  complete." Needs new instrumentation (see section 4) before it's useful for staged latency.
- **Server-side**: `runtime-trace.jsonl` inside the ZeroClaw container
  (`/zeroclaw-data/.zeroclaw/data/state/runtime-trace.jsonl`). Writes regardless of `RUST_LOG`
  level, already has real per-request timing and real token counts. No changes needed here, just a
  parser.

## 4. Client-Side Instrumentation Needed First

Before any staged latency number is possible, Nutq itself needs new timestamped log events. This is
the one piece of actual Nutq code that has to change before the harness can run.

**Implemented and confirmed (see section 5.1 for the ordering finding that changed the original
plan):**

- `speech_start` / `speech_end`: wired to Moonshine's `onSpeechStart`/`onSpeechEnd` VAD callbacks,
  not the UI button. Logged, but `speech_end` is informational only, not used in latency formulas,
  since its ordering relative to `stt_committed` is not guaranteed in streaming mode.
- `mic_button_press` / `mic_button_release`: the UI click-handler timestamps, originally mislabeled
  as `speech_start`/`speech_end` before the rewiring. Kept as a separate, distinct signal.
- `stt_committed` (Moonshine's `onTranscriptionCommitted` callback fires)
- `ws_message_sent` (the `{"type":"message",...}` frame goes out over `/ws/chat`)
- `first_chunk_received` (first `{"type":"chunk",...}` frame arrives)
- `done_received` (the `{"type":"done","full_response":...}` frame arrives)
- `tts_start` (`SpeechSynthesisUtterance.onstart` fires; not yet confirmed live, sandbox environment
  has no working Web Speech API voices, needs verification on a real desktop browser)

Each event: `{event, timestamp_ms, session_id}`. Session ID needs to be generated client-side per
recording and threaded through so server-side trace entries can be joined back to it (the `/ws/chat`
protocol doesn't currently carry a correlation ID either direction, per Handoff 4's protocol notes;
worth checking whether one exists before inventing a new one, and adding a client-generated one to
the outbound message frame if not).

## 5. Metrics, One by One

### 5.1 Staged latency
Derived entirely from the timestamp events in section 4, joined with `runtime-trace.jsonl` server
timestamps for the same session ID.

**Revised anchor, confirmed via live testing (not the original assumption):** `speech_end` (wired to
Moonshine's `onSpeechEnd`, the Silero VAD's utterance-boundary callback) and `stt_committed` are not
reliably ordered. In streaming mode (`useVAD=false`), transcript commits are gated by the frame
buffer's own faster EMA-threshold pause detector, a separate signal from Silero's coarser VAD, both
watching the same underlying per-frame speech probability but racing independently. Live testing
showed `stt_committed` landing before `speech_end` by 95ms and 425ms across two clean runs, not
after, as originally assumed. There is no clean "user stopped talking" timestamp currently exposed
by Moonshine's public callback surface; the fast internal detector that actually gates commits has no
callback of its own.

Given this, `stt_committed` is used as the practical anchor for user-perceived latency instead of
`speech_end`. This slightly understates true perceived latency by however much STT inference time
was baked into reaching that commit, documented here rather than treated as exact:

- Dispatch latency: `ws_message_sent - stt_committed` (should be near zero; flags if not)
- Time-to-first-token: `first_chunk_received - ws_message_sent`
- Full completion time: `done_received - ws_message_sent`
- TTS start delay: `tts_start - done_received`
- User-perceived latency (the number that matters): `tts_start - stt_committed`

`speech_end` is still logged (alongside `speech_start`) but treated as informational only, not part
of the formulas above, since its ordering relative to `stt_committed` isn't guaranteed. It remains
useful for spotting cases where the VAD boundary and the buffer's commit trigger diverge widely,
which may itself be worth surfacing in the report as a data-quality signal rather than discarding.

Separately, `mic_button_press`/`mic_button_release` are logged from the UI's click handler. These are
UI-action timestamps, not speech boundaries, kept for a possible future UX metric (how long users
hold the button relative to how long they actually speak) but not used in any latency formula here.

A future experiment, not undertaken as part of this instrumentation work: switching
`MicrophoneTranscriber` to `useVAD=true` might resolve the race at the source by having a single
detector gate both signals, but this changes real transcription behavior and responsiveness, not
just instrumentation, and needs its own deliberate evaluation rather than a reactive flip.

Note per Handoff 5: VAD-to-STT latency doesn't apply yet, current interaction is push-to-talk only.
Leave that stage out of the report until continuous listening ships, don't fill it with a placeholder.

### 5.2 Word Error Rate (STT)
Needs a reference transcript per eval case (see section 6). Standard WER: Levenshtein distance
between Moonshine's committed transcript and the reference, normalized by reference word count.
`jiwer` (Python) is the standard library for this, handles the alignment correctly rather than a
naive diff.

### 5.3 Answer correctness
LLM-as-judge, not exact string match, per Handoff 5's explicit correction of the naive approach.
Needs an expected-answer field per eval case plus a judge prompt. Recommend using a separate model
call (not the same Haiku instance being tested) scoring against a rubric: correct / partially
correct / incorrect / off-topic, with a one-line justification logged for manual spot-checking, not
just a bare score. Which model does the judging is an open decision, flagged in section 8.

### 5.4 Intent preservation
Distinct metric from WER, per Handoff 5. A transcript can have real word errors but the agent still
understood and acted correctly, or have near-zero WER but the agent still missed the actual intent.
Measured as: did the answer-correctness judge's verdict match what it would have been against the
clean reference transcript instead of the noisy STT output? Requires running each case twice, once
with the real STT transcript, once with the ground-truth reference text, and comparing the two
correctness verdicts. A mismatch where the reference passes but the STT-driven run fails is a real
intent-preservation failure attributable to STT noise, not the LLM.

### 5.5 Session completion rate
Percentage of eval runs that reach `done_received` without a connection drop, timeout, or unhandled
client error. Given the real debugging history in Handoff 5 (opaque 1006 closes, CORS blocking `/pair`
silently, stale containers), this metric earns its place; connection reliability has been a genuine,
repeated problem in this project, not a hypothetical one. Log the failure mode alongside the binary
pass/fail (auth rejection, timeout, WS close code, JS exception) so a completion-rate drop is
diagnosable, not just a number that went down.

### 5.6 Cost per turn
Pull real token counts from `runtime-trace.jsonl` per session, split input and output (per Handoff
5's own note: they're priced roughly 5x apart on Haiku, lumping them hides which side actually drives
cost). Multiply by real published Anthropic pricing for whichever model is under test. Do not
estimate or round the pricing figures; pull them fresh at report-generation time rather than hardcode
them into the harness, since pricing changes and a stale hardcoded number would silently misreport
cost later.

### 5.7 Client-side resource footprint
Browser-side measurement: peak memory (`performance.memory` where available, Chrome-only, flag this
limitation in the report rather than pretend it's cross-browser), CPU load during active STT
(approximate via wall-clock time for a fixed transcription task as a proxy, since browsers don't
expose real CPU usage to JS), and the two external CDN fetches Moonshine makes on first run
(`cdn.jsdelivr.net` for the ONNX runtime binary, `download.moonshine.ai` for model weights),
timed and logged separately since they only happen once per session/cache lifetime and would
otherwise distort a "typical turn" average if mixed in.

## 6. Eval Set Design

Per Handoff 5: tagged by category, not one flat list. Recommend a JSON manifest, one entry per case:

```json
{
  "id": "clean-001",
  "category": "clean_factual",
  "audio_ref": "cases/audio/clean-001.wav",
  "reference_transcript": "What time is it?",
  "expected_answer_criteria": "States a current date/time in a reasonable format.",
  "notes": ""
}
```

Categories, matching Handoff 5's framework exactly:
- `clean_factual`: straightforward questions, clean audio
- `noisy_ambiguous`: deliberately unclear phrasing, background noise, or accented speech
- `multiturn_context`: requires the agent to reference a prior turn correctly
- `edge_case`: silence, very short utterances, mid-sentence cutoffs

Recommend starting with a genuinely small set (5 to 10 per category, 20 to 40 total) rather than
over-building the eval set before the harness itself is even proven to run correctly. Expand once
the pipeline is confirmed working end to end on a small set.

Audio files: real recorded `.wav` clips, not synthesized TTS-generated test audio, since the point is
testing Moonshine against realistic input including the noisy category, and synthetic audio would
under-represent real STT error patterns.

## 7. Report Output

One report per eval run, `eval/reports/<timestamp>.md` (or `.json` for programmatic comparison
across runs). Should include, per case: all staged latency numbers, WER, correctness verdict,
intent-preservation flag, completion status, cost, and resource footprint where applicable, plus an
aggregate summary row (means, and worth including p90/p95 for latency specifically, since a mean can
hide a bad tail that matters more for perceived quality than the average does).

## 8. Open Decisions, Not Made Here

- **Judge model**: which model scores answer correctness. Needs a real credential decision, and per
  standing project rule, that routes through Syed Hussain, not a default assumed here.
- **Pass/fail thresholds**: explicitly deferred per Handoff 5, stays a team decision once baseline
  numbers exist.
- **CPU proxy method** (section 5.7): the wall-clock proxy is a reasonable stand-in given browsers
  don't expose real CPU metrics to JS, but worth a second look before treating it as authoritative.

### Resolved: session/turn correlation (previously an open decision)

Checked directly against `SHIZA-OS/zeroclaw`'s real `ws.rs`. Findings:

- The client already receives `session_id` once, in the `session_start` frame at connection open.
  `session_key` (used to tag trace entries) is deterministically `"gw_" + session_id`, so
  session-level correlation needs zero protocol change, it already works today.
- Per-turn correlation does not exist client-side. The server generates a real per-turn `turn_id`
  (`ws.rs:1042`), but it's never sent to the client, and the `trace_id` that does appear in
  `runtime-trace.jsonl` is assigned per logging call-site, not consistently per turn (two entries for
  the same turn were observed carrying two different `trace_id` values). A client-sent field like
  `client_message_id` would be silently ignored by the current server, since inbound frames are
  parsed permissively as untyped JSON with no `deny_unknown_fields` struct. Fixing this properly
  needs a real `zeroclaw` fork change (server reads/echoes an ID), which is explicitly stalled per
  standing instruction on upstream work.
- **Resolution adopted, no core change required**: the harness opens one fresh WebSocket
  connection per eval case wherever possible, one turn per session. In that shape, `session_key`
  alone is a perfect per-turn join key. For the `multiturn_context` category specifically (multiple
  turns per session, by design), correlation falls back to send-order: match the *n*th
  `{"type":"message",...}` the harness sent to the *n*th `gateway_ws_turn` trace entry sharing that
  `session_key`, relying on chronological ordering within a session rather than an explicit ID.
  Worth a one-time sanity check when the parser is built, confirming entries never arrive
  out of send-order for a single session before trusting this at scale.
- **Not every trace row is attributable.** Some entries (e.g. `"task spawned"`) log with an empty
  `"zeroclaw": {}` and no `session_key` at all. The parser must filter to only rows where
  `session_key` is present, and should report a count of skipped/unattributable rows per run as a
  data-quality signal, rather than silently drop them with no trace of having done so.

## 9. Suggested Build Order for Claude Code

1. Add the timestamp instrumentation to Nutq's client code (section 4). Verify events actually log
   correctly for one real manual test run before building anything else on top.
2. Confirm or add a session correlation ID across the `/ws/chat` protocol (open decision, section 8).
3. Build the `runtime-trace.jsonl` parser, joined against client-side events by session ID.
4. Build the staged latency calculation and a minimal report (just this metric first, prove the
   join works end to end).
5. Add WER (needs `jiwer` or equivalent, plus the first handful of real eval cases with reference
   transcripts).
6. Add answer correctness and intent preservation (needs the judge-model decision resolved first).
7. Add session completion rate and cost per turn (both purely derived from data already flowing
   through the pipeline by this point).
8. Add client-side resource footprint last, it's the most browser-dependent and least critical piece.
