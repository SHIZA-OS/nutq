// Plays sentences in order, one at a time, on a TtsEngine. Pure: no timers, no DOM; the engine is injected, so a
// test drives it with a fake engine and a fake clock.
//
// One turn is one run of sentences. Events tell the caller what happened, so it can log the eval events; none
// is emitted from a cancelled run. cancel() bumps a generation counter, and every engine callback checks it, so
// a callback that arrives late from a cancelled sentence (the browser reports its cancelled utterance's error
// after cancel()) is ignored.
//
// ponytail: an engine whose speak() throws would leave the queue waiting for an end that never comes, until the
// next cancel(); the browser engine does not throw, so no try/catch. Add one when an engine can.

import type { StartInfo, TtsEngine } from "./tts-engine";

export type SpeechEvent =
  // A sentence was queued. `index` counts from 0 within the turn.
  | { type: "requested"; index: number }
  // A sentence became audible. `first` is true once per turn: the first audible audio of the turn (the eval event
  // tts_start). `info` is what the engine reported when it started.
  | { type: "start"; index: number; first: boolean; info: StartInfo }
  | { type: "end"; index: number }
  // The engine failed a sentence (or reported it cancelled or interrupted on its own); the queue goes on to the next.
  | { type: "error"; index: number; code: string | undefined }
  // cancel() dropped a sentence that was playing or waiting. Not emitted when nothing was.
  | { type: "cancelled" };

export class SpeechQueue {
  private engine: TtsEngine;
  private emit: (e: SpeechEvent) => void;
  private waiting: { index: number; text: string }[] = [];
  private playing = false;
  private generation = 0;
  private requested = 0; // sentences queued this turn, so the next index
  private started = false; // this turn's first audible audio has been reported
  private finished = false; // finish() was called: no more sentences are coming this turn

  constructor(engine: TtsEngine, emit: (e: SpeechEvent) => void) {
    this.engine = engine;
    this.emit = emit;
  }

  // Queue a sentence; it plays after the ones before it.
  enqueue(text: string): void {
    const index = this.requested++;
    this.waiting.push({ index, text });
    this.emit({ type: "requested", index });
    this.pump();
  }

  // The turn's last sentence has been queued. Returns how many sentences the turn had (0: nothing was said). The
  // turn is over once they have all played; a sentence queued after that starts a new turn.
  finish(): number {
    const sentences = this.requested;
    this.finished = true;
    this.settle();
    return sentences;
  }

  // Drop everything queued and stop what is playing. Safe, and silent, when nothing is happening.
  cancel(): void {
    const active = this.playing || this.waiting.length > 0;
    this.generation++;
    this.waiting = [];
    this.playing = false;
    this.endTurn();
    this.engine.cancel();
    if (active) this.emit({ type: "cancelled" });
  }

  private pump(): void {
    const next = this.playing ? undefined : this.waiting.shift();
    if (!next) return;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.playing = true;
    this.engine.speak(
      next.text,
      (info) => {
        if (!current()) return;
        this.emit({ type: "start", index: next.index, first: !this.started, info });
        this.started = true;
      },
      () => current() && this.advance({ type: "end", index: next.index }),
      (code) => current() && this.advance({ type: "error", index: next.index, code }),
    );
  }

  private advance(e: SpeechEvent): void {
    this.playing = false;
    this.emit(e);
    this.pump();
    this.settle();
  }

  private settle(): void {
    if (this.finished && !this.playing && this.waiting.length === 0) this.endTurn();
  }

  private endTurn(): void {
    this.requested = 0;
    this.started = false;
    this.finished = false;
  }
}
