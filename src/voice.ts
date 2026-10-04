// Speech synthesis voice helpers, pure so they can be tested without a browser voice list.

export type VoiceInfo = { name: string; lang: string; localService: boolean; default: boolean };

export type VoiceChoice<T> = { voice: T | null; source: "param" | "browser_default" };

// Which voice to speak with. A name was given (?voice=) and a voice has exactly that name (ignoring case):
// that voice, source "param". Otherwise, no name or a name that matches nothing: null, the browser's default
// voice, source "browser_default". (Picking a local voice automatically was tried and removed: local espeak-ng
// voices started quickly but sounded too robotic for the demo.)
export function pickVoice<T extends { name: string }>(voices: T[], wanted: string | null): VoiceChoice<T> {
  if (wanted) {
    const w = wanted.toLowerCase();
    const named = voices.find((v) => v.name.toLowerCase() === w);
    if (named) return { voice: named, source: "param" };
  }
  return { voice: null, source: "browser_default" };
}

// The log lines that list the voices: a summary, then at most `max` voices, then how many were left out.
export function voiceLines(voices: VoiceInfo[], max = 40): string[] {
  const local = voices.filter((v) => v.localService).length;
  const lines = [`Voices: ${voices.length} (${local} local, ${voices.length - local} network). Pick one with ?voice=<exact name>.`];
  for (const v of voices.slice(0, max)) lines.push(`  ${v.name} | ${v.lang} | ${v.localService ? "local" : "network"}${v.default ? " | default" : ""}`);
  if (voices.length > max) lines.push(`  ... and ${voices.length - max} more`);
  return lines;
}

// The text to speak: the reply trimmed, or null when it is empty or only whitespace (nothing to say).
export function speechText(text: string): string | null {
  const t = text.trim();
  return t === "" ? null : t;
}
