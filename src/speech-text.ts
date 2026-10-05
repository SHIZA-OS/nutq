// Turns reply text into text that is fit to be spoken: pure, no timers and no DOM, in the style of turn-policy.ts.
// The transcript card keeps the original text; only the speech uses this.
//
// Markdown markers, emoji, bare URLs and code blocks are dropped; a link keeps its label; . , ? ! : ; stay, because
// they shape the pauses. Each line (a sentence, a heading, a bullet, a table row) ends in its own full stop, so
// the voice pauses between list items instead of running them together.
//
// ponytail: line-based and regex-based, not a markdown parser. Not handled: nested emphasis across lines, reference
// links, symbols such as -> or =>, and a long number followed by a full stop at the start of a line (read as a list marker).

// The text to speak, and whether the text ended inside a fenced code block. A reply streamed in pieces passes the
// inCode of one call to the next; a whole reply starts outside code.
export function speakable(text: string, inCode = false): { text: string; inCode: boolean } {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      if ((raw.match(/```|~~~/g) ?? []).length < 2) inCode = !inCode; // a fence opened and closed on one line is just skipped
      continue;
    }
    if (inCode) continue;
    const line = cleanLine(raw);
    if (line) out.push(line);
  }
  return { text: out.join(" "), inCode };
}

const TERMINAL = /[.?!:;,…؟۔。]["'”’)\]]*$/;

function cleanLine(raw: string): string {
  let s = raw.trim();
  if (/^([-*_]\s*){3,}$/.test(s) || /^\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(s)) return ""; // a rule, a table separator row
  s = s.replace(/^>+\s*/, "").replace(/^#{1,6}\s+/, "").replace(/^([-*+•]|\d+[.)])\s+/, "");
  if (/^\|.*\|$/.test(s)) s = s.split("|").map((c) => c.trim()).filter(Boolean).join(", ");
  s = s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // image alt text, link label
    .replace(/(?:https?:\/\/|www\.)\S*[^\s.,;:!?)\]'"]/g, "") // bare URL, leaving the punctuation after it
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*(?!\s)(.+?)(?<!\s)\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}])_(.+?)_(?![\p{L}\p{N}])/gu, "$1")
    .replace(/\*+|~~/g, "") // markers left unpaired, for instance when the emphasis ran across lines
    .replace(/[\p{Extended_Pictographic}‍️⃣]/gu, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return ""; // nothing left to say
  return TERMINAL.test(s) ? s : `${s}.`;
}
