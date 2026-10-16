// Which browser voice to speak with, pure so it can be tested without a browser voice list and with no DOM.
//
// The browser's own pick is unreliable (a German voice was the default in a real run), so English voices are ranked here and
// the best one is used unless the user chose another. Nothing in this file knows what a good voice sounds like beyond the
// name patterns and languages below; they are judgements, not measurements.

export type PickableVoice = { name: string; lang: string; voiceURI?: string; default?: boolean };

// Where the voice came from, in the order the choice is made. `lang_only`: no voice is set on the utterance, only lang en-US.
export type VoiceSource = "param" | "saved" | "ranked" | "lang_only";
export type VoiceSelection<T> = { voice: T | null; source: VoiceSource; ranked: T[] };

const isEnglish = (v: PickableVoice) => v.lang.toLowerCase().startsWith("en");

// "English (America)+klatt2" is an espeak variant of "English (America)"; the base name, or null for a plain voice.
const variantBase = (name: string): string | null => /^(.+?)\+\S+$/.exec(name.trim())?.[1].trim() ?? null;

// Names that usually mean a neural or cloud voice. One tier, not a scale: ponytail: Premium is not told from Enhanced, add
// weights if a real list shows the order matters.
const QUALITY = /natural|neural|online|google|enhanced|premium/i;

const langRank = (lang: string) => {
  const l = lang.toLowerCase().replace("_", "-");
  return l === "en-us" ? 0 : l === "en-gb" ? 1 : 2;
};

// The English voices, best first: no "+variant" voice when a plain English one exists, then quality names, then en-US, en-GB,
// other English, then the browser's default voice, then the order the browser listed them (sort is stable).
export function rankVoices<T extends PickableVoice>(voices: T[]): T[] {
  const english = voices.filter(isEnglish);
  const plain = english.filter((v) => variantBase(v.name) === null);
  const pool = plain.length > 0 ? plain : english;
  return [...pool].sort(
    (a, b) =>
      Number(QUALITY.test(b.name)) - Number(QUALITY.test(a.name)) ||
      langRank(a.lang) - langRank(b.lang) ||
      Number(!!b.default) - Number(!!a.default),
  );
}

// True only when every English voice looks like espeak: it has a "+variant" sibling or is one, or its name or URI says
// espeak. localService is not used: Firefox reports its local espeak voices as network voices. No English voice is false.
export function isRobotic(voices: PickableVoice[]): boolean {
  const english = voices.filter(isEnglish);
  const bases = new Set(english.map((v) => variantBase(v.name)));
  return english.length > 0 && english.every((v) => variantBase(v.name) !== null || bases.has(v.name.trim()) || /espeak/i.test(`${v.name} ${v.voiceURI ?? ""}`));
}

// The choice: ?voice= (any voice, by name ignoring case), else a saved one that is still among the ranked English voices,
// else the best ranked voice, else no voice (lang only). Run it again whenever the voice list changes; the browser lists voices late.
export function selectVoice<T extends PickableVoice>(voices: T[], pref: { param?: string | null; saved?: string | null }): VoiceSelection<T> {
  const ranked = rankVoices(voices);
  const named = (name: string | null | undefined, list: T[]) => (name ? list.find((v) => v.name.toLowerCase() === name.toLowerCase()) : undefined);
  const param = named(pref.param, voices);
  if (param) return { voice: param, source: "param", ranked };
  const saved = named(pref.saved, ranked);
  if (saved) return { voice: saved, source: "saved", ranked };
  if (ranked.length > 0) return { voice: ranked[0], source: "ranked", ranked };
  return { voice: null, source: "lang_only", ranked };
}
