// Speech synthesis voice helpers, pure so they can be tested without a browser voice list.

export type VoiceInfo = { name: string; lang: string; localService: boolean; default: boolean };

export type VoiceChoice<T> = { voice: T | null; source: "param" | "auto_local" | "browser_default" };

// "en_US" and "en-us" are the same language tag.
const tag = (lang: string) => lang.toLowerCase().replace(/_/g, "-");

// Which voice to speak with. A name was given (?voice=): the voice with exactly that name, ignoring case,
// source "param"; a name that matches nothing is the browser default, source "browser_default". With no name,
// local voices are preferred (they start speaking quickly), in this order, source "auto_local":
//   1. the browser's default voice, if it is local;
//   2. the first local voice whose lang equals `language` (navigator.language) exactly;
//   3. the first local voice with the same base language (the part before "-", for example "en");
// and otherwise null, the browser default, source "browser_default".
export function pickVoice<T extends { name: string; lang: string; localService: boolean; default: boolean }>(
  voices: T[],
  wanted: string | null,
  language: string,
): VoiceChoice<T> {
  const none: VoiceChoice<T> = { voice: null, source: "browser_default" };
  if (wanted) {
    const w = wanted.toLowerCase();
    const named = voices.find((v) => v.name.toLowerCase() === w);
    return named ? { voice: named, source: "param" } : none;
  }
  const auto = (voice: T | undefined): VoiceChoice<T> => (voice ? { voice, source: "auto_local" } : none);
  const def = voices.find((v) => v.default);
  if (def?.localService) return auto(def);
  const want = tag(language ?? "");
  if (!want) return none;
  const local = voices.filter((v) => v.localService);
  return auto(local.find((v) => tag(v.lang) === want) ?? local.find((v) => tag(v.lang).split("-")[0] === want.split("-")[0]));
}

// The log lines that list the voices: a summary, then at most `max` voices, then how many were left out.
export function voiceLines(voices: VoiceInfo[], max = 40): string[] {
  const local = voices.filter((v) => v.localService).length;
  const lines = [`Voices: ${voices.length} (${local} local, ${voices.length - local} network). Pick one with ?voice=<exact name>.`];
  for (const v of voices.slice(0, max)) lines.push(`  ${v.name} | ${v.lang} | ${v.localService ? "local" : "network"}${v.default ? " | default" : ""}`);
  if (voices.length > max) lines.push(`  ... and ${voices.length - max} more`);
  return lines;
}
