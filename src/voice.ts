// Speech synthesis voice helpers, pure so they can be tested without a browser voice list.

export type VoiceInfo = { name: string; lang: string; localService: boolean; default: boolean };

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

// The eval event for an utterance's onerror. A cancelled or interrupted utterance is not a failure (it is what
// speechSynthesis.cancel() produces, or another utterance taking over), so it is tts_cancelled; any other code is
// tts_error. `code` is a SpeechSynthesisErrorCode, undefined if the browser gave none.
export function ttsErrorEvent(code: string | undefined): { event: "tts_cancelled"; fields: { reason: string } } | { event: "tts_error"; fields: { message: string } } {
  if (code === "canceled" || code === "interrupted") return { event: "tts_cancelled", fields: { reason: code } };
  return { event: "tts_error", fields: { message: code ?? "unknown" } };
}

