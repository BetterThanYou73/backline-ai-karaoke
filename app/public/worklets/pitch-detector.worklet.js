/**
 * Backline pitch detector.
 *
 * YIN fundamental frequency estimation on the mic input, running on the audio
 * render thread so a busy main thread cannot stall it.
 *
 * The input is decimated to about 16 kHz before analysis. Voice fundamentals
 * live below 1 kHz, so the top of the 48 kHz band carries nothing YIN needs,
 * and decimating cuts the difference function's cost by roughly an order of
 * magnitude. That is what keeps this inside its render quantum budget.
 *
 * Posts { f0, clarity, rms, onset } to the main thread at about 30 Hz.
 */

const TARGET_RATE = 16000;
const FRAME = 1024; // 64 ms at 16 kHz
const HOP = 512; // about 31 ms between estimates
const MIN_HZ = 70;
const MAX_HZ = 1000;
// YIN's absolute threshold. Lower is stricter about what counts as pitched.
const THRESHOLD = 0.15;

class PitchDetector extends AudioWorkletProcessor {
  constructor() {
    super();

    this.decimation = Math.max(1, Math.round(sampleRate / TARGET_RATE));
    this.rate = sampleRate / this.decimation;

    this.frame = new Float32Array(FRAME);
    this.filled = 0;

    // Decimation accumulator: a box average over `decimation` samples, which
    // is a crude but adequate anti-alias filter for this purpose.
    this.accumulator = 0;
    this.accumulated = 0;

    this.yinBuffer = new Float32Array(Math.floor(this.rate / MIN_HZ) + 2);

    this.minTau = Math.max(2, Math.floor(this.rate / MAX_HZ));
    this.maxTau = Math.min(this.yinBuffer.length - 1, Math.ceil(this.rate / MIN_HZ));

    // Spectral-flux-free onset detection: a jump in short term energy. Coarse,
    // but it only feeds tempo estimation, which is smoothed hard anyway.
    this.previousEnergy = 0;

    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;

    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.accumulator += channel[i];
      this.accumulated++;

      if (this.accumulated < this.decimation) continue;

      const sample = this.accumulator / this.accumulated;
      this.accumulator = 0;
      this.accumulated = 0;

      if (this.filled < FRAME) {
        this.frame[this.filled++] = sample;
      } else {
        // Slide by one and append. Cheaper than it looks at this rate, and it
        // keeps the frame contiguous for the difference function.
        this.frame.copyWithin(0, 1);
        this.frame[FRAME - 1] = sample;
      }

      if (this.filled >= FRAME) {
        this.sinceHop = (this.sinceHop || 0) + 1;
        if (this.sinceHop >= HOP) {
          this.sinceHop = 0;
          this.emit();
        }
      }
    }

    return true;
  }

  emit() {
    let sumSquares = 0;
    for (let i = 0; i < FRAME; i++) sumSquares += this.frame[i] * this.frame[i];
    const rms = Math.sqrt(sumSquares / FRAME);

    const onset = rms > this.previousEnergy * 1.6 && rms > 0.02;
    this.previousEnergy = this.previousEnergy * 0.7 + rms * 0.3;

    // Below the noise floor there is no point running YIN at all.
    if (rms < 0.006) {
      this.port.postMessage({ f0: 0, clarity: 0, rms, onset: false });
      return;
    }

    const { f0, clarity } = this.yin();
    this.port.postMessage({ f0, clarity, rms, onset });
  }

  /** Difference function, cumulative mean normalisation, absolute threshold. */
  yin() {
    const buffer = this.yinBuffer;
    const frame = this.frame;
    const half = FRAME >> 1;

    // Step 1: squared difference over lag.
    for (let tau = this.minTau; tau <= this.maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const delta = frame[i] - frame[i + tau];
        sum += delta * delta;
      }
      buffer[tau] = sum;
    }

    // Step 2: cumulative mean normalised difference. Without this, tau = 0
    // always wins and every note reads as maximally periodic.
    let runningSum = 0;
    buffer[0] = 1;
    for (let tau = this.minTau; tau <= this.maxTau; tau++) {
      runningSum += buffer[tau];
      buffer[tau] = runningSum > 0 ? (buffer[tau] * (tau - this.minTau + 1)) / runningSum : 1;
    }

    // Step 3: first local minimum under the threshold, which is what makes YIN
    // pick the fundamental instead of an octave above it.
    let chosen = -1;
    for (let tau = this.minTau; tau <= this.maxTau - 1; tau++) {
      if (buffer[tau] < THRESHOLD) {
        while (tau + 1 <= this.maxTau && buffer[tau + 1] < buffer[tau]) tau++;
        chosen = tau;
        break;
      }
    }

    if (chosen === -1) {
      // Nothing crossed the threshold. Fall back to the global minimum, but
      // report the low clarity so callers can ignore it.
      let best = this.minTau;
      for (let tau = this.minTau; tau <= this.maxTau; tau++) {
        if (buffer[tau] < buffer[best]) best = tau;
      }
      chosen = best;
      if (buffer[chosen] > 0.6) return { f0: 0, clarity: 0 };
    }

    // Step 4: parabolic interpolation around the minimum, worth roughly an
    // order of magnitude in frequency resolution at these frame sizes.
    let tauEstimate = chosen;
    if (chosen > this.minTau && chosen < this.maxTau) {
      const before = buffer[chosen - 1];
      const at = buffer[chosen];
      const after = buffer[chosen + 1];
      const denominator = 2 * (2 * at - before - after);
      if (Math.abs(denominator) > 1e-9) {
        tauEstimate = chosen + (after - before) / denominator;
      }
    }

    const f0 = this.rate / tauEstimate;
    const clarity = Math.max(0, Math.min(1, 1 - buffer[chosen]));

    if (f0 < MIN_HZ || f0 > MAX_HZ) return { f0: 0, clarity: 0 };
    return { f0, clarity };
  }
}

registerProcessor("pitch-detector", PitchDetector);
