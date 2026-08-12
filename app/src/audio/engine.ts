import {
  PitchAdapter,
  TempoTracker,
  semitonesToRatio,
  type PitchFrame,
} from "./adaptive";

/**
 * Web Audio wiring for a take.
 *
 * Graph:
 *
 *   mic -> pitch-detector worklet -> (messages) -> main thread
 *   backing track buffer -> adaptive-stretch worklet -> gain -> speakers
 *
 * The mic is never routed to the speakers. Monitoring your own voice through
 * a laptop's speakers is a feedback loop with a microphone at one end.
 *
 * Nothing here touches the network. The track is fetched and decoded once
 * before the take starts, and after that a performance is entirely local,
 * which is what the spec means by no round trip during a live take.
 */

export interface EngineFrame extends PitchFrame {
  /** Seconds into the backing track. */
  position: number;
  /** Semitones the track is currently shifted by. */
  shift: number;
  /** Current tempo ratio applied to the track. */
  tempo: number;
  /** Expected melody note right now, if the song has a reference contour. */
  target: number | null;
  /** Rolling share of voiced frames landing within a semitone. */
  accuracy: number;
}

export interface EngineOptions {
  trackUrl: string;
  melodyContour: [number, number | null][];
  bpm: number | null;
  onFrame: (frame: EngineFrame) => void;
  onEnded: () => void;
}

export class PerformanceEngine {
  private context: AudioContext | null = null;
  private stretch: AudioWorkletNode | null = null;
  private detector: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;
  private gain: GainNode | null = null;

  private adapter: PitchAdapter;
  private tempoTracker: TempoTracker;

  private position = 0;
  private lastFrameTime = 0;
  private latest: PitchFrame = { f0: 0, clarity: 0, rms: 0, onset: false };
  private running = false;
  private rafHandle = 0;

  constructor(private readonly options: EngineOptions) {
    this.adapter = new PitchAdapter(options.melodyContour);
    this.tempoTracker = new TempoTracker(options.bpm);
  }

  get hasMelodyReference(): boolean {
    return this.adapter.hasReference;
  }

  get stats() {
    return this.adapter.stats;
  }

  /**
   * Fetch, decode and hand the track to the worklet, and open the mic.
   *
   * Deliberately all up front. Doing any of it lazily would put a fetch or a
   * decode in the middle of a performance.
   */
  async prepare(): Promise<void> {
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;

    await context.audioWorklet.addModule("/worklets/stretch.worklet.js");
    await context.audioWorklet.addModule("/worklets/pitch-detector.worklet.js");

    const response = await fetch(this.options.trackUrl);
    if (!response.ok) {
      throw new Error(`could not fetch backing track (${response.status})`);
    }
    const decoded = await context.decodeAudioData(await response.arrayBuffer());

    const channels: ArrayBuffer[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const copy = new Float32Array(decoded.length);
      decoded.copyFromChannel(copy, c);
      channels.push(copy.buffer);
    }

    // The track goes in through processorOptions rather than a postMessage
    // after construction. Both work in a realtime context, but this way the
    // processor is never briefly alive without its audio, so there is no
    // window in which it could be asked to play and output silence.
    this.stretch = new AudioWorkletNode(context, "adaptive-stretch", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        channels,
        sampleRate: decoded.sampleRate,
      },
    });

    this.stretch.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === "position") {
        this.position = data.seconds;
      } else if (data?.type === "ended") {
        this.stop();
        this.options.onEnded();
      }
    };

    this.gain = context.createGain();
    this.gain.gain.value = 0.9;
    this.stretch.connect(this.gain).connect(context.destination);

    await this.openMicrophone(context);
  }

  private async openMicrophone(context: AudioContext): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // All three off: they are tuned for speech on a call and they fight
        // the pitch detector, gating sustained notes and pumping the level.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const source = context.createMediaStreamSource(this.micStream);
    this.detector = new AudioWorkletNode(context, "pitch-detector", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });

    this.detector.port.onmessage = (event) => {
      const frame = event.data as PitchFrame;
      this.latest = frame;
      if (frame.onset) this.tempoTracker.onset(this.position);
    };

    // The detector has no outputs, so it is not connected onward. Chrome still
    // pulls it because it has a live input.
    source.connect(this.detector);
  }

  async start(): Promise<void> {
    if (!this.context || !this.stretch) throw new Error("prepare() first");
    await this.context.resume();

    this.running = true;
    this.lastFrameTime = performance.now();
    this.stretch.port.postMessage({ type: "transport", playing: true, seek: 0 });
    this.loop();
  }

  /**
   * Control loop.
   *
   * Runs on animation frames, not on every pitch frame. Correction targets
   * change over seconds, so recomputing at display rate is plenty, and it
   * means the UI and the DSP parameters stay in step.
   */
  private loop = (): void => {
    if (!this.running) return;

    const now = performance.now();
    const delta = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    const shift = this.adapter.update(this.latest, this.position, delta);
    const tempo = this.tempoTracker.update(this.position, delta);

    this.stretch?.port.postMessage({
      type: "params",
      pitch: semitonesToRatio(shift),
      tempo,
    });

    this.options.onFrame({
      ...this.latest,
      position: this.position,
      shift,
      tempo,
      target: this.adapter.targetAt(this.position),
      accuracy: this.adapter.stats.accuracy,
    });

    this.rafHandle = requestAnimationFrame(this.loop);
  };

  pause(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    this.stretch?.port.postMessage({ type: "transport", playing: false });
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    this.stretch?.port.postMessage({ type: "transport", playing: false });
  }

  /** Release the mic and the audio device. Leaking either is very visible. */
  async dispose(): Promise<void> {
    this.stop();
    this.detector?.port.postMessage({ type: "stop" });
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.detector?.disconnect();
    this.stretch?.disconnect();
    this.gain?.disconnect();
    await this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
