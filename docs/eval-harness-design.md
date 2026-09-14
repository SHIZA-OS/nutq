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
the one piece of actual Nutq code that has to change before the harness can run. Add explicit
timestamp events at:

- `speech_start` (user starts talking, from Moonshine's VAD if enabled, or push-to-talk press)
- `speech_end` (push-to-talk release, or VAD-detected end)
- `stt_committed` (Moonshine emits the final committed transcript)
- `ws_message_sent` (the `{"type":"message",...}` frame goes out over `/ws/chat`)
- `first_chunk_received` (first `{"type":"chunk",...}` frame arrives)
- `done_received` (the `{"type":"done","full_response":...}` frame arrives)
- `tts_start` (`SpeechSynthesisUtterance` actually begins speaking)

Each event: `{event, timestamp_ms, session_id}`. Session ID needs to be generated client-side per
recording and threaded through so server-side trace entries can be joined back to it (the `/ws/chat`
protocol doesn't currently carry a correlation ID either direction, per Handoff 4's protocol notes;
worth checking whether one exists before inventing a new one, and adding a client-generated one to
the outbound message frame if not).

## 5. Metrics, One by One

### 5.1 Staged latency
Derived entirely from the timestamp events in section 4, joined with `runtime-trace.jsonl` server
timestamps for the same session ID:

- STT latency: `stt_committed - speech_end`
- Dispatch latency: `ws_message_sent - stt_committed` (should be near zero; flags if not)
- Time-to-first-token: `first_chunk_received - ws_message_sent`
- Full completion time: `done_received - ws_message_sent`
- TTS start delay: `tts_start - done_received`
- User-perceived latency (the number that matters): `tts_start - speech_end`

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
- **Session ID correlation**: whether `/ws/chat`'s protocol already carries anything usable for
  joining client and server timestamps, or whether one needs to be added to the outbound message
  frame. Needs a real source check before building the joining logic, not an assumption.
- **CPU proxy method** (section 5.7): the wall-clock proxy is a reasonable stand-in given browsers
  don't expose real CPU metrics to JS, but worth a second look before treating it as authoritative.

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
