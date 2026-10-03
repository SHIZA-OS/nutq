// Speech synthesis voice helpers, pure so they can be tested without a browser voice list.

export type VoiceInfo = { name: string; lang: string; localService: boolean; default: boolean };

// The voice whose name is `wanted` (exact match, ignoring case), or null: no name given, or no such voice.
export function pickVoice<T extends { name: string }>(voices: T[], wanted: string | null): T | null {
  if (!wanted) return null;
  const w = wanted.toLowerCase();
  return voices.find((v) => v.name.toLowerCase() === w) ?? null;
}

// The log lines that list the voices: a summary, then at most `max` voices, then how many were left out.
export function voiceLines(voices: VoiceInfo[], max = 40): string[] {
  const local = voices.filter((v) => v.localService).length;
  const lines = [`Voices: ${voices.length} (${local} local, ${voices.length - local} network). Pick one with ?voice=<exact name>.`];
  for (const v of voices.slice(0, max)) lines.push(`  ${v.name} | ${v.lang} | ${v.localService ? "local" : "network"}${v.default ? " | default" : ""}`);
  if (voices.length > max) lines.push(`  ... and ${voices.length - max} more`);
  return lines;
}
