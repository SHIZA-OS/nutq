// @ts-nocheck
// Vendored from @moonshine-ai/moonshine-js src/, upstream code not written against
// this project's stricter tsconfig. Deliberate local edits: transcriber.ts (VAD threshold passthrough), model.ts (loadModel retry after failure), constants.ts (asset paths served locally).
//
// Original work: Copyright (c) 2025 Useful Sensors, Inc., MIT License. The license text is in
// src/vendor/LICENSE; upstream is https://github.com/moonshine-ai/moonshine-js (npm @moonshine-ai/moonshine-js 0.1.29).

// Nutq edit: the assets are served from this app's own public/vendor (see docs/THIRD_PARTY.md), not from a CDN.
// Absolute, so the runtimes that import() or fetch() them resolve it the same way wherever the page is hosted.
export const assetURL = (path) => new URL(import.meta.env.BASE_URL + path, location.href).href

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
        MOONSHINE: assetURL("vendor/moonshine/"),
        ONNX_RUNTIME: assetURL("vendor/onnxruntime-web-1.22.0/"),
        SILERO_VAD: assetURL("vendor/vad-web-0.0.24/")
    },
    VERBOSE_LOGGING: false
}
