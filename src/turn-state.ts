// Reply-in-flight state: a pure module with no timers, no DOM and no socket, in the style of turn-policy.ts.
//
// The gateway has no per-turn id, and a message sent while a turn is still running is not a new turn: it
// is steering, merged into the running turn's stream and its single `done`. So the client must not send
// while a reply is in flight. The flag is set when a message is sent and cleared by the frames that end a
// turn (and by a closed socket); everything else leaves it alone.

// Error codes the gateway sends when a running turn fails (ws.rs, ws_turn_failure_frame). Other error codes
// (EMPTY_CONTENT, INVALID_JSON, STEERING_QUEUE_FULL, STEERING_CLOSED, SOP_*, SESSION_QUEUE_*, INVALID_*, ...)
// are replies to a bad or refused message and do not end the turn.
const TURN_FAILURE_CODES = new Set(["PROVIDER_ERROR", "AUTH_ERROR", "AGENT_ERROR"]);

// Safety net: if no frame ends the turn this long after the message was sent (a gateway that hangs, a lost
// frame), the flag is cleared so the user is not blocked forever. A turn that really takes longer than this is
// let through as steering, which is what the guard exists to avoid, so it is a ceiling and not a typical wait.
export const REPLY_TIMEOUT_MS = 60000;

export class ReplyState {
  private sentAt: number | null = null;
  private timeoutMs: number;

  constructor(timeoutMs: number = REPLY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  get inFlight(): boolean {
    return this.sentAt !== null;
  }

  // A message is about to be sent at time `now` (milliseconds, any origin). Returns true and marks a reply in
  // flight, or false (nothing changes) if one already is, in which case the caller must not send.
  trySend(now: number): boolean {
    if (this.sentAt !== null) return false;
    this.sentAt = now;
    return true;
  }

  // A frame arrived from the gateway. done, aborted, and an error with a turn-failure code end the turn.
  // Returns true if this frame cleared the flag.
  frame(frame: { type?: unknown; code?: unknown }): boolean {
    const ends =
      frame.type === "done" ||
      frame.type === "aborted" ||
      (frame.type === "error" && typeof frame.code === "string" && TURN_FAILURE_CODES.has(frame.code));
    if (!ends || this.sentAt === null) return false;
    this.sentAt = null;
    return true;
  }

  // The socket closed: whatever was in flight is gone.
  closed(): void {
    this.sentAt = null;
  }

  // When the flag clears by itself, so the caller can keep one timer: null whenever nothing is in flight, which
  // is also how every normal clear (a frame, a close) cancels it.
  timesOutAt(): number | null {
    return this.sentAt === null ? null : this.sentAt + this.timeoutMs;
  }

  // Time has reached `now`: if the reply has been in flight for the whole timeout, clear the flag and return true.
  tick(now: number): boolean {
    if (this.sentAt === null || now < this.sentAt + this.timeoutMs) return false;
    this.sentAt = null;
    return true;
  }
}
