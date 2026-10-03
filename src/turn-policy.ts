// End-of-turn policy: a pure module with no timers, no DOM and no clock. The caller tells it what
// happened and when (milliseconds, any origin) and acts on what it says about when the turn ends and
// why. main.ts drives it with Date.now() and a setTimeout; the offline replay drives it with time
// taken from frame positions.

// Auto-send-on-silence: a convenience layered on top of push-to-talk, not a
// replacement for it. 5s, not 3s: live testing showed natural mid-sentence
// pauses of ~3s, so 3s risked cutting sentences short; 5s gives real margin.
export const SILENCE_COMMIT_MS = 5000;

export type TurnEnd = { at: number; reason: "auto_silence" | "manual" };

export class TurnPolicy {
  private silenceMs: number;
  private deadline: number | null = null;
  private ended: TurnEnd | null = null;

  constructor(silenceMs: number = SILENCE_COMMIT_MS) {
    this.silenceMs = silenceMs;
  }

  // Speech started: any pending auto-silence is cancelled.
  speechStart(_at: number): void {
    if (!this.ended) this.deadline = null;
  }

  // Speech ended: auto-silence is armed to fire silenceMs later (a second speech end re-arms it).
  speechEnd(at: number): void {
    if (!this.ended) this.deadline = at + this.silenceMs;
  }

  // A VAD misfire (a segment too short to count as speech, so no speech end follows) arms auto-silence
  // the same way a speech end does; a later speech start still clears it. Without this a turn whose
  // only speech was a short word ("Yes.", "Stop") was never sent unless the user stopped it by hand.
  misfire(at: number): void {
    if (!this.ended) this.deadline = at + this.silenceMs;
  }

  // The user stopped the turn: it ends now, with reason "manual". A turn that already ended keeps
  // its first end.
  manualStop(at: number): TurnEnd {
    this.deadline = null;
    return (this.ended ??= { at, reason: "manual" });
  }

  // When the pending auto-silence would end the turn, so a caller can schedule a timer; null if none.
  endsAt(): number | null {
    return this.ended ? null : this.deadline;
  }

  // Time has reached `now`: the end of the turn if there is one (an auto-silence ends at its
  // deadline, not at `now`), else null.
  tick(now: number): TurnEnd | null {
    if (!this.ended && this.deadline !== null && now >= this.deadline) {
      this.ended = { at: this.deadline, reason: "auto_silence" };
    }
    return this.ended;
  }
}

// What to send when a turn ends: the transcript as it is, or null when it is empty or only whitespace
// (nothing was heard, so nothing goes to the gateway).
export function transcriptToSend(transcript: string): string | null {
  return transcript.trim() === "" ? null : transcript;
}
