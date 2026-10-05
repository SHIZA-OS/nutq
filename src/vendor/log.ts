// @ts-nocheck
// Vendored from @moonshine-ai/moonshine-js src/, upstream code not written against
// this project's stricter tsconfig. Deliberate local edits: transcriber.ts (VAD threshold passthrough), model.ts (loadModel retry after failure).
//
// Original work: Copyright (c) 2025 Useful Sensors, Inc., MIT License. The license text is in
// src/vendor/LICENSE; upstream is https://github.com/moonshine-ai/moonshine-js (npm @moonshine-ai/moonshine-js 0.1.29).

import { Settings } from "./constants";

export default class Log {
    static info(text) {
        console.info("[MoonshineJS] " + text)
    }

    static log(text) {
        if (Settings.VERBOSE_LOGGING) {
            console.log("[MoonshineJS] " + text);
        }
    }

    static warn(text) {
        console.warn("[MoonshineJS] " + text);
    }

    static error(text) {
        console.error("[MoonshineJS] " + text);
    }
}
