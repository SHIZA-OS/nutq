# Third-party software and assets

What Nutq ships, bundles or downloads at runtime, where each piece comes from, under which license, and whether it
may be redistributed inside this MIT repository. Audited on 2026-10-05 against the installed `node_modules`, a
production build, and a real page load with the network requests recorded.

Nutq's own code is MIT, see [LICENSE](../LICENSE). Nothing below changes that; each item keeps its own license.

"Redistribution OK" means the license text found allows copying the file into this repository provided the notices
are kept. It is a reading of the license files named in the "Where found" column, not legal advice.

## 1. What the page loads at runtime

Every asset below is bundled in `public/vendor/` or `public/fonts/` and served from the app's own origin. Before
they were bundled, the same files came from `cdn.jsdelivr.net`, `download.moonshine.ai`
and Google Fonts; the URLs below are those original sources, recorded in headless Chrome on 2026-10-05, and the
files were downloaded from them.

| Bundled file | Original source | Size in bytes | SHA-256 |
|---|---|---|---|
| `public/vendor/moonshine/model/base/quantized/encoder_model.onnx` | `https://download.moonshine.ai/model/base/quantized/encoder_model.onnx` | 20,513,063 | `1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751` |
| `public/vendor/moonshine/model/base/quantized/decoder_model_merged.onnx` | `https://download.moonshine.ai/model/base/quantized/decoder_model_merged.onnx` | 42,498,870 | `cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3` |
| `public/vendor/onnxruntime-web-1.22.0/ort-wasm-simd-threaded.jsep.mjs` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.jsep.mjs` | 44,677 | `1cbcba8f2c769c1eecbab66a1b1e55ef11704515bf4306373e3db3c37cf6dcd8` |
| `public/vendor/onnxruntime-web-1.22.0/ort-wasm-simd-threaded.jsep.wasm` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.jsep.wasm` | 21,872,216 | `b45970d0632383a057c27ca5b660b216f8e00c17cf8db9f6207b5e4abc839368` |
| `public/vendor/onnxruntime-web-1.14.0/ort-wasm-simd.wasm` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm-simd.wasm` | 10,014,674 | `9bd07bababc65f53d061f457233eeae501be7ceb8a2adb9eef52d87fe776d865` |
| `public/vendor/vad-web-0.0.24/silero_vad_v5.onnx` | `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/dist/silero_vad_v5.onnx` | 2,327,524 | `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` |
| `public/vendor/vad-web-0.0.24/vad.worklet.bundle.min.js` | `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/dist/vad.worklet.bundle.min.js` | 2,642 | `c187b8546aa8e8d91c8cbfccdd00407ca44724e7f3369770a5524efc76d441a0` |
| `public/fonts/*.woff2` (7 files) | the files Google Fonts' CSS pointed to on 2026-10-05 | see the directory | not recorded |

The Silero model, the worklet and the 1.14.0 wasm were compared byte for byte with the copies inside the installed npm
packages `@ricky0123/vad-web@0.0.24` and its nested `onnxruntime-web@1.14.0`, and are identical.

Each directory holds the license files of what is in it (`LICENSE`, `ThirdPartyNotices.txt`, `LICENSE-*`, `OFL-*.txt`).
They are the same texts that section 2 cites. The pinned versions and base paths are set in
`src/vendor/constants.ts` (`Settings.BASE_ASSET_PATH`, through `assetURL`) and, for the VAD runtime, in
`src/vendor/transcriber.ts` (`onnxWASMBasePath`). The VAD also fetches `vad.worklet.bundle.min.js` from its base path;
that request comes from the audio thread and is not visible to Playwright, which is why the test checks it separately.

Only the files requested on a plain load are bundled. ONNX Runtime 1.14.0 has threaded wasm variants
(`ort-wasm-simd-threaded.wasm` and others) that it would request only if the page were cross-origin isolated
(COOP and COEP headers); those are not bundled and that setup is untested.

## 2. Runtime assets

| Asset | Version / source | License | Where the license was found | Redistribution OK |
|---|---|---|---|---|
| Moonshine base encoder and decoder weights (quantized, English) | `download.moonshine.ai/model/base/quantized/` (no version published there; `last-modified` header 2026-08-01) | MIT, Copyright (c) 2025 Useful Sensors, Inc. (dba Moonshine AI) | `LICENSE` in https://github.com/moonshine-ai/moonshine at commit `547d00660e70aa976d506842cb1c851688043024` (2026-08-24): "the English Tiny and Base models" are MIT; only the legacy non-English models listed there are under the Moonshine Community License. Also the `LICENSE` inside the npm package `@moonshine-ai/moonshine-js` 0.1.29, which says the English model is MIT. The Hugging Face card for `moonshine-ai/moonshine-base` says `license: mit` | Yes, with the MIT notice. `download.moonshine.ai` serves no license file next to the weights (`/LICENSE`, `/model/base/LICENSE` and `/model/base/quantized/LICENSE` all return 404), and we did not byte-compare the ONNX files with the Hugging Face release, so the MIT status rests on the upstream license text naming the English Base model |
| ONNX Runtime Web wasm 1.22.0 (`ort-wasm-simd-threaded.jsep.mjs`, `.jsep.wasm`) | npm `onnxruntime-web@1.22.0`, via jsDelivr | MIT, Copyright (c) Microsoft Corporation | `LICENSE` of https://github.com/microsoft/onnxruntime at tag `v1.22.0`. The npm package and the jsDelivr listing contain no license file; `package.json` says MIT | Yes, with the MIT notice. The wasm build contains third-party components; their notices are in `ThirdPartyNotices.txt` of the same tag |
| ONNX Runtime Web wasm 1.14.0 (`ort-wasm-simd.wasm`) | npm `onnxruntime-web@1.14.0`, via jsDelivr (this is the version `@ricky0123/vad-web@0.0.24` depends on) | MIT, Copyright (c) Microsoft Corporation | `LICENSE` of https://github.com/microsoft/onnxruntime at tag `v1.14.0` (identical text to v1.22.0) | Yes, same conditions |
| Silero VAD v5 model (`silero_vad_v5.onnx`) and the VAD audio worklet (`vad.worklet.bundle.min.js`) | npm `@ricky0123/vad-web@0.0.24`, via jsDelivr | model: MIT, Copyright (c) 2020-present Silero Team; worklet (vad-web code): ISC, Copyright (c) 2022-present ricky0123 | model: `LICENSE` of https://github.com/snakers4/silero-vad at commit `caddb3b7ce1dee88a14d5621a0e9a8fdeb2c2c48`. Worklet: `LICENSE` of https://github.com/ricky0123/vad at commit `2778c913ad04c2b49635ac900a44066dafc81a83`; `package.json` of the npm package says ISC, and the package contains no license file | Yes for both, with their notices. The file is byte-identical to the copy inside the npm package; we did not compare it with the file in the silero-vad repository |
| Amiri (regular, italic; latin and arabic subsets) | Google Fonts | SIL Open Font License 1.1, Copyright 2010-2022 The Amiri Project Authors | `ofl/amiri/OFL.txt` in https://github.com/google/fonts, commit `39d11bc313031c9f68e21a297ce5e4a15cc5365e` | Yes (OFL permits bundling and redistribution of unmodified fonts) |
| Cormorant Garamond (300, 500; latin subset) | Google Fonts | SIL OFL 1.1, Copyright 2015 the Cormorant Project Authors | `ofl/cormorantgaramond/OFL.txt`, commit `6a386aadc0a33dd3d810b833d9c5105345cbb0e6` | Yes |
| DM Sans (400, 500, 600; latin subset) | Google Fonts | SIL OFL 1.1, Copyright 2014 The DM Sans Project Authors | `ofl/dmsans/OFL.txt`, commit `c26e50af610a8300ad53a2b4955828e329a52d39` | Yes |
| JetBrains Mono (400, 500; latin subset) | Google Fonts | SIL OFL 1.1, Copyright 2020 The JetBrains Mono Project Authors | `ofl/jetbrainsmono/OFL.txt`, commit `2e05c1cf00a6e4f40a4b931600a90881c26e15cd` | Yes |

## 3. Code in the production bundle

Found by building with source maps and listing the `node_modules` sources inside the output. All are MIT or ISC; the
notices are listed here because the minified bundle carries none.

| Package | Version | License | Notes |
|---|---|---|---|
| `onnxruntime-web` | 1.27.0 (top level) | MIT, Copyright (c) Microsoft Corporation | A direct dependency (pinned). Its JavaScript is bundled; the wasm it loads at runtime is the 1.22.0 build above, because `src/vendor/model.ts` sets `ort.env.wasm.wasmPaths` to `Settings.BASE_ASSET_PATH.ONNX_RUNTIME` |
| `onnxruntime-common` | 1.21.0 | MIT | Dependency of `onnxruntime-web` (installed by npm, not listed in `package.json`) |
| `@ricky0123/vad-web` | 0.0.24 | ISC, Copyright (c) 2022-present ricky0123 | A direct dependency (pinned); it brings its own `onnxruntime-web` 1.14.0 |
| `llama-tokenizer-js` | 1.2.2 | MIT, Copyright 2023 belladore.ai | A direct dependency (pinned); used by `src/vendor/model.ts` to decode tokens |

`@moonshine-ai/moonshine-js` is not a dependency: no source file imports it. Its MIT-licensed source is the origin of the vendored files in section 4 (copied from version 0.1.29).

## 4. Vendored source

`src/vendor/constants.ts`, `error.ts`, `log.ts`, `model.ts` and `transcriber.ts` are copies of
`@moonshine-ai/moonshine-js` 0.1.29 `src/`, with local edits (listed in the header of each file). Compared with the
installed package, `constants.ts`, `error.ts` and `log.ts` differ only by the header; `model.ts` and `transcriber.ts` carry the
edits. They are MIT, Copyright (c) 2025 Useful Sensors, Inc. Each file now carries a notice header and the license text
is in [src/vendor/LICENSE](../src/vendor/LICENSE). `src/vendor/pre-roll.ts` is original to this project.

## 5. Development dependencies (not shipped in the build)

| Package | Version | License |
|---|---|---|
| `vite` | 8.2.2 | MIT, Copyright (c) 2019-present, VoidZero Inc. and Vite contributors |
| `typescript` | 6.0.3 | Apache-2.0 |
| `playwright-core` | 1.63.0 | Apache-2.0 |

`public/favicon.svg` and `public/icons.svg` are byte-identical to the files in `packages/create-vite/template-vanilla-ts/public`
of https://github.com/vitejs/vite (compared on 2026-10-05), so they fall under the Vite MIT license. `icons.svg` is not
referenced by the app.

## 6. Not shipped, used by the user's browser

The Web Speech API (`speechSynthesis`) uses the voices the user's browser and operating system provide. Nothing is
downloaded or bundled by Nutq.

## 7. Not found

Nothing in the list above was left without a license. Two gaps in the evidence are stated in the table: the Moonshine
weights have no license file at their download host, and the Silero model was not compared byte for byte with the file in
its upstream repository (only with the npm package copy).
