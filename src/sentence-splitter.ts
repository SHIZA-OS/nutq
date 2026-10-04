// Sentence splitter for streamed replies: pure, no timers and no DOM, in the style of turn-policy.ts.
//
// Text deltas go in; complete sentences come out as they close. A sentence closes at . ? or ! (a run of them,
// as in "..." or "?!"), then optional closing quotes or brackets, then whitespace. Needing the whitespace is
// what keeps a number like 3.5 whole, even when its deltas split at "3." and "5", and it means the last
// sentence of a reply never closes by itself: flush() returns it at done.
//
// ponytail: only . ? ! end a sentence, so a script with its own terminator (Arabic ؟ and ۔, CJK 。) comes out
// whole from flush(); add the character to END to split on it. A newline does not end a sentence either, so an
// unpunctuated list is one sentence until done.

// A fragment shorter than this is held and joined to the next sentence, so "Hi." is not an utterance of its own.
const MIN_LENGTH = 20;

// Compared lowercase, with any opening quote or bracket removed. A sentence never closes after one of these.
const ABBREVIATIONS = new Set(["dr.", "mr.", "mrs.", "ms.", "e.g.", "i.e.", "vs.", "u.s."]);

const END = /[.?!]+["'”’)\]]*\s/g;

function endsWithAbbreviation(text: string): boolean {
  const word = text.trimEnd().split(/\s/).at(-1) ?? "";
  return ABBREVIATIONS.has(word.replace(/^["'“‘(\[]+/, "").toLowerCase());
}

export class SentenceSplitter {
  private buffer = "";
  private held = ""; // short closed sentences waiting for the next one

  // A delta arrived: the sentences it closed, trimmed and in order (usually none or one; a reply that arrives as
  // one big chunk closes all of its sentences at once).
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let start = 0;
    const end = new RegExp(END);
    for (let m = end.exec(this.buffer); m; m = end.exec(this.buffer)) {
      const stop = m.index + m[0].length;
      const sentence = this.buffer.slice(start, stop).trim();
      if (endsWithAbbreviation(sentence)) continue; // "Dr. " is not the end: keep reading from the same start
      start = stop;
      const text = this.held ? `${this.held} ${sentence}` : sentence;
      if (text.length < MIN_LENGTH) this.held = text;
      else {
        this.held = "";
        out.push(text);
      }
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  // The reply is done: whatever is left, even with no terminator, and anything still held. At most one piece.
  // The splitter is ready for the next reply afterwards.
  flush(): string[] {
    const text = [this.held, this.buffer.trim()].filter(Boolean).join(" ");
    this.reset();
    return text ? [text] : [];
  }

  // Drop everything buffered (a cancelled turn).
  reset(): void {
    this.buffer = "";
    this.held = "";
  }
}
