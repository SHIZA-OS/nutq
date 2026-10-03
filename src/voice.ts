// Speech synthesis voice helpers, pure so they can be tested without a browser voice list.

export type VoiceInfo = { name: string; lang: string; localService: boolean; default: boolean };

export type VoiceChoice<T> = { voice: T | null; source: "param" | "auto_local" | "browser_default" };

// Which voice to speak with:
//   - a name was given and a voice has exactly that name (ignoring case): that voice, source "param";
//   - no name was given: the first local English voice (localService and a lang starting "en"), source
//     "auto_local" (local voices start speaking quickly, which a network voice may not);
//   - otherwise (a name that matches nothing, or no local English voice): null, the browser default,
//     source "browser_default".
export function pickVoice<T extends { name: string; lang: string; localService: boolean }>(voices: T[], wanted: string | null): VoiceChoice<T> {
  if (wanted) {
    const w = wanted.toLowerCase();
    const named = voices.find((v) => v.name.toLowerCase() === w);
    return named ? { voice: named, source: "param" } : { voice: null, source: "browser_default" };
  }
  const local = voices.find((v) => v.localService && v.lang.toLowerCase().startsWith("en"));
  return local ? { voice: local, source: "auto_local" } : { voice: null, source: "browser_default" };
}

// The log lines that list the voices: a summary, then at most `max` voices, then how many were left out.
export function voiceLines(voices: VoiceInfo[], max = 40): string[] {
  const local = voices.filter((v) => v.localService).length;
  const lines = [`Voices: ${voices.length} (${local} local, ${voices.length - local} network). Pick one with ?voice=<exact name>.`];
  for (const v of voices.slice(0, max)) lines.push(`  ${v.name} | ${v.lang} | ${v.localService ? "local" : "network"}${v.default ? " | default" : ""}`);
  if (voices.length > max) lines.push(`  ... and ${voices.length - max} more`);
  return lines;
}
