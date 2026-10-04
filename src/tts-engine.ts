// The text-to-speech engine behind a small interface, so the speech queue (speech-queue.ts) does not care what
// speaks. The browser (Web Speech) engine below is the only one.

import { pickVoice } from "./voice";

// What the engine reports when audio starts: the fields of the eval event tts_start (the main file adds `engine`).
export type StartInfo = Record<string, unknown>;

export interface TtsEngine {
  readonly name: string;
  // Speak one piece of text. Exactly one of onEnd and onError follows onStart (onError alone if it never started);
  // none of them follows cancel(), except that the browser may still report the cancelled utterance's error,
  // which the caller must be ready to ignore. `code` is the engine's own error code, undefined if it gave none.
  speak(text: string, onStart: (info: StartInfo) => void, onEnd: () => void, onError: (code: string | undefined) => void): void;
  // Stop what is playing and anything queued inside the engine.
  cancel(): void;
}

// Speaks with the browser's speechSynthesis. `wantedVoice` is the exact ?voice= name, or null for the browser default.
export function browserEngine(synth: SpeechSynthesis, wantedVoice: string | null): TtsEngine {
  return {
    name: "browser",
    speak(text, onStart, onEnd, onError) {
      const voices = synth.getVoices();
      const choice = pickVoice(voices, wantedVoice);
      // With no voice chosen the browser picks (Chrome by language) and does not say which; the voice it flags as
      // default is the best guess, so the event records where the name came from.
      const used = choice.voice ?? voices.find((v) => v.default) ?? null;
      const utterance = new SpeechSynthesisUtterance(text);
      if (choice.voice) utterance.voice = choice.voice;
      // No voice chosen: ask for English, so the browser does not pick by the system language (the voice it flagged as
      // default was a German one in a real run). voice_source stays browser_default; the browser still picks the voice.
      else utterance.lang = "en-US";
      utterance.onstart = () => onStart({ voice: used?.name ?? null, local_service: used?.localService ?? null, voice_source: choice.source });
      utterance.onend = () => onEnd();
      utterance.onerror = (ev) => onError(ev.error);
      synth.speak(utterance);
    },
    cancel: () => synth.cancel(),
  };
}
