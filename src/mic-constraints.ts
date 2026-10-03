// Mic constraints MicrophoneTranscriber used to set internally, ported over
// now that we call getUserMedia ourselves (vendored Transcriber has no
// getUserMedia of its own, see src/vendor/transcriber.ts).
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
    sampleRate: 16000,
  },
};

// The constraints to open the mic with. rawMic (the eval-only ?rawmic=1 parameter) turns off
// Chrome's echo cancellation, noise suppression and auto gain, to test whether they are a source of
// run-to-run differences in the audio. It is ignored unless evalMode is on, so it never changes
// what a normal session does.
export function micConstraints(evalMode: boolean, rawMic: boolean): MediaStreamConstraints {
  if (!(evalMode && rawMic)) return MIC_CONSTRAINTS;
  return {
    audio: { ...(MIC_CONSTRAINTS.audio as MediaTrackConstraints), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  };
}
