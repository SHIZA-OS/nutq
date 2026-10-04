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

export class ReplyState {
  private flying = false;

  get inFlight(): boolean {
    return this.flying;
  }

  // A message is about to be sent. Returns true and marks a reply in flight, or false (nothing changes) if one
  // already is, in which case the caller must not send.
  trySend(): boolean {
    if (this.flying) return false;
    this.flying = true;
    return true;
  }

  // A frame arrived from the gateway. done, aborted, and an error with a turn-failure code end the turn.
  // Returns true if this frame cleared the flag.
  frame(frame: { type?: unknown; code?: unknown }): boolean {
    const ends =
      frame.type === "done" ||
      frame.type === "aborted" ||
      (frame.type === "error" && typeof frame.code === "string" && TURN_FAILURE_CODES.has(frame.code));
    if (!ends || !this.flying) return false;
    this.flying = false;
    return true;
  }

  // The socket closed: whatever was in flight is gone.
  closed(): void {
    this.flying = false;
  }
}
