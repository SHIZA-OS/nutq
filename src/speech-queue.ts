// Plays sentences in order, one utterance at a time, on a TtsEngine. No DOM; the engine and the timers are injected, so a
// test drives it with a fake engine and a fake clock.
//
// One turn is one run of sentences. Events tell the caller what happened, so it can log the eval events; none
// is emitted from a cancelled run. cancel() bumps a generation counter, and every engine callback checks it, so
// a callback that arrives late from a cancelled sentence (the browser reports its cancelled utterance's error
// after cancel()) is ignored.
//
// Every utterance pays the voice's start delay again (about 0.85 s between two utterances, measured live with the
// browser's default voice), so units are merged: each utterance is all the units that have arrived by then, in order,
// joined with a space, up to MAX_UTTERANCE_CHARS. The first utterance of a turn would be the first unit alone, and the
// 0.85 s gap after one sentence sounded like an ending, so it waits up to FIRST_UTTERANCE_WAIT_MS after its first unit is
// ready, collecting the units that arrive, and speaks at once if the turn finishes or the cap is reached. Queueing the next
// utterance ahead in the browser was measured and did not shorten the gap.
//
// ponytail: an engine whose speak() throws would leave the queue waiting for an end that never comes, until the
// next cancel(); the browser engine does not throw, so no try/catch. Add one when an engine can.

import type { StartInfo, TtsEngine } from "./tts-engine";

// The most characters (join spaces included) in one merged utterance. A judgement from one live run per length, not a
// measured threshold: 301, 1193 and 2409 characters played to the end, 553 stopped early by ear, and `onend` fired
// every time, so a cut-off cannot be detected. 1200 is about 73 s of speech; a larger value saves a gap per batch,
// a smaller one loses less if a voice drops out inside a batch. A unit longer than this is spoken alone, not split.
export const MAX_UTTERANCE_CHARS = 1200;

// How long the first utterance of a turn waits after its first unit is ready, for more units to join it. A judgement, not
// measured: about the voice's start delay (0.85 s), so that the second sentence usually arrives before the first one is
// spoken, and short enough that the time to first audio grows by less than a second. It adds up to this much to every
// reply's first audio (less when done arrives first), which has not been listened to or measured with the change in.
export const FIRST_UTTERANCE_WAIT_MS = 700;

export type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
const browserTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type SpeechEvent =
  // A sentence was queued. `index` counts from 0 within the turn.
  | { type: "requested"; index: number }
  // An utterance became audible: `index` is its first unit, `units` how many units were merged into it and `chars` its
  // length. `first` is true once per turn: the first audible audio of the turn (the eval event tts_start). `info` is
  // what the engine reported when it started. `waited` is how long the utterance was held back for more units to join it,
  // from its first unit being ready to being handed to the engine; only the turn's first utterance waits.
  | { type: "start"; index: number; units: number; chars: number; first: boolean; info: StartInfo; waited?: number }
  | { type: "end"; index: number }
  // The engine failed an utterance (or reported it cancelled or interrupted on its own), and so all its units; the
  // queue goes on to the next. `index` is the utterance's first unit, here and in `end`.
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
  private fresh_ = 0; // units queued since the last drop() or the start of the turn
  private now: { units: number; chars: number; audible: boolean } | null = null; // the utterance with the engine
  private finished = false; // finish() was called: no more sentences are coming this turn
  private firstWaitMs: number;
  private timers: Timers;
  private waitFrom: number | null = null; // when the first utterance's wait began (its first unit was ready)
  private waitTimer: unknown = null;
  private waitOver = false; // the first utterance has been handed over, or its wait ended: no second wait this turn

  constructor(engine: TtsEngine, emit: (e: SpeechEvent) => void, options: { firstWaitMs?: number; timers?: Timers } = {}) {
    this.engine = engine;
    this.emit = emit;
    this.firstWaitMs = options.firstWaitMs ?? FIRST_UTTERANCE_WAIT_MS;
    this.timers = options.timers ?? browserTimers;
  }

  // How many sentences this turn has had queued so far.
  get sentences(): number {
    return this.requested;
  }

  // How many units were queued since the last drop() (or the turn began): what the done fallback asks, because the
  // text before a tool call is not in full_response, so units dropped or heard before it do not count as the answer.
  get fresh(): number {
    return this.fresh_;
  }

  // Queue a sentence; it plays after the ones before it.
  enqueue(text: string): void {
    const index = this.requested++;
    this.fresh_++;
    this.waiting.push({ index, text });
    this.emit({ type: "requested", index });
    this.pump();
  }

  // The turn's last sentence has been queued. Returns how many sentences the turn had (0: nothing was said). The
  // turn is over once they have all played; a sentence queued after that starts a new turn.
  finish(): number {
    const sentences = this.requested;
    this.finished = true;
    this.pump(); // a first utterance that is still waiting for more units speaks now
    this.settle();
    return sentences;
  }

  // Drop everything queued and stop what is playing. Safe, and silent, when nothing is happening.
  cancel(): void {
    const active = this.playing || this.waiting.length > 0;
    this.generation++;
    this.waiting = [];
    this.playing = false;
    this.now = null;
    this.endTurn(); // also ends a first utterance's wait
    this.engine.cancel();
    if (active) this.emit({ type: "cancelled" });
  }

  // Drop what has not become audible: every unit that waits, and the utterance with the engine if its audio has not
  // started (the engine is told to cancel it, its late callbacks are ignored, nothing is reported). An audible utterance
  // plays to its end. Returns what was dropped; `chars` is the units' own text, without the join spaces. Numbering and
  // the turn go on, and `fresh` restarts whether or not anything was dropped.
  drop(): { units: number; chars: number } {
    let units = this.waiting.length;
    let chars = this.waiting.reduce((n, u) => n + u.text.length, 0);
    this.waiting = [];
    this.endWait(); // units collected for the first utterance are dropped with the rest; the next unit starts a new wait
    if (this.playing && this.now && !this.now.audible) {
      units += this.now.units;
      chars += this.now.chars;
      this.generation++;
      this.playing = false;
      this.now = null;
      this.engine.cancel();
    }
    this.fresh_ = 0;
    this.settle();
    return { units, chars };
  }

  // How many of the waiting units make the next utterance, and its length (join spaces included): the first, then each one
  // that still fits under MAX_UTTERANCE_CHARS. A unit longer than the cap is taken alone.
  private nextBatch(): { count: number; chars: number } {
    let chars = this.waiting[0].text.length;
    let count = 1;
    while (count < this.waiting.length && chars + 1 + this.waiting[count].text.length <= MAX_UTTERANCE_CHARS) {
      chars += 1 + this.waiting[count].text.length;
      count++;
    }
    return { count, chars };
  }

  // The turn's first utterance (no audio yet this turn, its wait not over) is held back for up to firstWaitMs after its first unit is
  // ready. It is released when the turn finishes, when the batch is full (a unit is left over, or it is exactly the cap),
  // or when the timer ends.
  private holdFirst(): boolean {
    if (this.waitOver || this.started || this.finished || this.firstWaitMs <= 0) return false;
    const { count, chars } = this.nextBatch();
    if (count < this.waiting.length || chars >= MAX_UTTERANCE_CHARS) return false;
    if (this.waitFrom === null) {
      this.waitFrom = this.timers.now();
      this.waitTimer = this.timers.setTimeout(() => {
        this.waitTimer = null;
        this.waitOver = true;
        this.pump();
      }, this.firstWaitMs);
    }
    return true;
  }

  private endWait(): void {
    if (this.waitTimer !== null) this.timers.clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.waitFrom = null;
    this.waitOver = false;
  }

  private pump(): void {
    if (this.playing || this.waiting.length === 0 || this.holdFirst()) return;
    const waited = this.waitFrom === null ? undefined : this.timers.now() - this.waitFrom;
    if (this.waitTimer !== null) this.timers.clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.waitFrom = null;
    this.waitOver = true; // the turn's other utterances are not held back
    const first = this.waiting[0];
    const batch = this.waiting.splice(0, this.nextBatch().count);
    const next = { index: first.index, text: batch.map((u) => u.text).join(" ") };
    const now = { units: batch.length, chars: batch.reduce((n, u) => n + u.text.length, 0), audible: false };
    this.now = now;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.playing = true;
    this.engine.speak(
      next.text,
      (info) => {
        if (!current()) return;
        now.audible = true;
        this.emit({ type: "start", index: next.index, units: batch.length, chars: next.text.length, first: !this.started, info, ...(waited === undefined ? {} : { waited }) });
        this.started = true;
      },
      () => current() && this.advance({ type: "end", index: next.index }),
      (code) => current() && this.advance({ type: "error", index: next.index, code }),
    );
  }

  private advance(e: SpeechEvent): void {
    this.playing = false;
    this.now = null;
    this.emit(e);
    this.pump();
    this.settle();
  }

  private settle(): void {
    if (this.finished && !this.playing && this.waiting.length === 0) this.endTurn();
  }

  private endTurn(): void {
    this.endWait();
    this.requested = 0;
    this.fresh_ = 0;
    this.started = false;
    this.finished = false;
  }
}
