// @ts-nocheck
// Vendored from @moonshine-ai/moonshine-js src/, upstream code not written against
// this project's stricter tsconfig. Deliberate local edits: transcriber.ts (VAD threshold passthrough), model.ts (loadModel retry after failure).
//
// Original work: Copyright (c) 2025 Useful Sensors, Inc., MIT License. The license text is in
// src/vendor/LICENSE; upstream is https://github.com/moonshine-ai/moonshine-js (npm @moonshine-ai/moonshine-js 0.1.29).

const frameSize = 512
const updateInterval = 16
const vadCommitSeconds = 10

/**
 * Global settings for MoonshineJS.
 */
export const Settings = {
    FRAME_SIZE: frameSize, // as specified by silero v5; changing this is not recommended
    STREAM_UPDATE_INTERVAL: updateInterval,
    STREAM_COMMIT_MIN_INTERVAL: updateInterval * 4,
    STREAM_COMMIT_MAX_INTERVAL: updateInterval * 8,
    STREAM_COMMIT_EMA_THRESHOLD: 0.5,
    STREAM_COMMIT_EMA_PERIOD: 5,
    VAD_COMMIT_INTERVAL: Math.ceil((vadCommitSeconds * 10000) / frameSize),
    BASE_ASSET_PATH: {
        MOONSHINE: "https://download.moonshine.ai/",
        ONNX_RUNTIME: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
        SILERO_VAD: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/dist/"
    },
    VERBOSE_LOGGING: false
}
