// @ts-nocheck
// Vendored from @moonshine-ai/moonshine-js src/, upstream code not written against
// this project's stricter tsconfig. Deliberate local edits: transcriber.ts (VAD threshold passthrough, pre-roll, pause gate counts recorded frames only, serialized model calls, encoder minimum-length guard in commit(), onMisfire callback, onCommitsInFlight callback), model.ts (loadModel retry after failure).
//
// Original work: Copyright (c) 2025 Useful Sensors, Inc., MIT License. The license text is in
// src/vendor/LICENSE; upstream is https://github.com/moonshine-ai/moonshine-js (npm @moonshine-ai/moonshine-js 0.1.29).

import { Settings, assetURL } from "./constants";
import MoonshineModel from "./model";
import MoonshineError from "./error";
import { AudioNodeVAD } from "@ricky0123/vad-web";
import Log from "./log";
import { PreRoll } from "./pre-roll";

/**
 * Silero VAD sensitivity knobs, forwarded straight through to
 * `AudioNodeVAD.new()`. Undefined fields fall back to vad-web's own "v5"
 * model defaults (positiveSpeechThreshold 0.5, negativeSpeechThreshold
 * 0.35, minSpeechFrames 9, redemptionFrames 24). Raise positiveSpeechThreshold
 * / minSpeechFrames to make the VAD less trigger-happy on background noise.
 */
export interface VADThresholdOptions {
    positiveSpeechThreshold?: number;
    negativeSpeechThreshold?: number;
    minSpeechFrames?: number;
    redemptionFrames?: number;
}

/**
 * Callbacks are invoked at different phases of the lifecycle as audio is transcribed. You can control the behavior of the application
 * in response to model loading, starting of transcription, stopping of transcription, and updates to the transcription of the audio stream.
 *
 * @property onPermissionsRequested() - called when permissions to a user resource (e.g., microphone) have been requested (but not necessarily granted yet)
 *
 * @property onError(error: {@link MoonshineError}) - called when an error occurs.
 *
 * @property onModelLoadStarted() - called when the {@link MoonshineModel} and VAD begins to load (or download, if hosted elsewhere)
 *
 * @property onModelLoaded() - called when the {@link MoonshineModel} and VAD are loaded. This means the Transcriber is now ready to use.
 *
 * @property onTranscribeStarted() - called once when transcription starts
 *
 * @property onTranscribeStopped() - called once when transcription stops
 *
 * @property onTranscriptionUpdated(text: string) - when `useVAD === false` (i.e., streaming mode), this callback is invoked on a rapid
 * interval ({@link Settings.STREAM_UPDATE_INTERVAL}), with the speculative transcription of the audio.
 *
 * @property onTranscriptionCommitted(text: string, buffer?: AudioBuffer) - called every time a transcript is "committed"; when `useVAD === false` (streaming mode),
 * the transcript is committed between brief pauses in speech. When `useVAD === true`, the transcript is committed after speech events, or during brief pauses in long speech events.
 *
 * @property onFrame(probability, frame, ema) - called every frame of audio
 * 
 * @property onSpeechStart(preRollFrames) - called when the VAD model detects the start of speech. preRollFrames is how many
 * buffered frames were prepended to the speech buffer (see the preRollFrames constructor argument)
 *
 * @property onSpeechEnd() - called when the VAD model detects the end of speech
 *
 * @property onMisfire() - Nutq addition. The VAD ended a segment that was too short to count as speech (fewer than
 * minSpeechFrames). Reporting only: the speech buffer and isTalking are left as they were.
 *
 * @property onModelError(path, message) - Nutq addition. A model call failed and the error was caught. path is
 * "update", "commit" (pause or cap), "speech_end" or "stop". A failed commit loses that piece of text.
 *
 * @property onCommitsInFlight(n) - Nutq addition. How many commits (not streaming updates, not skipped ones) are queued or running: called with the new count when a commit is queued and again when it has finished, after its text was delivered through onTranscriptionCommitted. A failed model call counts down too.
 * @property onModelCall(info) - Nutq addition. One call per model call: { path, samples, audio_hash, wait_ms, run_ms, skipped }. audio_hash is audioHash() of the audio the call was given.
 * wait_ms is the time from enqueue to the start of the call, run_ms the time the model took. skipped is true
 * when no model run happened: a commit under the encoder minimum, or an update dropped because the model was busy.
 *
 * @interface
 */
interface TranscriberCallbacks {
    onPermissionsRequested: () => any;

    onError: (error) => any;

    onModelLoadStarted: () => any;

    onModelLoaded: () => any;

    onTranscribeStarted: () => any;

    onTranscribeStopped: () => any;

    onTranscriptionUpdated: (text: string) => any;

    onTranscriptionCommitted: (text: string, buffer?: AudioBuffer) => any;

    onFrame: (probs, frame, ema) => any;

    onSpeechStart: (preRollFrames: number) => any;

    onSpeechEnd: () => any;

    onMisfire: () => any;

    onModelError: (path: string, message: string) => any;

    onModelCall: (info: { path: string; samples: number; audio_hash: string; wait_ms: number; run_ms: number; skipped: boolean }) => any;

    onCommitsInFlight: (n: number) => any;
}

const defaultTranscriberCallbacks: TranscriberCallbacks = {
    onPermissionsRequested: function () {
        Log.log("Transcriber.onPermissionsRequested()");
    },
    onError: function (error) {
        Log.error("Transcriber.onError(" + error + ")");
    },
    onModelLoadStarted: function () {
        Log.log("Transcriber.onModelLoadStarted()");
    },
    onModelLoaded: function () {
        Log.log("Transcriber.onModelLoaded()");
    },
    onTranscribeStarted: function () {
        Log.log("Transcriber.onTranscribeStarted()");
    },
    onTranscribeStopped: function () {
        Log.log("Transcriber.onTranscribeStopped()");
    },
    onTranscriptionUpdated: function (text: string) {
        Log.log("Transcriber.onTranscriptionUpdated(" + text + ")");
    },
    onTranscriptionCommitted: function (text: string, buffer?: AudioBuffer) {
        Log.log("Transcriber.onTranscriptionCommitted(" + text + ")");
    },
    onFrame: function (probs, frame, ema) {
        Log.log("Transcriber.onFrame()");
    },
    onSpeechStart: function (preRollFrames: number) {
        Log.log("Transcriber.onSpeechStart(" + preRollFrames + ")");
    },
    onSpeechEnd: function () {
        Log.log("Transcriber.onSpeechEnd()");
    },
    onMisfire: function () {},
    onModelError: function (path: string, message: string) {
        Log.error("Transcriber.onModelError(" + path + ", " + message + ")");
    },
    onModelCall: function () {},
    onCommitsInFlight: function () {},
};

/**
 * Nutq addition. The shortest audio, in samples, that the STT encoder accepts. Measured on
 * model/base by calling the real MoonshineModel.generate() on a sine tone:
 * 894 samples throws an OrtRun error, 895 runs. It matches the encoder's three convolutions
 * without padding (kernel 127 stride 64, kernel 7 stride 3, kernel 3 stride 2), which need
 * 127 + 64 * (7 + 3 * 2 - 1) = 895 samples to produce one output step. Only model/base was
 * measured; the tiny model's encoder was not checked.
 */
export const MIN_ENCODER_SAMPLES = 895;

/**
 * Nutq addition. FNV-1a (32 bit) over the audio quantized to int16, low byte then high byte, as
 * 8 hex digits. A cheap fingerprint to tell whether two model calls got the same audio. Several
 * thousand samples cost well under a millisecond.
 */
export function audioHash(audio: Float32Array): string {
    let h = 2166136261;
    for (let i = 0; i < audio.length; i++) {
        const v = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32768)));
        h = Math.imul(h ^ (v & 255), 16777619);
        h = Math.imul(h ^ ((v >> 8) & 255), 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

class SpeechBuffer {
    private buffer: Float32Array;
    private frameCount: number;
    private preRollCount: number;
    public frameEMA: number;
    private speechEMA: (value: number) => any;
    private useVAD: boolean;

    constructor(useVAD: boolean) {
        this.useVAD = useVAD;
        this.flush();
    }

    public flush(): void {
        this.buffer = new Float32Array(
            this.maxCommitInterval() * Settings.FRAME_SIZE
        );
        this.speechEMA = this.ema(Settings.STREAM_COMMIT_EMA_PERIOD);
        this.frameEMA = 0.0;
        this.frameCount = 0;
        this.preRollCount = 0;
    }

    public set(frame, p = undefined): void {
        this.buffer.set(frame, this.frameCount * Settings.FRAME_SIZE);
        if (p) this.updateEMA(p);
        this.frameCount += 1;
    }

    // Pre-roll frames sit in the buffer (they count toward the max-interval cap) but were not
    // recorded while talking, so they do not count toward the pause-commit minimum.
    public prepend(frames: Float32Array[]): void {
        for (const frame of frames) this.set(frame);
        this.preRollCount += frames.length;
    }

    public updateEMA(p): void {
        this.frameEMA = this.speechEMA(p.isSpeech);
    }

    public subarray(): Float32Array {
        return this.buffer.subarray(0, this.frameCount * Settings.FRAME_SIZE);
    }

    public copy(): Float32Array {
        return this.buffer.slice(0, this.frameCount * Settings.FRAME_SIZE);
    }

    public hasFrames(): boolean {
        return this.frameCount > 0;
    }

    public shouldSet(): boolean {
        return this.frameCount <= this.maxCommitInterval();
    }

    public shouldUpdate(): boolean {
        return (
            this.frameCount < this.maxCommitInterval() &&
            this.frameCount % Settings.STREAM_UPDATE_INTERVAL === 0
        );
    }

    public shouldCommit(): boolean {
        if (
            this.frameEMA <= 0.5 &&
            this.recordedCount() >= this.minCommitInterval() &&
            this.frameCount < this.maxCommitInterval()
        ) {
            Log.log(`Speech pause, frameCount: ${this.frameCount}`);
        } else if (this.frameCount === this.maxCommitInterval()) {
            Log.log(`Forced commit, frameCount: ${this.frameCount}`);
        }
        return (
            this.frameCount === this.maxCommitInterval() ||
            (this.frameEMA <= Settings.STREAM_COMMIT_EMA_THRESHOLD &&
                this.recordedCount() >= this.minCommitInterval())
        );
    }

    private recordedCount(): number {
        return this.frameCount - this.preRollCount;
    }

    private ema(period: number): (value: number) => number {
        const k = 2 / (period + 1);
        let emaPrev = null;

        return function update(value: number): number {
            if (emaPrev === null) {
                emaPrev = value; // initialize with first value
            } else {
                emaPrev = value * k + emaPrev * (1 - k);
            }
            return emaPrev;
        };
    }

    private minCommitInterval(): number {
        return Settings.STREAM_COMMIT_MIN_INTERVAL;
    }

    private maxCommitInterval(): number {
        return this.useVAD
            ? Settings.VAD_COMMIT_INTERVAL
            : Settings.STREAM_COMMIT_MAX_INTERVAL;
    }
}

/**
 * Implements real-time transcription of an audio stream sourced from a WebAudio-compliant MediaStream object.
 *
 * Read more about working with MediaStreams: {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaStream}
 */
class Transcriber {
    private static models: Map<string, MoonshineModel> = new Map();
    private sttModel: MoonshineModel;
    private vadModel: AudioNodeVAD;
    callbacks: TranscriberCallbacks;

    private useVAD: boolean;
    private mediaStream: MediaStream;
    private speechBuffer: SpeechBuffer;
    private preRoll: PreRoll;
    // Nutq addition: every model call runs through this chain, one at a time (see enqueue()).
    private queue: Promise<void> = Promise.resolve();
    private inFlight: number = 0;
    private commitsInFlight: number = 0;

    protected audioContext: AudioContext;
    public isActive: boolean = false;
    private vadOptions: VADThresholdOptions;

    /**
     * Creates a transcriber for transcribing a MediaStream from any source. After creating the {@link Transcriber}, you must invoke
     * {@link Transcriber.attachStream} to provide a MediaStream that you want to transcribe.
     *
     * @param modelURL The URL that the underlying {@link MoonshineModel} weights should be loaded from,
     * relative to {@link Settings.BASE_ASSET_PATH.MOONSHINE}.
     *
     * @param callbacks A set of {@link TranscriberCallbacks} used to trigger behavior at different steps of the
     * transcription lifecycle. For transcription-only use cases, you should define the {@link TranscriberCallbacks} yourself;
     * when using the transcriber for voice control, you should create a {@link VoiceController} and pass it in.
     *
     * @param useVAD A boolean specifying whether or not to use Voice Activity Detection (VAD) for deciding when to perform transcriptions.
     * When set to `true`, the transcriber will only process speech at the end of each chunk of voice activity; when set to `false`, the transcriber will
     * operate in streaming mode, generating continuous transcriptions on a rapid interval.
     *
     * @example
     * This basic example demonstrates the use of the transcriber with custom callbacks:
     *
     * ``` ts
     * import Transcriber from "@moonshine-ai/moonshine-js";
     *
     * var transcriber = new Transcriber(
     *      "model/tiny",
     *      {
     *          onModelLoadStarted() {
     *              console.log("onModelLoadStarted()");
     *          },
     *          onTranscribeStarted() {
     *              console.log("onTranscribeStarted()");
     *          },
     *          onTranscribeStopped() {
     *              console.log("onTranscribeStopped()");
     *          },
     *          onTranscriptionUpdated(text: string | undefined) {
     *              console.log(
     *                  "onTranscriptionUpdated(" + text + ")"
     *              );
     *          },
     *          onTranscriptionCommitted(text: string | undefined) {
     *              console.log(
     *                  "onTranscriptionCommitted(" + text + ")"
     *              );
     *          },
     *      },
     *      false // use streaming mode
     * );
     *
     * // Get a MediaStream from somewhere (user mic, active tab, an <audio> element, WebRTC source, etc.)
     * ...
     *
     * transcriber.attachStream(stream);
     * transcriber.start();
     * ```
     *
     * @param preRollFrames How many frames (32 ms each) of audio from just before the VAD fires to prepend to the speech
     * buffer on every speech start. 0 (the default) keeps upstream behavior. See {@link PreRoll}.
     */
    public constructor(
        modelURL: string,
        callbacks: Partial<TranscriberCallbacks> = {},
        useVAD: boolean = true,
        precision: string = "quantized",
        vadOptions: VADThresholdOptions = {},
        preRollFrames: number = 0
    ) {
        this.callbacks = { ...defaultTranscriberCallbacks, ...callbacks };
        // we want to avoid re-downloading the same model weights if we can avoid it
        // so we only create a new model of the requested type if it hasn't been already
        if (!Transcriber.models.has(modelURL))
            Transcriber.models.set(modelURL, new MoonshineModel(modelURL, precision));
        this.sttModel = Transcriber.models.get(modelURL);
        this.useVAD = useVAD;
        this.vadOptions = vadOptions;
        this.preRoll = new PreRoll(preRollFrames);
        this.audioContext = new AudioContext();
    }

    /**
     * Nutq addition. The one place the STT model is called, one call at a time: the wasm runtime
     * throws "Session already started" to a second concurrent call, which used to lose that call's
     * text. Calls are chained on this.queue in the order they are made, and a call never fails the
     * chain: its error is caught, logged and reported through onModelError. Resolves when the call
     * has finished.
     */
    private enqueue(path: string, audio: Float32Array, onText: (text: string) => void): Promise<void> {
        this.inFlight++;
        const enqueuedAt = performance.now();
        this.queue = this.queue.then(async () => {
            const hash = audioHash(audio); // before the run, so it fingerprints what the model was given
            const startedAt = performance.now();
            try {
                onText(await this.sttModel.generate(audio));
            } catch (err) {
                Log.error(`Generation misfire (${path}): ${err}`);
                this.callbacks.onModelError(path, String(err?.message ?? err));
            } finally {
                this.inFlight--;
                this.callbacks.onModelCall({
                    path,
                    samples: audio.length,
                    audio_hash: hash,
                    wait_ms: Math.round(startedAt - enqueuedAt),
                    run_ms: Math.round(performance.now() - startedAt),
                    skipped: false,
                });
            }
        });
        return this.queue;
    }

    private skipped(path: string, audio: Float32Array): void {
        this.callbacks.onModelCall({ path, samples: audio.length, audio_hash: audioHash(audio), wait_ms: 0, run_ms: 0, skipped: true });
    }

    /**
     * A commit (pause or cap in onFrameProcessed, onSpeechEnd, stop): queued behind every earlier
     * call and never dropped, so committed text arrives in buffer order. Audio under
     * MIN_ENCODER_SAMPLES (for example a 1 frame tail left after a flush, or an empty buffer) would
     * make generate() throw, so it is skipped and yields no text; anything already committed is
     * untouched.
     */
    private commit(path: string, audio: Float32Array): Promise<void> {
        if (audio.length < MIN_ENCODER_SAMPLES) {
            this.skipped(path, audio);
            return this.queue;
        }
        this.callbacks.onCommitsInFlight(++this.commitsInFlight);
        // enqueue() never rejects, and its promise settles after the text was delivered
        return this.enqueue(path, audio, (text) => {
            if (text) this.callbacks.onTranscriptionCommitted(text, this.getAudioBuffer(audio));
        }).then(() => this.callbacks.onCommitsInFlight(--this.commitsInFlight));
    }

    /**
     * A streaming preview. It only feeds the live caption, so it is skipped, not queued, when the
     * model is busy or a commit is waiting: previews never delay commits.
     */
    private update(audio: Float32Array): void {
        if (this.inFlight > 0) {
            this.skipped("update", audio);
            return;
        }
        this.enqueue("update", audio, (text) => this.callbacks.onTranscriptionUpdated(text));
    }

    /**
     * Preloads the models and initializes the buffer required for transcription.
     */
    public async load(): Promise<void> {
        this.callbacks.onModelLoadStarted();
        try {
            await this.sttModel.loadModel();
        } catch (err) {
            this.callbacks.onError(MoonshineError.PlatformUnsupported);
            throw err;
        }

        // behavior
        // useVAD:  commit every 30s or onSpeechEnd
        // !useVAD: update every updateInterval frames; commit on detected pause (w/ EMA below threshold) occurring between min and max interval OR on max.
        this.speechBuffer = new SpeechBuffer(this.useVAD);
        var isTalking = false;

        const onFrameProcessed = (p, frame) => {
            this.speechBuffer.updateEMA(p);
            this.callbacks.onFrame(p, frame, this.speechBuffer.frameEMA);
            if (isTalking) {
                if (this.speechBuffer.shouldSet()) {
                    this.speechBuffer.set(frame);
                }
                if (this.speechBuffer.hasFrames()) {
                    // update
                    if (
                        !this.useVAD &&
                        this.speechBuffer.shouldUpdate() &&
                        !this.speechBuffer.shouldCommit()
                    ) {
                        this.update(this.speechBuffer.subarray());
                    }
                    // commit
                    else if (this.speechBuffer.shouldCommit()) {
                        // in this case we need to copy the buffer so that it doesn't get cleared before the inference happens
                        var tmpBuffer = this.speechBuffer.copy();
                        this.commit("commit", tmpBuffer);
                    }
                }
                if (this.speechBuffer.shouldCommit()) {
                    // clear buffer (leave some overhang?)
                    this.speechBuffer.flush();
                }
            } else {
                // Not recording. The frame that crosses the VAD threshold lands here too,
                // because this callback runs before onSpeechStart, so the ring includes it.
                this.preRoll.push(frame);
            }
        };

        this.vadModel = await AudioNodeVAD.new(this.audioContext, {
            ...this.vadOptions,
            onFrameProcessed: onFrameProcessed,
            onVADMisfire: () => {
                Log.log("Transcriber.onVADMisfire()");
                this.callbacks.onMisfire();
            },
            onSpeechStart: () => {
                Log.log("Transcriber.onSpeechStart()");
                // Prepend the ring on every speech start, then it is empty. Frames recorded while
                // talking never enter the ring, so nothing already in speechBuffer or already
                // committed is prepended; take() also returns nothing if speechBuffer has frames.
                const preRoll = this.preRoll.take(this.speechBuffer.hasFrames());
                this.speechBuffer.prepend(preRoll);
                this.callbacks.onSpeechStart(preRoll.length);
                isTalking = true;
            },
            // KNOWN ISSUE, deliberately not fixed here: streaming mode
            // (useVAD=false, what Nutq uses) has two independent,
            // unsynchronized commit paths. This onSpeechEnd callback is one;
            // the other is the this.speechBuffer.shouldCommit() branch inside
            // onFrameProcessed below (pause-EMA or maxCommitInterval), which
            // resets/flushes this.speechBuffer on its own schedule, unrelated
            // to vad-web's own internal segment tracking.
            //
            // A fix was attempted here (consuming onSpeechEnd's own padded
            // `floatArray` instead of this.speechBuffer.copy(), to recover the
            // ~32ms/~1 frame clipped from the true start of every utterance,
            // since this.speechBuffer only starts recording once isTalking
            // flips true). It correctly fixed the clipped first word, but a
            // bounded diagnostic (still present below, disabled) measured the
            // real delta between floatArray and this.speechBuffer at 100+
            // frames (multiple seconds), not ~1 frame: whichever path last
            // reset this.speechBuffer determines how stale its frameCount is
            // relative to floatArray's continuous, uninterrupted segment. The
            // two buffers disagree by however long it's been since the other
            // path's last forced commit, not by a fixed small pad. That also
            // produced a new, inconsistent second-word corruption
            // ("quick" -> "click") not present before. Reverted rather than
            // hand-tuning a trim value against a buffer-sync bug.
            //
            // Note: post-revert verification (3 runs) showed "quick" misheard
            // as "click" once, the same word-substitution artifact seen
            // throughout the floatArray experiment. Source was confirmed
            // genuinely reverted at the time (checked via curl), so this is
            // likely coincidental model noise on a small sample, not leftover
            // contamination, but flagging it since it's specific enough to be
            // worth re-checking if it recurs, e.g. once the eval harness's WER
            // metric can measure this properly instead of by eye.
            //
            // Real fix needs one of: (a) drop onSpeechEnd's role in streaming
            // mode entirely and rely solely on the frame-buffer path, or
            // (b) keep vad-web's internal segment buffer and this.speechBuffer
            // in sync so they represent the same window. Not a quick fix,
            // a real design decision. Full investigation, live-tested
            // transcripts, and the diagnostic's actual numbers are in this
            // session's history; don't re-derive from scratch.
            //
            // The clipped onset that attempt was after is now recovered a
            // different way: this.preRoll (pre-roll.ts) keeps the last few
            // frames seen while not talking, including the frame that crossed
            // the VAD threshold (onFrameProcessed runs before onSpeechStart),
            // and onSpeechStart prepends them to this.speechBuffer. That works
            // inside the one buffer this class already commits from, so it does
            // not depend on vad-web's segment tracking. The two unsynchronized
            // commit paths described above are untouched and still open.
            onSpeechEnd: (floatArray) => {
                Log.log("Transcriber.onSpeechEnd()");
                this.callbacks.onSpeechEnd();

                // DIAGNOSTIC: onSpeechEnd padding investigation, not used in
                // production. Flip on to re-measure the floatArray vs.
                // this.speechBuffer delta described above.
                const ONSET_PADDING_DIAGNOSTIC_ENABLED = false;
                if (ONSET_PADDING_DIAGNOSTIC_ENABLED) {
                    const oldLengthSamples = this.speechBuffer.frameCount * Settings.FRAME_SIZE;
                    const deltaSamples = floatArray.length - oldLengthSamples;
                    const deltaMs = (deltaSamples / 16000) * 1000;
                    Log.info(
                        `onSpeechEnd padding diagnostic: floatArray=${floatArray.length} samples, ` +
                            `old buffer would have been=${oldLengthSamples} samples, ` +
                            `delta=${deltaSamples} samples (${deltaMs.toFixed(1)}ms, ` +
                            `${(deltaSamples / Settings.FRAME_SIZE).toFixed(2)} frames)`
                    );
                }

                var tmpBuffer = this.speechBuffer.copy();
                this.commit("speech_end", tmpBuffer);
                this.speechBuffer.flush();
                isTalking = false;
            },
            model: "v5",
            baseAssetPath: Settings.BASE_ASSET_PATH.SILERO_VAD,
            // Not Settings.BASE_ASSET_PATH.ONNX_RUNTIME (1.22.0): that path is for
            // Moonshine's own onnxruntime-web instance (model.ts). vad-web@0.0.24
            // bundles its own separate onnxruntime-web@1.14.0 and needs matching wasm
            // binaries, confirmed against the real published package.json. Using the
            // 1.22.0 path here 404s (wrong-version wasm filenames), only surfaced once
            // vad-web actually resolves to a real installed package instead of the
            // broken node_modules symlink.
            onnxWASMBasePath: assetURL("vendor/onnxruntime-web-1.14.0/"),
        });
        this.attachStream(this.mediaStream);
        this.callbacks.onModelLoaded();
    }

    /**
     * Attaches a MediaStream to this {@link Transcriber} for transcription. A MediaStream must be attached before
     * starting transcription.
     *
     * @param stream A MediaStream to transcribe
     */
    public attachStream(stream: MediaStream) {
        if (stream) {
            if (this.vadModel) {
                var sourceNode = new MediaStreamAudioSourceNode(
                    this.audioContext,
                    {
                        mediaStream: stream,
                    }
                );
                this.vadModel.receive(sourceNode);
                Log.log(
                    "Transcriber.attachStream(): VAD set to receive source node from stream."
                );
            } else {
                // save stream to attach later, after loading
                this.mediaStream = stream;
            }
        }
    }

    /**
     * Detaches the MediaStream used for transcription.
     * TODO
     */
    public detachStream() {
        // TODO
    }

    /**
     * Returns the most recent AudioBuffer that was input to the underlying model for text generation. This is useful in cases where
     * we want to double-check the audio being input to the model while debugging.
     *
     * @returns An AudioBuffer
     */
    public getAudioBuffer(buffer: Float32Array): AudioBuffer {
        const numChannels = 1;
        const audioBuffer = this.audioContext.createBuffer(
            numChannels,
            buffer.length,
            16000
        );
        audioBuffer.getChannelData(0).set(buffer);
        return audioBuffer;
    }

    /**
     * Starts transcription.
     *
     * Transcription will stop when {@link stop} is called.
     *
     * Note that the {@link Transcriber} must have a MediaStream attached via {@link Transcriber.attachStream} before
     * starting transcription.
     */
    public async start() {
        if (!this.isActive) {
            this.isActive = true;
            // The VAD was paused since the last session; whatever the ring holds is stale audio.
            this.preRoll.clear();

            // load model if not loaded
            if (
                (!this.sttModel.isLoaded() && !this.sttModel.isLoading()) ||
                this.vadModel === undefined
            ) {
                await this.load();
            }

            this.callbacks.onTranscribeStarted();
            this.vadModel.start();
            this.audioContext.resume();
            setTimeout(() => {
                if (this.audioContext.state === "suspended") {
                    Log.warn(
                        "AudioContext is suspended, this usually happens on Chrome when you start trying to access an audio source (like a microphone or video) before the user has interacted with the page. Chrome blocks access until there has been a user gesture, so you'll need to rework your code to call start() after an interaction."
                    );
                }
            }, 1000);
        }
    }

    /**
     * Stops transcription.
     */
    public async stop() {
        this.isActive = false;
        this.callbacks.onTranscribeStopped();
        // Whatever's accumulated in this.speechBuffer since the last commit
        // would otherwise be silently discarded: vadModel.pause() takes the
        // FrameProcessor.reset() branch (submitUserSpeechOnPause defaults to
        // false, never overridden here), which clears state without firing
        // onSpeechEnd or handing back any audio. Flush it manually first,
        // same generate()/onTranscriptionCommitted() path the buffer's own
        // normal commit takes, deliberately NOT vad-web's onSpeechEnd/
        // floatArray path (see the KNOWN ISSUE comment above: that path was
        // tried and reverted for a real, documented bug, not available here).
        // Awaited (stop() is now async) so callers that need the final
        // commit to have already landed before acting on it (e.g. sending
        // the accumulated transcript on button release) can await this.
        if (this.speechBuffer && this.speechBuffer.hasFrames()) {
            var tmpBuffer = this.speechBuffer.copy();
            this.speechBuffer.flush();
            this.commit("stop", tmpBuffer);
        }
        // Every queued call, the commit above included, must land before stop() returns, because the
        // caller sends the accumulated text next. A commit made while waiting is waited for too.
        while (this.inFlight > 0) await this.queue;
        if (this.vadModel) {
            this.vadModel.pause();
        }
    }
}

export { Transcriber, TranscriberCallbacks, SpeechBuffer };
