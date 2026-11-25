// Hands-free listening loop: a pure module with no timers, no DOM and no clock, in the style of turn-state.ts and turn-policy.ts.
// The caller tells it what happened and when (milliseconds, any origin), asks nextAt() for the one deadline to wait for, calls
// tick() when it passes, and does what the returned actions say. It never touches the microphone itself.
//
// One tap starts the loop; then it goes round: the mic listens, the message is sent, the mic stays closed while the answer is
// awaited and spoken, and it opens again once the turn is over:
//
//   off        the toggle is off; the page behaves exactly as it does without this module
//   armed      the toggle is on and the loop is stopped; the next tap starts it (the page is in tap mode)
//   opening    the mic is being started, not live yet
//   listening  the mic is live; an idle deadline runs until speech starts
//   waiting    a message was sent; the mic is closed until the turn ends
//   speaking   the turn ended with `done` but speech is still queued or playing; the mic stays closed
//   reopening  the turn is over and the speech is idle; the guard delay runs
//
// The mic reopens only from `reopening`, which is entered only from `waiting` (a `done` with the speech idle) or `speaking` (the
// speech drained), and only leaves it by the guard delay running out or a tap. So it never reopens before the answer is spoken, and
// never while the speech queue holds units back for the first utterance (that is not idle).

// How long the loop waits, once the turn is fully over (done, and nothing left to say), before it opens the mic: the tail of the
// last word and the speaker's own echo are not picked up as the next utterance. A judgement, not measured: no recording of a
// reply played over speakers was used to choose it, and a room with a long echo may need more.
export const REOPEN_GUARD_MS = 300;

// How long the mic stays open with no speech start before the loop stops listening on its own, so a mic left open in an empty
// room does not stay live. A judgement, not measured.
export const IDLE_STOP_MS = 10000;

export type LoopState = "off" | "armed" | "opening" | "listening" | "waiting" | "speaking" | "reopening";

// open: start the mic through the page's one start path. stop: end listening without sending anything. idle_stop: stop listening
// without sending because nothing was said (the caller also tells the user). paused: the loop turned itself off because of a
// failure, not because the user asked: an error or abort from the agent, or the microphone stopping; the caller tells the user.
export type LoopAction = { type: "open" } | { type: "stop" } | { type: "idle_stop" } | { type: "paused"; reason: "agent_error" | "mic" };

// What finishing an utterance came to: sent, held back behind a reply still in flight, nothing said (empty or noise), or nothing
// could be sent (not connected, or the finish failed).
export type FinishResult = "sent" | "held" | "empty" | "none";

// done is a finished reply; aborted and a terminal error frame end the turn too, and they turn the loop off.
export type TurnEndKind = "done" | "aborted" | "error";

export class ListenLoop {
  private s: LoopState = "off";
  private runStart: number | null = null; // when the mic first went live in this listening run; an empty result restarts the mic but not this
  private inSpeech = false; // speech started in this run: the idle deadline is off until the utterance is finished
  private stopping = false; // a tap is finishing the utterance: the idle deadline is off
  private guardEnds: number | null = null;
  private overAt: number | null = null; // when the turn was fully over (or the user took the floor), for the reopen delay

  get state(): LoopState {
    return this.s;
  }

  get on(): boolean {
    return this.s !== "off";
  }

  private go(s: LoopState): void {
    this.s = s;
    if (s !== "reopening") this.guardEnds = null;
    if (s !== "opening" && s !== "listening") {
      this.runStart = null;
      this.inSpeech = false;
      this.stopping = false;
    }
    if (s !== "opening" && s !== "reopening") this.overAt = null;
  }

  // The toggle. Off from any state; on from off. Turning it off never stops a mic that is open: that carries on in tap mode.
  setOn(on: boolean): void {
    if (!on) this.go("off");
    else if (this.s === "off") this.go("armed");
  }

  // The user tapped the mic. `micOpen` is whether the page is listening right now. A tap while the mic is open is a stop: its
  // result comes through finished(). A tap while the mic is closed opens it, from the armed state (the first tap, not a reopen) and
  // from waiting, speaking and reopening (the user taking the floor: the page mutes the reply and the mic opens at once).
  tap(now: number, micOpen: boolean): void {
    switch (this.s) {
      case "armed":
        if (!micOpen) {
          this.overAt = null;
          this.go("opening");
        }
        break;
      case "opening":
      case "listening":
        this.stopping = true;
        break;
      case "waiting":
      case "speaking":
      case "reopening":
        this.overAt = now;
        this.go("opening");
        break;
    }
  }

  // The VAD heard speech start.
  speechStart(): void {
    if (this.s === "listening") this.inSpeech = true;
  }

  // The mic is live (the page's start path resolved, the VAD started, audio resumed). Null when the loop is not waiting for that.
  // `reopenDelayMs` is how long after the turn was fully over this was, or null for the first start of a loop.
  micLive(now: number): { reopenDelayMs: number | null } | null {
    if (this.s !== "opening") return null;
    const reopenDelayMs = this.overAt === null ? null : now - this.overAt;
    this.go("listening");
    if (this.runStart === null) this.runStart = now;
    this.overAt = null;
    return { reopenDelayMs };
  }

  // The utterance was finished (a tap, or the auto-silence). A message that went out, or is held back, makes the loop wait for the
  // reply. An empty or noise result by auto-silence listens again at once; by a tap, or a result that could not be sent, it turns
  // the loop off.
  finished(result: FinishResult, trigger: "manual" | "auto_silence", now: number): LoopAction[] {
    if (this.s !== "opening" && this.s !== "listening") return [];
    if (result === "sent" || result === "held") {
      this.go("waiting");
      return [];
    }
    if (result === "empty" && trigger === "auto_silence") {
      this.inSpeech = false;
      this.overAt = now;
      this.go("opening");
      return [{ type: "open" }];
    }
    this.go("armed");
    return [];
  }

  // A message went out outside finished(): a held message, sent when the turn ended.
  sent(): void {
    if (this.s === "reopening" || this.s === "speaking") this.go("waiting");
  }

  // The turn in flight ended. `speechIdle` is whether nothing is queued, held back or playing right now. Only `done` goes on
  // round; aborted and a terminal error turn the loop off (a mic that is open stays open, in tap mode). A turn end in a state past
  // its turn (speaking, reopening), or while the user is already speaking again after a mute, changes nothing.
  turnEnd(kind: TurnEndKind, speechIdle: boolean, now: number): LoopAction[] {
    if (kind !== "done") {
      if (this.s !== "opening" && this.s !== "listening" && this.s !== "waiting") return [];
      this.go("armed");
      return [{ type: "paused", reason: "agent_error" }];
    }
    if (this.s !== "waiting") return [];
    if (speechIdle) this.startGuard(now);
    else this.go("speaking");
    return [];
  }

  // The speech queue drained after the done.
  speechDrained(now: number): LoopAction[] {
    if (this.s === "speaking") this.startGuard(now);
    return [];
  }

  private startGuard(now: number): void {
    this.go("reopening");
    this.guardEnds = now + REOPEN_GUARD_MS;
    this.overAt = now;
  }

  // The socket closed or the reply timed out. The loop turns off; a mic the loop has open is stopped and nothing is sent. A mic
  // open in tap mode (armed) is left alone.
  socketClosed(): LoopAction[] {
    if (this.s === "off" || this.s === "armed") return [];
    const micOpen = this.s === "opening" || this.s === "listening";
    this.go("armed");
    return micOpen ? [{ type: "stop" }] : [];
  }

  // The mic failed to start, the transcriber reported an error: the loop turns off, and says so if it was running.
  fault(): LoopAction[] {
    if (this.s === "off" || this.s === "armed") return [];
    this.go("armed");
    return [{ type: "paused", reason: "mic" }];
  }

  private idleAt(): number | null {
    return this.s === "listening" && !this.inSpeech && !this.stopping && this.runStart !== null ? this.runStart + IDLE_STOP_MS : null;
  }

  // When the next deadline falls (the guard, or the idle stop), so the caller can keep one timer; null if there is none.
  nextAt(): number | null {
    return this.s === "reopening" ? this.guardEnds : this.idleAt();
  }

  // Time has reached `now`.
  tick(now: number): LoopAction[] {
    if (this.s === "reopening" && this.guardEnds !== null && now >= this.guardEnds) {
      this.go("opening"); // overAt stays, for the reopen delay
      return [{ type: "open" }];
    }
    const idle = this.idleAt();
    if (idle !== null && now >= idle) {
      this.go("armed");
      return [{ type: "idle_stop" }];
    }
    return [];
  }
}
