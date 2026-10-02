// Nutq addition, not upstream moonshine-js. No dependencies, so it can be tested in isolation.
//
// A small ring of the most recent audio frames seen while nobody is talking. The Transcriber
// only starts recording once the VAD fires, and the frame that crosses the threshold is
// processed before the start event, so the first frame or two of every utterance never reach
// the speech buffer. On each speech start the ring is handed over to be prepended, and emptied.

export class PreRoll {
    private frames: Float32Array[] = [];
    private size: number;

    /**
     * @param size how many frames to keep. One frame is 512 samples at 16 kHz, i.e. 32 ms.
     */
    constructor(size: number) {
        this.size = size;
    }

    public push(frame: Float32Array): void {
        if (this.size <= 0) return;
        this.frames.push(frame);
        if (this.frames.length > this.size) this.frames.shift();
    }

    /**
     * Frames to prepend to the speech buffer on a speech start, oldest first. The ring is
     * emptied either way. If the speech buffer already holds frames (they were recorded
     * while talking, so prepending would duplicate or reorder audio) nothing is returned.
     */
    public take(speechBufferHasFrames: boolean): Float32Array[] {
        const out = speechBufferHasFrames ? [] : this.frames;
        this.frames = [];
        return out;
    }

    public clear(): void {
        this.frames = [];
    }
}
