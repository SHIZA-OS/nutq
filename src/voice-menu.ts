// The voice menu under the mic: the ranked English voices (src/voice-pick.ts), the choice kept in local storage under "voice",
// and the Test voice button. It owns the saved name; main.ts reads it through saved() at every utterance.

import { selectVoice, type PickableVoice } from "./voice-pick";

export const VOICE_KEY = "voice";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function readSaved(): string | null {
  try {
    return localStorage.getItem(VOICE_KEY) || null;
  } catch {
    return null; // storage blocked: no saved voice, the menu still works for this visit
  }
}

function writeSaved(name: string | null) {
  try {
    if (name) localStorage.setItem(VOICE_KEY, name);
    else localStorage.removeItem(VOICE_KEY);
  } catch {
    // ponytail: a failed save is dropped; the choice just does not persist
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

// `wantedVoice` is the ?voice= name: while it matches a voice it wins over the menu, so the menu is disabled and says so.
// `onTest` runs when Test voice is pressed; the caller decides whether and how to speak.
export function initVoiceMenu(wantedVoice: string | null, onTest: () => void) {
  const select = byId<HTMLSelectElement>("voice-select");
  let saved = readSaved();
  select.addEventListener("change", () => {
    saved = select.value || null; // "" is Automatic: clears the choice
    writeSaved(saved);
  });
  byId<HTMLButtonElement>("voice-test").addEventListener("click", onTest);
  return {
    saved: () => saved,
    // Rebuild from the voice list, on load and on every voiceschanged, keeping the current choice. Only the ranked English
    // voices are listed (a Firefox list can have thousands); ponytail: two voices with one name share an option, the first wins.
    refresh(voices: PickableVoice[]) {
      const choice = selectVoice(voices, { param: wantedVoice, saved });
      const first = voices.length === 0 ? "Browser default" : choice.source === "param" ? `Set by ?voice= (${choice.voice?.name})` : "Automatic (best available)";
      select.replaceChildren(option("", first), ...choice.ranked.map((v) => option(v.name, `${v.name} (${v.lang})`)));
      select.value = choice.source === "saved" ? (choice.voice?.name ?? "") : "";
      select.disabled = choice.source === "param" || choice.ranked.length === 0;
    },
  };
}
