// @ts-nocheck
// Vendored from @moonshine-ai/moonshine-js src/, upstream code not written against
// this project's stricter tsconfig. Deliberate local edits: transcriber.ts (VAD threshold passthrough), model.ts (loadModel retry after failure), error.ts (ModelLoadFailed).
//
// Original work: Copyright (c) 2025 Useful Sensors, Inc., MIT License. The license text is in
// src/vendor/LICENSE; upstream is https://github.com/moonshine-ai/moonshine-js (npm @moonshine-ai/moonshine-js 0.1.29).

/**
 * Errors that can occur during usage of MoonshineJS, along with a descriptive message.
 * 
 * These are passed to the onError {@link TranscriberCallbacks} when an error occurs so that the developer
 * can implement error handling as necessary for their application. 
 * @enum
 */
export const MoonshineError = {
    PermissionDenied: "Permission to the requested resource was denied.",
    PlatformUnsupported: "This platform (e.g., user browser or device) is not supported.",
    // Nutq addition: Transcriber.load() used to report any failure to load the model as PlatformUnsupported, which is
    // misleading: in practice the cause is a failed or blocked download of the model files.
    ModelLoadFailed: "The speech model could not be loaded. This is usually a network problem or a blocked download of the model files.",
}

export default MoonshineError;