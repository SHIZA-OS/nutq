# Roadmap

What is open, grouped by theme, not ranked. Each item comes from a limitation or an unfinished experiment recorded in
[PROGRESS.md](PROGRESS.md), [ARCHITECTURE.md](ARCHITECTURE.md) or [eval-harness-design.md](eval-harness-design.md); contributions
are welcome (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Streaming and engine work

- **A better voice engine than the browser's speech synthesis.** The browser voice is a placeholder. Piper is the candidate to
  evaluate; a local engine started in about 60 ms in an earlier trial but the espeak-ng voices sounded too robotic. The start
  delay of the browser voice was 0.8 to 2 s in the gap experiment.
- **Streaming speech for latency**, whether from a new engine or a cloud voice, sentence by sentence as the answer arrives.
- **Continuous listening and local barge-in.** Today listening is tap to start and tap to stop, and a tap stops the speech.
  Listening without a tap, and interrupting the agent by voice with the detection done in the browser, are the next steps in the
  interaction model.
- **The Moonshine dependency.** Its upstream source repository has been archived in favor of a separate project called
  "Moonshine Voice". What that means for long-term support needs to be understood, or alternatives evaluated.
- **An embeddable widget.** Packaging Nutq as a component other pages can include, once the interaction model and the voice
  engine settle.

## Platform testing

- **macOS, Windows and Safari are untested.** [TESTING_PLATFORMS.md](TESTING_PLATFORMS.md) is a ten-minute manual checklist; results
  from other systems are the most useful contribution here.
- **A cross-origin-isolated deployment** (COOP and COEP headers) is untested. ONNX Runtime 1.14.0 would then ask for its threaded
  wasm variants, which are not bundled.
- **ZeroClaw versions.** Nutq was checked against one ZeroClaw commit (see the README). Other versions, and whether a missing
  `schema_version = 3` explains the model field reading back as `<unset>`, have not been tested.
- **A speech-model load progress bar** would need the loader to expose progress, which the current one does not
  (`InferenceSession.create` takes a URL); fetching the weights in the page and handing them over as bytes would allow it.

## Accuracy levers

- **Commit seams:** where one utterance is cut into several commits to the model is the next lever recorded for word error rate.
- **Calibrating the voice detector's thresholds and the pre-roll length.** Both are starting points, not tuned values.
- **Chrome's microphone processing** (echo cancellation, noise suppression, gain) as a cause of run-to-run variation is untested, as
  is the 44.1 kHz capture rate Chrome reports, which is resampled downstream.
- **More pause recordings from more speakers.** The end-of-turn wait was tuned on 12 pause recordings by one speaker, and most of
  its cuts come from one recording, so the cut rate is a result for those takes, not a general one.

## Evaluation

- **Answer correctness and intent preservation** are specified in the design (section 5.3 and 5.4) but not built: no judge code
  exists under `eval/runner`, and which model should judge is undecided.
- **Pass and fail thresholds** are left until enough baseline numbers exist.
- **Recorded test audio** is not in the repository, so a contributor has to record their own (`eval/wer/record.sh`) to run the
  accuracy drivers.
