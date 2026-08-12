/**
 * Backline adaptive playback engine.
 *
 * Plays the cached backing track through a real time time-stretch and
 * pitch-shift so it stays locked to whoever is singing.
 *
 * Two stages:
 *
 *   1. WSOLA (waveform similarity overlap-add) time-scales the source without
 *      touching pitch. Each output frame is taken from a window near the
 *      nominal read position, shifted by whichever offset best cross-correlates
 *      with what the previous frame predicted would come next. That search is
 *      the whole trick: plain overlap-add at these ratios produces the
 *      characteristic phasey warble, and matching waveform similarity first
 *      keeps successive frames in phase.
 *
 *   2. A linear-interpolating resampler reads the WSOLA output at a fractional
 *      rate, which shifts pitch and tempo together.
 *
 * To land on tempo T and pitch P, stage two runs at rate P (pitch and tempo
 * both scale by P) and stage one corrects tempo back with rate T / P.
 *
 * A phase vocoder would be the textbook answer here. WSOLA was chosen because
 * corrections are bounded to about a semitone or two: in that range WSOLA is
 * cheaper, has no transient smearing, and does not need an FFT on the render
 * thread.
 *
 * Hann windows at 50 percent overlap sum to unity, so overlap-add preserves
 * amplitude without a normalisation pass.
 *
 * Configuration arrives either through processorOptions at construction or
 * through messages afterwards. Prefer processorOptions when the audio is known
 * up front: in an OfflineAudioContext the whole render can finish before a
 * postMessage is ever delivered to the processor, and the node would output
 * silence.
 *
 * Messages in:
 *   { type: "load", channels: ArrayBuffer[], sampleRate }
 *   { type: "params", tempo, pitch }   ratios, 1 = unchanged
 *   { type: "transport", playing, seek }
 * Messages out:
 *   { type: "loaded", duration }
 *   { type: "position", seconds }      about 20 Hz
 *   { type: "ended" }
 */

const FRAME = 1024;
const SYNTHESIS_HOP = FRAME >> 1; // 50 percent overlap
const SEARCH = 256; // how far WSOLA may slide to find a better splice
const CAPACITY = FRAME * 8;
const POSITION_INTERVAL = 2400; // samples between position messages

function hann(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return window;
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.window = hann(FRAME);

    this.channels = null;
    this.channelCount = 0;
    this.sourceRate = sampleRate;
    this.sourceLength = 0;

    this.playing = false;
    this.ended = false;

    this.tempo = 1;
    this.pitch = 1;

    this.readPosition = 0; // float index into the source
    this.olaBuffers = null;
    this.writePosition = 0; // where the next frame is overlap-added
    this.clearedTo = 0; // how far the OLA buffers have been zeroed
    this.template = null; // tail of the last frame, matched against next
    this.hasTemplate = false;
    this.resamplePosition = 0;

    this.samplesSincePosition = 0;

    const initial = options && options.processorOptions;
    if (initial) {
      if (initial.channels) this.load(initial);
      if (typeof initial.tempo === "number") this.tempo = initial.tempo;
      if (typeof initial.pitch === "number") this.pitch = initial.pitch;
      if (initial.playing) this.playing = true;
    }

    this.port.onmessage = (event) => this.handle(event.data);
  }

  load(message) {
    this.channels = message.channels.map((buffer) => new Float32Array(buffer));
    this.channelCount = this.channels.length;
    this.sourceRate = message.sampleRate || sampleRate;
    this.sourceLength = this.channels[0] ? this.channels[0].length : 0;

    this.olaBuffers = this.channels.map(() => new Float32Array(CAPACITY));
    this.template = this.channels.map(() => new Float32Array(SYNTHESIS_HOP));

    this.seek(0);
    this.port.postMessage({
      type: "loaded",
      duration: this.sourceLength / this.sourceRate,
    });
  }

  seek(seconds) {
    this.readPosition = Math.max(
      0,
      Math.min(Math.max(0, this.sourceLength - 1), seconds * this.sourceRate),
    );
    this.writePosition = 0;
    this.clearedTo = 0;
    this.resamplePosition = 0;
    this.hasTemplate = false;
    this.ended = false;
    if (this.olaBuffers) {
      for (const buffer of this.olaBuffers) buffer.fill(0);
    }
    if (this.template) {
      for (const channel of this.template) channel.fill(0);
    }
  }

  handle(message) {
    if (!message) return;

    if (message.type === "load") {
      this.load(message);
      return;
    }

    if (message.type === "params") {
      if (typeof message.tempo === "number" && isFinite(message.tempo)) {
        this.tempo = Math.max(0.5, Math.min(2, message.tempo));
      }
      if (typeof message.pitch === "number" && isFinite(message.pitch)) {
        this.pitch = Math.max(0.5, Math.min(2, message.pitch));
      }
      return;
    }

    if (message.type === "transport") {
      if (typeof message.seek === "number") this.seek(message.seek);
      if (typeof message.playing === "boolean") this.playing = message.playing;
    }
  }

  /**
   * Best splice offset within the search window.
   *
   * Correlates the candidate region against the template left by the previous
   * frame, normalised by candidate energy so a loud passage does not win on
   * raw correlation alone.
   */
  findOffset(nominal) {
    const source = this.channels[0];
    const template = this.template[0];

    const low = Math.max(0, nominal - SEARCH);
    const high = Math.min(this.sourceLength - FRAME - 1, nominal + SEARCH);
    if (high <= low) return 0;

    let bestOffset = 0;
    let bestScore = -Infinity;

    // Step of 4 rather than 1: a 4 sample splice resolution, inaudible at
    // these correction ratios, and it cuts the search cost fourfold.
    for (let candidate = low; candidate <= high; candidate += 4) {
      let correlation = 0;
      let energy = 1e-9;
      for (let i = 0; i < SYNTHESIS_HOP; i += 2) {
        const value = source[candidate + i];
        correlation += value * template[i];
        energy += value * value;
      }
      const score = correlation / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = candidate - nominal;
      }
    }

    return bestOffset;
  }

  /**
   * Overlap-add one frame.
   *
   * Everything before writePosition is final: the next frame only touches
   * [writePosition, writePosition + FRAME).
   */
  synthesizeFrame() {
    const rate = this.tempo / this.pitch;
    const nominal = Math.round(this.readPosition);

    if (nominal + FRAME >= this.sourceLength) {
      this.ended = true;
      return false;
    }

    if (this.writePosition + FRAME > CAPACITY) {
      this.compact();
    }

    // Skip the correlation search when the correction is negligible, which is
    // most of the time, and on the first frame when there is no template yet.
    const offset =
      !this.hasTemplate || Math.abs(rate - 1) < 0.002 ? 0 : this.findOffset(nominal);
    const start = Math.max(0, Math.min(this.sourceLength - FRAME - 1, nominal + offset));

    const frameEnd = this.writePosition + FRAME;

    for (let c = 0; c < this.channelCount; c++) {
      const source = this.channels[c];
      const destination = this.olaBuffers[c];

      // Zero only the stretch this frame reaches into for the first time.
      // Everything from writePosition to clearedTo already holds a partial sum
      // from the previous frame and must be added to, not overwritten.
      if (frameEnd > this.clearedTo) {
        destination.fill(0, this.clearedTo, frameEnd);
      }

      for (let i = 0; i < FRAME; i++) {
        destination[this.writePosition + i] += source[start + i] * this.window[i];
      }

      const template = this.template[c];
      for (let i = 0; i < SYNTHESIS_HOP; i++) {
        template[i] = source[start + SYNTHESIS_HOP + i];
      }
    }

    if (frameEnd > this.clearedTo) this.clearedTo = frameEnd;
    this.hasTemplate = true;

    this.writePosition += SYNTHESIS_HOP;
    this.readPosition += SYNTHESIS_HOP * rate;
    return true;
  }

  /** Slide consumed audio off the front of the OLA buffers. */
  compact() {
    const drop = Math.max(0, Math.floor(this.resamplePosition) - 1);
    if (drop <= 0) return;

    for (let c = 0; c < this.channelCount; c++) {
      const buffer = this.olaBuffers[c];
      buffer.copyWithin(0, drop, this.clearedTo);
      buffer.fill(0, Math.max(0, this.clearedTo - drop));
    }

    this.writePosition -= drop;
    this.clearedTo = Math.max(0, this.clearedTo - drop);
    this.resamplePosition -= drop;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const blockSize = output[0].length;

    if (!this.channels || !this.playing || this.ended) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    for (let i = 0; i < blockSize; i++) {
      // Keep finalised output ahead of the read head. Only samples strictly
      // before writePosition are done being summed.
      while (this.resamplePosition + 2 >= this.writePosition) {
        if (!this.synthesizeFrame()) break;
      }

      if (this.ended) {
        for (let c = 0; c < output.length; c++) output[c].fill(0, i);
        this.playing = false;
        this.port.postMessage({ type: "ended" });
        return true;
      }

      const index = Math.floor(this.resamplePosition);
      const fraction = this.resamplePosition - index;

      for (let c = 0; c < output.length; c++) {
        const buffer = this.olaBuffers[Math.min(c, this.channelCount - 1)];
        const a = buffer[index] || 0;
        const b = buffer[index + 1] || 0;
        output[c][i] = a + (b - a) * fraction;
      }

      this.resamplePosition += this.pitch;
    }

    this.samplesSincePosition += blockSize;
    if (this.samplesSincePosition >= POSITION_INTERVAL) {
      this.samplesSincePosition = 0;
      this.port.postMessage({
        type: "position",
        seconds: this.readPosition / this.sourceRate,
      });
    }

    return true;
  }
}

registerProcessor("adaptive-stretch", StretchProcessor);
