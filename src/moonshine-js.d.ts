declare module "@moonshine-ai/moonshine-js" {
  export interface TranscriberCallbacks {
    onPermissionsRequested?: () => any;
    onError?: (error: unknown) => any;
    onModelLoadStarted?: () => any;
    onModelLoaded?: () => any;
    onTranscribeStarted?: () => any;
    onTranscribeStopped?: () => any;
    onTranscriptionUpdated?: (text: string) => any;
    onTranscriptionCommitted?: (text: string, buffer?: AudioBuffer) => any;
    onFrame?: (probability: number, frame: Float32Array, ema: number) => any;
    onSpeechStart?: () => any;
    onSpeechEnd?: () => any;
  }

  export class Transcriber {
    constructor(
      modelURL: string,
      callbacks?: Partial<TranscriberCallbacks>,
      useVAD?: boolean,
      precision?: string,
    );
    start(): Promise<void> | void;
    stop(): void;
  }

  export class MicrophoneTranscriber extends Transcriber {
    start(): Promise<void>;
  }
}
