// @ts-nocheck
// Vendored from @moonshine-ai/moonshine-js src/, upstream code not written against
// this project's stricter tsconfig. Deliberate local edits: transcriber.ts (VAD threshold passthrough), model.ts (loadModel retry after failure).

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
