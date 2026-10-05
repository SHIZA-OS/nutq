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

- **Client-side**: Nutq's own log panel, now backed by real structured instrumentation (see section
  4): nine timestamped `EvalEvent` types plus `send_trigger`, kept in memory and exportable as JSONL
  via a "Download events JSONL" button (hidden unless the page is loaded with `?eval=1`).
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
- `send_blocked` `{reason: "reply_in_flight"}` (a message was not sent because a reply was still in flight; the
  utterance is dropped), `turn_timeout` `{ms}` (the in-flight flag was cleared after `ms` with no ending frame),
  `tts_skipped` `{reason}` (an empty or whitespace-only reply, or no speech synthesis), `tts_end` (the utterance's
  `onend`), `tts_cancelled` `{reason}` (`onerror` with `canceled` or `interrupted`; `reason` is `mic_press` when the cancel was the mic
  button starting to listen while speech was playing, for the browser's `canceled` report and for a streamed queue alike) and `tts_error` `{message}`
  (any other `onerror` code). None of these is read by `join-latency.mjs` or `completion.mjs`.
- Sentence streaming (`?tts_stream=1`, default off): `tts_requested` `{index}` (a sentence was queued for speech;
  `index` counts from 0 within the turn), `tts_sentence_start` `{index, units, chars}` (an utterance became audible, the engine's
  `onstart`; since the speech queue merges the units that waited behind the first into one utterance, `index` is its first unit, `units`
  how many units it holds and `chars` its length) and `tts_text_mismatch` `{chunks_chars, full_response_chars}` (at `done`, `full_response` differed from
  the joined chunks; the chunks were spoken and nothing was spoken again). `tts_start` keeps its meaning, the first
  audible audio of the turn, and is emitted once per turn, so with the flag on it comes together with
  `tts_sentence_start` for the first sentence that really starts; it gains an `engine` field (`browser`) with the flag
  on or off. `tts_end`, `tts_cancelled` and `tts_error` are per utterance, so a streamed turn can have several, and
  `tts_cancelled` `{reason: "canceled"}` is also what a cancel that drops a queued or playing sentence reports. With
  the flag on `tts_start` can come before `done_received`, so `tts_start_delay` in `join-latency.mjs` (`tts_start -
  done_received`) can be negative for such a turn, while `post_trigger`, `commit_to_audio` and `user_perceived` stay
  the time to first audio; `completion.mjs` reads none of these events (both pinned in the two test files). A turn
  that reaches `done` with no sentence queued (no chunk frames came) speaks `full_response` once, trimmed, through the
  same queue (`tts_requested` `{index: 0}`, then `tts_text_mismatch`); if that is empty it is `tts_skipped`. Not confirmed live: no sentence has been spoken by a real voice with the flag on.
- `tts_dropped` `{reason, units, chars, partial_chars}` (`?tts_stream=1` only): a `tool_call` frame arrived and speech that had not been heard was
  dropped, because text streamed before a tool call is not part of `full_response`. `reason` is `tool_call`. `units` is how many queued units were
  dropped, including an utterance that was with the engine but not audible yet (the engine is told to cancel it, and no `tts_cancelled` is reported
  for it); `chars` is those units' own characters, without join spaces; `partial_chars` is the unfinished text the splitter held. It is not emitted
  when nothing was dropped, and an utterance that is audible is never dropped. A turn whose speech was all dropped has `tts_requested` events with no
  `tts_sentence_start`; the done fallback may then speak `full_response` as one more unit (`tts_requested`, then `tts_text_mismatch`).
- `tts_muted` `{reason, point, chars}`: the mic button was tapped while a reply was in flight, so the rest of that reply is
  not spoken (with or without `?tts_stream=1`); `reason` is `mic_press`. The mute ends with the turn: done, aborted, a
  turn-failure error, a closed socket or the 60 s timeout. `chars` means two different things by `point`. `point: "done"`
  is the total: the characters of text that went unspoken for the turn, the trimmed reply (`full_response` when the
  gateway sent one), the same in both modes and not emitted when it is empty. `point: "chunk"` (flag on only) marks
  when muting first took effect, on the first chunk of the turn that was not spoken, and its `chars` is the length of
  that one chunk, not a total. Each point is reported at most once per turn. Nothing is spoken from a muted turn at
  `done` either: no tail, no `full_response` fallback, no `tts_text_mismatch`, no `tts_skipped`. `join-latency.mjs` reads
  `point: "done"` on a turn with `done_received`: the turn gets `muted` `{reason, chars}`, and with no `tts_start`
  (nothing was audible) `tts_start` is not a missing client event, the `tts_start` stages are null, and
  `tts_start_null_reason` is `muted:<reason>`; if audio did start before the tap its stages are kept and the reason is
  null. `point: "chunk"` alone is not read. `completion.mjs` does not read it (pinned in both test files).

Each event: `{event, timestamp_ms}`, plus optional extra fields merged in per call site. Corrected
from an earlier draft of this section that said `{event, timestamp_ms, session_id}`: no client-side
session ID is threaded through events, and none is needed, see section 8's resolution (session-level
correlation comes from the already-received `session_id` in `session_start`; per-turn correlation
uses send-order matching against `runtime-trace.jsonl`, not a per-event ID).

The one field currently using that extra-fields mechanism: `ws_message_sent` carries
`send_trigger: "manual" | "auto_silence"`, recording whether the turn ended via the mic button's
release or the 5000ms silence auto-send timer (`SILENCE_COMMIT_MS`, `src/main.ts`). Both paths funnel
through one shared `finishListening(trigger)` function, so this is a real, threaded parameter, not an
inference.

**Export:** events are kept in an in-memory array (`evalEvents`, `src/main.ts`), not just serialized
into the log panel's text, and can be downloaded as real JSONL via a button in the Logs card header.
The button is hidden unless the page URL has `?eval=1`, so ordinary users never see it. `evalEvents`
itself is only pushed to when `?eval=1` is set (`isEvalMode`), so an ordinary session's array stays
empty for its whole lifetime rather than growing unbounded; the log panel's plain-text output is
identical in both modes, this only affects the in-memory array and the JSONL export.

**Failure-signal events, added for session completion rate (section 5.5):** the original nine events
above only covered the success path. None of `socket.onerror`, `socket.onclose`, the server's
`"error"`/`"aborted"` frames, or an uncaught JS exception were structured `EvalEvent` entries before
this, only plain `log()` text invisible to the JSONL export. Added:

- `ws_error` (`socket.onerror`)
- `ws_closed` (`socket.onclose`), carrying `{code, reason, received_session_start}`: the last field
  distinguishes a drop after a real session was established (`received_session_start: true`) from an
  immediate rejection before one ever started (e.g. the 1006-on-bad-token case documented in
  [ARCHITECTURE.md](ARCHITECTURE.md)), which come from the same close code but mean different things
- `turn_error_frame` (server's `"error"` frame), carrying `{message}`
- `turn_aborted` (server's `"aborted"` frame)
- `js_error`, from a global `window.onerror` and `unhandledrejection` handler; previously an
  uncaught JS exception had zero visibility anywhere, not even the log panel

**Session identity event:** `session_start` (the server's `"session_start"` frame), carrying
`{session_id, resumed}`. ZeroClaw derives `session_key = "gw_" + session_id`, where `session_id` is the
`?session_id=` query param if the client sent one and a fresh UUID v4 otherwise (`ws.rs`, at the top of
`handle_socket`). Nutq never sends `session_id`, so each connection gets a new UUID and `resumed` is
false in practice. Recording it in the events file is what lets `join-latency.mjs` name the session
without `--session` (section 5.1). It is a session-level event, not a turn stage; nothing in the
latency math reads it.

**Token redaction:** the "Connecting to ..." log line (log panel + console) used to print the full
`ws://` URL including the real `zc_...` bearer token in plain text. `redactedUrlForDisplay()` masks
the token to `zc_…REDACTED` for that log line only; the actual `WebSocket` connection still uses the
real, unredacted URL. Verified live against a real ZeroClaw instance: the log line reads
`token=zc_…REDACTED` and the connection still succeeds.

## 5. Metrics, One by One

### 5.1 Staged latency
Derived entirely from the timestamp events in section 4, joined with `runtime-trace.jsonl` server
timestamps for the same session ID.

**Which session is joined.** If the events file carries a `session_start` event (section 4), the
session is derived from it (`session_key = "gw_" + session_id`) and picked automatically, with no
flag. If the trace has no rows for that session, it is treated as `--no-server-session` (the
`session_key` in the output is still the derived one, and `session_source` says which rule applied:
`events_session_id`, `events_session_id_no_server_rows`, `session_argument`,
`no_server_session_flag`, or `trace_single_session`). `--session` may not contradict the events
file's `session_id` (error), and `--no-server-session` plus `--session` stays an error. A file with
several different `session_id`s (Nutq reconnected within one recording) is not auto-picked: pass
`--session`. Events files recorded before `session_start` existed have no `session_id` and behave as
before: `--session`, `--no-server-session`, or a trace with exactly one session.

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
was baked into reaching that commit, documented here rather than treated as exact.

**Superseded by a second finding, since main.ts now accumulates multiple commits per turn:**
`sendTranscript()` is called once per press-to-release (or press-to-auto-send) session, not once per
`stt_committed`, so a single turn can carry zero, one, or several `stt_committed` events before its
`ws_message_sent`. The formulas below anchor on the **last** `stt_committed` before `ws_message_sent`,
implemented in `eval/runner/join-latency.mjs`, not the first (which is what "stt_committed" without
qualification would have meant when this section was first written, back when there was only ever
one per turn).

`speech_end`'s ordering problem is also resolved differently than originally planned, not by
dropping it, but by picking which boundary event actually marks "end of user speech" based on how
the turn ended (`send_trigger`, section 4):

- **`auto_silence` turns**: the silence timer is armed by `speech_end` itself (it's the event that
  starts the 5000ms countdown), so the last `speech_end` before `ws_message_sent` is unambiguously
  the right boundary.
- **`manual` turns**: prefer the `speech_end` that closes the last utterance (the normal case, user
  paused briefly then released). If no `speech_end` ever fired for that last utterance, the user
  released mid-utterance, while still actively talking, fall back to `mic_button_release` instead.

Staged latency, as actually implemented:

- STT tail: `last stt_committed - end_of_speech` (end_of_speech per the rule above; can be negative,
  reported as-is rather than clamped, a negative value means the commit landed before the boundary
  event, itself a data-quality signal worth surfacing, not an error to hide)
- Dispatch-to-first-chunk: `first_chunk_received - ws_message_sent`
- Full completion: `done_received - ws_message_sent`
- TTS start delay: `tts_start - done_received`
- Post-trigger: `tts_start - ws_message_sent` (the whole visible-to-the-user tail after sending, one
  number covering dispatch + completion + TTS delay together)
- Commit-to-audio (formerly called "user-perceived latency" in this doc, kept for reference, not
  dropped): `tts_start - last stt_committed`
- **User-perceived latency (the number that matters), revised after live verification against a real
  3-turn session:** anchoring on `last stt_committed` proved wrong in both directions. It eats the
  user's own pause before tapping the mic button on a manual turn (inflating the number with dead
  time that isn't latency), and it excludes the forced-flush time after a mid-utterance tap (hiding
  real latency). The definition now differs by `send_trigger`:
  - **Manual turns**: `tts_start - mic_button_release`. If no `mic_button_release` event exists for
    the turn, `user_perceived` is `null` and `user_perceived_note` explains why; there is no silent
    fallback.
  - **auto_silence turns**: `user_perceived` equals `post_trigger` (`tts_start - ws_message_sent`).
    The deliberate 5000ms silence wait is not perceived latency, since the user isn't waiting on the
    system during it, so it's excluded and reported separately as `timer_wait_ms`:
    `ws_message_sent - speech_end` (`speech_end` is what arms the timer, see above).

Every turn is tagged with `send_trigger` and `manual`/`auto_silence` turns are reported as separate
blocks (`by_trigger` in `join-latency.mjs`'s output), not pooled into one aggregate, since the two
paths have structurally different end-of-speech semantics above and pooling them would blur that.

Separately, `mic_button_press`/`mic_button_release` are logged from the UI's click handler. These are
UI-action timestamps, not speech boundaries in the normal case, kept for a possible future UX metric
(how long users hold the button relative to how long they actually speak), but `mic_button_release`
is now also used directly as the end-of-speech fallback for mid-utterance manual releases, above.

**No clock-offset measurement has been performed** between the browser's `Date.now()` and the
ZeroClaw container's `@timestamp` clock. `join-latency.mjs` never subtracts a client timestamp from
a server timestamp; client-only stages use client timestamps exclusively, server-internal timing
(section 5.1 continued, below) uses server timestamps exclusively, and the two are reported side by
side. This is stated explicitly in the script's own output, not just here.

**The trace has no server-side "first token" signal.** Checked directly against a live
`runtime-trace.jsonl`: the server logs `llm_request` (when it dispatches the prompt to the provider)
and `llm_response` (when the *complete* response comes back from the provider, carrying
`duration_ms` for that call), not per-chunk. There is no row logged when the server starts streaming
the first chunk to the client, so client-side `first_chunk_received` has no server-side counterpart
to compare against, only `dispatch_to_first_chunk` (client-only, above) exists for that leg.
`eval/runner/parse-trace.mjs` now additionally captures `llm_request`/`llm_response` per turn as
`provider_calls` (count) and `provider_duration_ms` (summed), additive to its existing
`gateway_ws_turn` output, useful for reporting provider round-trip time as part of server-internal
timing, but still not comparable to any client timestamp.

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
Given the real debugging history in Handoff 5 (opaque 1006 closes, CORS blocking `/pair` silently,
stale containers), this metric earns its place; connection reliability has been a genuine, repeated
problem in this project, not a hypothetical one.

**Implemented in `eval/runner/completion.mjs`**, built on `join-latency.mjs`'s client/server join plus
the raw client events (the failure-signal events from section 4). Every `gateway_ws_turn` trace row
already tags itself with a real outcome (`event.outcome: "success"|"failure"`, `event.action:
"complete"|"fail"|"cancel"`, `crates/zeroclaw-gateway/src/ws.rs`), which `parse-trace.mjs` now carries
into its per-turn records (previously read and discarded). Per turn:

- **`completed`**: matched server row with `event.outcome == "success"`.
- **`failed_provider`**: matched server row with `event.action == "fail"` (a provider/agent error;
  the server sends an `"error"` frame instead of `"done"`).
- **`cancelled`**: matched server row with `event.action == "cancel"` (the user interrupted the turn
  server-side; the server sends an `"aborted"` frame).
- **`dropped`**: no server row at all for that turn, plus a client-observed `ws_closed`/`ws_error`
  before `done_received`: the connection died before `ws.rs`'s own success/fail/cancel trace write
  ever ran, so nothing is recorded server-side for this attempt. See section 8 for a known limitation
  in how this interacts with `join-latency.mjs`'s positional send-order matching.
  **A dropped turn has no server session by construction**: no `gateway_ws_turn` row means no
  `session_key` for `parse-trace.mjs` to attribute, so the trace has nothing to pass to `--session`.
  Classify it with `--no-server-session` on `completion.mjs` (or `join-latency.mjs`): the events file
  is declared to belong to a session with no server rows, every client turn goes into
  `client_turns_without_server_row`, and nothing is inferred from timestamps or across the
  client/container clocks. For events files that carry a `session_start` `session_id`, the flag is
  no longer needed: a session absent from the trace is detected automatically (section 5.1). The flag
  is still the way to classify older files, and is mutually exclusive with `--session`. It is only right for an
  events file that is a single session with no server rows at all; a mid-session drop is the
  positional-matching limitation in section 8, not this flag's job.
- **`unmatched_unknown_outcome`** / **`unmatched_no_signal`**: safety buckets for a matched row with
  neither a recognized outcome/action, or an unmatched turn with no client failure signal either.
  Per the standing rule on unattributable trace rows (section 8), nothing is dropped silently; these
  buckets exist so a gap surfaces as a number, not as a turn that quietly vanishes from the count.

A failure signal observed *before* any turn was ever sent (connect, never send, connection drops) is
reported as a `session_level_events` entry, not invented as a phantom turn.

**Summary**, per session: turn completion rate (`completed / total_turns`), and a stricter
`strict_session_completed` flag (every turn in the session completed). Verified against the real
recorded 3-turn session (the same one `join-latency.mjs` was verified against): 3/3 completed,
`turn_completion_rate: 1`, `strict_session_completed: true`.

### 5.6 Cost per turn: out of scope for Nutq's harness

**Decided out of scope, superseding the original plan below.** Cost per turn is a function of which
ZeroClaw instance and which model is under test, not of Nutq itself; Nutq's own real cost is local
compute (STT inference, browser resource use), which is what section 5.7's client-side resource
footprint metric already covers. A harness metric that reports someone else's model bill isn't
measuring Nutq.

Two findings from the investigation that led to this decision, worth keeping on record:

- **ZeroClaw's `cost_usd` silently reports `0.0` when no pricing source is configured, with no flag
  distinguishing that from a genuinely free turn.** Traced the rate-resolution path
  (`crates/zeroclaw-config/src/cost/types.rs`, `crates/zeroclaw-runtime/src/agent/cost.rs`): rates
  come from `[cost.rates]` in `config.toml`, then a live-pricing snapshot (only populated if a
  provider sets `live_pricing = true`), then a local `pricing.json` catalog. In the deployment tested
  against, none of the three exist: no `[cost]` section, no `live_pricing` flag, no `pricing.json` on
  disk, so every rate falls through to `0.0` and `cost_usd` computes as a real `0.0 + 0.0 + 0.0`, not
  a missing/null value. The engine internally computes a `pricing_available` boolean
  (`unpriced.tokens == 0`) but never writes it to the trace, so a downstream reader has no way to tell
  "free" apart from "unpriced." Cross-checked against Anthropic's published pricing
  (`https://platform.claude.com/docs/en/about-claude/pricing`, checked 2026-09-28): Claude Haiku 4.5
  is $1/MTok input, $5/MTok output, so the recorded session's three turns should have cost roughly
  $0.02 each (~$0.06 total) by that published rate, against ZeroClaw's reported $0.00 for all three.
  This is a `zeroclaw` fork gap, not a Nutq one, and per standing instruction upstream work on the fork
  stays parked; it's recorded here rather than worked around silently in the harness.
- **Token shape on the default agent: roughly 19.6k input tokens against roughly 30 output tokens per
  turn.** From the same recorded 3-turn session: turn input/output token pairs were 19,618/32,
  19,718/24, and 19,812/45. The input side is dominated by whatever system prompt and context the
  default agent carries into every turn; the output side is a short spoken-style reply, consistent
  with a voice interface. Worth knowing if cost per turn is ever revisited outside Nutq's own harness:
  on Haiku's 5x input/output price skew, the input side is what would actually drive spend here, not
  the reply length.

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
  **Known limitation, surfaced by `completion.mjs`'s `dropped` outcome (section 5.5):** a genuinely
  dropped turn (connection dies before `ws.rs` ever writes a `gateway_ws_turn` row for that attempt)
  means the server array has one fewer entry than the client array from that point on. Positional
  send-order matching then misaligns every subsequent turn in the same session with the wrong server
  row, not just the dropped one. Not hit in the sessions verified so far (the dropped turn tested was
  the last turn of its session, where the misalignment can't manifest), but a real gap for any
  multiturn session where a drop happens mid-session rather than at the end. Not fixed here; would
  need `join-latency.mjs`'s correlation logic to detect a gap and re-sync, not something implemented
  yet.
- **Not every trace row is attributable.** Some entries (e.g. `"task spawned"`) log with an empty
  `"zeroclaw": {}` and no `session_key` at all. The parser must filter to only rows where
  `session_key` is present, and should report a count of skipped/unattributable rows per run as a
  data-quality signal, rather than silently drop them with no trace of having done so.

## 9. Suggested Build Order for Claude Code

1. Add the timestamp instrumentation to Nutq's client code (section 4). Verify events actually log
   correctly for one real manual test run before building anything else on top.
2. Confirmed: session-level correlation works with zero protocol change (session_key derives
   directly from the session_id already sent in session_start). Per-turn correlation for
   multiturn_context cases uses send-order matching instead of a client-generated ID, since a proper
   fix would require a zeroclaw fork change, which stays parked per standing instruction. See
   section 8 for the full resolution.
3. Done: `eval/runner/parse-trace.mjs` parses `runtime-trace.jsonl` into per-session, per-turn
   records (`gateway_ws_turn`, additively extended with `provider_calls`/`provider_duration_ms`
   from `llm_request`/`llm_response`).
4. Done: `eval/runner/join-latency.mjs` joins client events (exported via `?eval=1`) against
   `parse-trace.mjs`'s output by session_key and send-order, computes the staged latency numbers
   from section 5.1 per turn, tagged by `send_trigger`. Verified against a real recorded session.
5. Add WER (needs `jiwer` or equivalent, plus the first handful of real eval cases with reference
   transcripts).
6. Add answer correctness and intent preservation (needs the judge-model decision resolved first).
7. Done: `eval/runner/completion.mjs`, session completion rate (section 5.5). Cost per turn is out of
   scope for Nutq's harness (section 5.6).
8. Add client-side resource footprint last, it's the most browser-dependent and least critical piece.
