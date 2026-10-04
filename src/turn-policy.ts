// End-of-turn policy: a pure module with no timers, no DOM and no clock. The caller tells it what
// happened and when (milliseconds, any origin) and acts on what it says about when the turn ends and
// why. main.ts drives it with Date.now() and a setTimeout; the offline replay drives it with time
// taken from frame positions.

// Auto-send-on-silence: a convenience layered on top of push-to-talk, not a
// replacement for it. 5s, not 3s: live testing showed natural mid-sentence
// pauses of ~3s, so 3s risked cutting sentences short; 5s gives real margin.
// The cost is a slow send after every turn. The demo trades that margin for speed with ?silence=1200
// (scripts/demo-chrome-linux.sh adds it to the URL), at the risk that a pause longer than 1.2 s ends the
// turn early. The public default stays 5000 until endpointing work picks a better one.
export const SILENCE_COMMIT_MS = 5000;

// The delay can be set per page with ?silence=<ms>, clamped to this range.
export const MIN_SILENCE_MS = 800;
export const MAX_SILENCE_MS = 8000;

// The auto-silence delay for a ?silence=<ms> URL parameter (null when absent): the default when it
// is absent, empty or not a finite number, otherwise the number rounded and clamped to the range.
export function parseSilenceMs(param: string | null): number {
  if (param === null || param.trim() === "") return SILENCE_COMMIT_MS;
  const n = Number(param);
  if (!Number.isFinite(n)) return SILENCE_COMMIT_MS;
  return Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(n)));
}

export type TurnEnd = { at: number; reason: "auto_silence" | "manual" };

// How long to wait after a speech end, given the transcript so far and how many commits (model calls that
// will add text) are still in flight. A plain number is the same wait every time.
export type WaitFn = (text: string, commitsInFlight: number) => number;

// Whether the text so far reads as a finished thought. "open" means the speaker is probably about to go on.
export type EndHint = "done" | "open" | "unknown";

// Words a sentence does not end on: conjunctions, articles and determiners, prepositions, fillers. The last
// word of the text is checked against this even when the model added a full stop after it ("...flight and.").
// ponytail: tier 1 only. Auxiliary verbs and subject pronouns ("can you", "what is") are left out until the
// replay sweep shows what they buy; "like", "no" and "one" are left out because they end complete utterances.
const OPEN_WORDS = new Set(
  ("and but or so because if that which when while although unless until as the a an this these those my your his her " +
    "our their to of in on at for with from by about into over under between through before after without um uh er erm hmm").split(" "),
);

// Tier 2, a second arm for the replay sweep and off unless asked for: auxiliary verbs, the pronouns that are only ever
// subjects, and a modal before "you" ("can you"). "you" and "it" alone are left out because they end complete utterances
// ("Thank you.", "send it.").
const OPEN_WORDS_TIER2 = new Set(
  "is are was were am be been being has have had do does did will would can could should shall may might must i we they he she".split(" "),
);
const OPEN_PAIR_TIER2 = /\b(can|could|would|will|do|did|should|shall|may|might|must) you$/;

// "done": ends in . ? or ! and its last word is not an open word. "open": ends in ... , ; : or -, or its last
// word (digits count as words) is an open word, punctuation or not. Everything else, including no text, is
// "unknown". Moonshine base leaves out the full stop on about one complete sentence in five, so a missing
// full stop is "unknown", not "open".
export function endHint(text: string, tier2 = false): EndHint {
  const t = text.trimEnd();
  if (/(\.\.\.|\u2026|[,;:-])$/.test(t)) return "open";
  const body = t.replace(/[.?!]+$/, "").trimEnd();
  const last = body.match(/[\p{L}\p{N}']+$/u)?.[0].toLowerCase();
  if (last !== undefined && (OPEN_WORDS.has(last) || (tier2 && OPEN_WORDS_TIER2.has(last)))) return "open";
  if (tier2 && OPEN_PAIR_TIER2.test(body.toLowerCase())) return "open";
  return /[.?!]$/.test(t) ? "done" : "unknown";
}

export type SemanticWaits = { done: number; unknown: number; open: number; floor: number; ceiling: number; tier2?: boolean };

// PLACEHOLDER, not a result: the middle of the replay sweep grid, so that ?endpoint=semantic does something
// before the sweep has run. Replace with the swept values. The code default stays the fixed 5000 either way.
export const SEMANTIC_WAITS: SemanticWaits = { done: 300, unknown: 1500, open: 3500, floor: 150, ceiling: MAX_SILENCE_MS };

// The wait for this text, in ms after a speech end. No text is "unknown". While a commit is in flight the text
// is not final, so the wait is at least the "unknown" one. Clamped to [floor, ceiling].
export function waitFor(text: string | null, w: SemanticWaits, commitsInFlight: number): number {
  let ms = w[endHint(text ?? "", w.tier2)];
  if (commitsInFlight > 0) ms = Math.max(ms, w.unknown);
  return Math.min(w.ceiling, Math.max(w.floor, ms));
}

// The wait for a page's ?silence and ?endpoint parameters. ?silence=<ms> is a fixed wait that ignores the text,
// and it wins over ?endpoint=semantic. ?endpoint=semantic alone (an empty ?silence= counts as absent) is the
// text-dependent wait. Anything else is the fixed default of SILENCE_COMMIT_MS. Semantic is opt-in; it is never
// the default.
export function waitFromParams(silence: string | null, endpoint: string | null): number | WaitFn {
  if (endpoint === "semantic" && (silence === null || silence.trim() === "")) {
    return (text, commitsInFlight) => waitFor(text, SEMANTIC_WAITS, commitsInFlight);
  }
  return parseSilenceMs(silence);
}

export class TurnPolicy {
  private waitFn: WaitFn;
  private armedAt: number | null = null; // the speech end or misfire the wait counts from; null while speaking
  private knownAt = -Infinity; // when the text or the in-flight count last changed the wait
  private text = "";
  private inFlight = 0;
  private ended: TurnEnd | null = null;

  constructor(wait: number | WaitFn = SILENCE_COMMIT_MS) {
    this.waitFn = typeof wait === "number" ? () => wait : wait;
  }

  // Speech started: any pending auto-silence is cancelled.
  speechStart(_at: number): void {
    if (!this.ended) this.armedAt = null;
  }

  // Speech ended: auto-silence is armed to fire one wait later (a second speech end re-arms it).
  speechEnd(at: number): void {
    if (!this.ended) this.armedAt = at;
  }

  // A VAD misfire (a segment too short to count as speech, so no speech end follows) arms auto-silence
  // the same way a speech end does; a later speech start still clears it. Without this a turn whose
  // only speech was a short word ("Yes.", "Stop") was never sent unless the user stopped it by hand.
  misfire(at: number): void {
    if (!this.ended) this.armedAt = at;
  }

  // The transcript so far, at time `at`. The wait is recomputed from it: while armed the deadline moves, and
  // text that arrives after a speech start does not arm anything. If the new text puts the deadline in the
  // past, the turn ends at `at`, the first moment anyone could know. A fixed wait ignores the text.
  transcript(text: string, at: number): void {
    if (this.ended) return;
    this.change(at, () => (this.text = text));
  }

  // How many commits are in flight, at time `at` (see transcript for what changes).
  setCommitsInFlight(n: number, at: number): void {
    if (this.ended) return;
    this.change(at, () => (this.inFlight = n));
  }

  private change(at: number, set: () => void): void {
    const before = this.wait();
    set();
    if (this.wait() !== before) this.knownAt = Math.max(this.knownAt, at);
  }

  // The wait that applies to the transcript and in-flight count as they are now.
  wait(): number {
    return this.waitFn(this.text, this.inFlight);
  }

  // The user stopped the turn: it ends now, with reason "manual". A turn that already ended keeps
  // its first end.
  manualStop(at: number): TurnEnd {
    this.armedAt = null;
    return (this.ended ??= { at, reason: "manual" });
  }

  // When the pending auto-silence would end the turn, so a caller can schedule a timer; null if none.
  endsAt(): number | null {
    if (this.ended || this.armedAt === null) return null;
    return Math.max(this.armedAt + this.wait(), this.knownAt);
  }

  // Time has reached `now`: the end of the turn if there is one (an auto-silence ends at its
  // deadline, not at `now`), else null.
  tick(now: number): TurnEnd | null {
    const at = this.endsAt();
    if (at !== null && now >= at) this.ended = { at, reason: "auto_silence" };
    return this.ended;
  }
}

// What to send when a turn ends: the transcript as it is, or null when it is empty or only whitespace
// (nothing was heard, so nothing goes to the gateway).
export function transcriptToSend(transcript: string): string | null {
  return transcript.trim() === "" ? null : transcript;
}
