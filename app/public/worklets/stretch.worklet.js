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
 * Messages in:
 *   { type: "load", channels: Float32Array[], sampleRate }
 *   { type: "params", tempo, pitch }   ratios, 1 = unchanged
 *   { type: "transport", playing, seek }
 * Messages out:
 *   { type: "position", seconds }      about 20 Hz
 *   { type: "ended" }
 */

const FRAME = 1024;
const SYNTHESIS_HOP = FRAME >> 1; // 50 percent overlap
const SEARCH = 256; // how far WSOLA may slide to find a better splice
const POSITION_INTERVAL = 2400; // samples between position messages

function hann(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return window;
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.channels = null;
    this.channelCount = 0;
    this.sourceRate = sampleRate;
    this.sourceLength = 0;

    this.window = hann(FRAME);

    this.playing = false;
    this.ended = false;

    // Stage one state.
    this.readPosition = 0; // float index into the source
    this.olaBuffers = null; // accumulated WSOLA output per channel
    this.olaLength = 0; // valid samples in olaBuffers
    this.olaRead = 0; // how much of that stage two has consumed
    // The tail of the previous synthesis frame, used as the template the next
    // frame is matched against.
    this.template = null;

    // Stage two state.
    this.resamplePosition = 0;

    this.tempo = 1;
    this.pitch = 1;

    this.samplesSincePosition = 0;

    this.port.onmessage = (event) => this.handle(event.data);
  }

  handle(message) {
    if (!message) return;

    if (message.type === "load") {
      this.channels = message.channels.map((buffer) => new Float32Array(buffer));
      this.channelCount = this.channels.length;
      this.sourceRate = message.sampleRate || sampleRate;
      this.sourceLength = this.channels[0] ? this.channels[0].length : 0;

      const capacity = FRAME * 8;
      this.olaBuffers = this.channels.map(() => new Float32Array(capacity));
      this.template = this.channels.map(() => new Float32Array(SYNTHESIS_HOP));

      this.readPosition = 0;
      this.olaLength = 0;
      this.olaRead = 0;
      this.resamplePosition = 0;
      this.ended = false;
      this.port.postMessage({ type: "loaded", duration: this.sourceLength / this.sourceRate });
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
      if (typeof message.playing === "boolean") this.playing = message.playing;
      if (typeof message.seek === "number") {
        this.readPosition = Math.max(
          0,
          Math.min(this.sourceLength - 1, message.seek * this.sourceRate),
        );
        this.olaLength = 0;
        this.olaRead = 0;
        this.resamplePosition = 0;
        this.ended = false;
        if (this.template) {
          for (const channel of this.template) channel.fill(0);
        }
      }
    }
  }

  /**
   * Best splice offset within the search window.
   *
   * Correlates the candidate region against the template left by the previous
   * frame. Normalised by candidate energy so a loud passage does not always
   * win on raw correlation alone.
   */
  findOffset(nominal) {
    const source = this.channels[0];
    const template = this.template[0];

    let bestOffset = 0;
    let bestScore = -Infinity;

    const low = Math.max(0, nominal - SEARCH);
    const high = Math.min(this.sourceLength - FRAME - 1, nominal + SEARCH);
    if (high <= low) return 0;

    // Step of 4 rather than 1. At 48 kHz that is a 12 sample resolution on the
    // splice point, inaudible here, and it cuts the search cost fourfold.
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

  /** Produce one SYNTHESIS_HOP of time-scaled audio into the OLA buffers. */
  synthesizeFrame() {
    const rate = this.tempo / this.pitch;
    const nominal = Math.round(this.readPosition);

    if (nominal + FRAME >= this.sourceLength) {
      this.ended = true;
      return false;
    }

    // Bypass the correlation search when the correction is negligible, which
    // is most of the time. Keeps idle CPU low.
    const offset = Math.abs(rate - 1) < 0.002 ? 0 : this.findOffset(nominal);
    const start = Math.max(0, Math.min(this.sourceLength - FRAME - 1, nominal + offset));

    // Make room if the buffer is filling up.
    if (this.olaLength + FRAME > this.olaBuffers[0].length) {
      this.compactOla();
    }

    for (let c = 0; c < this.channelCount; c++) {
      const source = this.channels[c];
      const destination = this.olaBuffers[c];
      const base = this.olaLength;

      // Overlap-add: the first half lands on the previous frame's tail, the
      // second half is new territory.
      for (let i = 0; i < FRAME; i++) {
        const windowed = source[start + i] * this.window[i];
        const index = base - SYNTHESIS_HOP + i;
        if (index < 0) continue;
        if (index < base) {
          destination[index] += windowed;
        } else {
          destination[index] = windowed;
        }
      }

      // Template for the next search: what this frame predicts comes next.
      const template = this.template[c];
      for (let i = 0; i < SYNTHESIS_HOP; i++) {
        template[i] = source[start + SYNTHESIS_HOP + i];
      }
    }

    this.olaLength += SYNTHESIS_HOP;
    this.readPosition += SYNTHESIS_HOP * rate;
    return true;
  }

  /** Drop already-consumed audio from the front of the OLA buffers. */
  compactOla() {
    const keep = this.olaLength - this.olaRead;
    for (let c = 0; c < this.channelCount; c++) {
      this.olaBuffers[c].copyWithin(0, this.olaRead, this.olaLength);
      this.olaBuffers[c].fill(0, keep);
    }
    this.olaLength = keep;
    this.resamplePosition -= this.olaRead;
    this.olaRead = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const blockSize = output[0].length;

    if (!this.channels || !this.playing || this.ended) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    for (let i = 0; i < blockSize; i++) {
      // Stage two needs one sample either side of resamplePosition. Keep
      // stage one ahead of it, with a frame of slack.
      while (this.resamplePosition + 2 >= this.olaLength - SYNTHESIS_HOP) {
        if (!this.synthesizeFrame()) break;
      }

      if (this.ended) {
        for (let c = 0; c < output.length; c++) output[c].fill(0, i);
        this.port.postMessage({ type: "ended" });
        this.playing = false;
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
      this.olaRead = index;
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
