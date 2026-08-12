/**
 * How the backing track decides to follow the singer.
 *
 * Kept apart from the Web Audio plumbing in engine.ts because this is the part
 * with actual judgement in it, and it is all pure functions and small classes
 * that can be reasoned about without an AudioContext.
 *
 * The governing idea: react slowly and refuse to react at all when the
 * evidence is weak. A karaoke track that chases every wobble is worse than one
 * that sits still, so every estimate here is smoothed over seconds and gated
 * on confidence.
 */

/** Bounds from the build spec: never warp the track further than this. */
export const MAX_SEMITONES = 2;
export const MAX_TEMPO_DRIFT = 0.15;

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/**
 * Signed semitone distance from `sung` to `target`, ignoring octave.
 *
 * Octave folding matters: a bass singing an octave below the melody is singing
 * it correctly, and shifting the whole track down twelve semitones to "fix"
 * that would be absurd.
 */
export function foldedInterval(sungMidi: number, targetMidi: number): number {
  let difference = (sungMidi - targetMidi) % 12;
  if (difference > 6) difference -= 12;
  if (difference < -6) difference += 12;
  return difference;
}

/** One-pole smoother parameterised in seconds rather than raw coefficients. */
export class Smoothed {
  private value: number;

  constructor(
    initial: number,
    private readonly timeConstant: number,
  ) {
    this.value = initial;
  }

  push(target: number, deltaSeconds: number): number {
    const alpha = 1 - Math.exp(-deltaSeconds / this.timeConstant);
    this.value += (target - this.value) * alpha;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  reset(value: number): void {
    this.value = value;
  }
}

export interface PitchFrame {
  f0: number;
  clarity: number;
  rms: number;
  onset: boolean;
}

/**
 * Decides how far to shift the backing track, in semitones.
 *
 * Needs a reference melody. Without one there is nothing to be flat or sharp
 * relative to, so it holds at zero rather than inventing a target.
 */
export class PitchAdapter {
  private readonly offset = new Smoothed(0, 2.5);
  private hits = 0;
  private voiced = 0;
  private streak = 0;
  private bestStreak = 0;

  constructor(private readonly contour: [number, number | null][]) {}

  get hasReference(): boolean {
    return this.contour.length > 0;
  }

  /** Expected melody note at `seconds`, or null where the melody rests. */
  targetAt(seconds: number): number | null {
    if (this.contour.length === 0) return null;

    // The contour is evenly spaced, so index directly instead of searching.
    const spacing =
      this.contour.length > 1 ? this.contour[1][0] - this.contour[0][0] : 0.1;
    const index = Math.round(seconds / spacing);
    if (index < 0 || index >= this.contour.length) return null;

    const entry = this.contour[index];
    return entry ? entry[1] : null;
  }

  update(frame: PitchFrame, seconds: number, deltaSeconds: number): number {
    const target = this.targetAt(seconds);
    const singing = frame.f0 > 0 && frame.clarity > 0.55 && frame.rms > 0.012;

    if (!singing || target === null) {
      // Ease back toward the original key when nobody is singing, so a pause
      // does not leave the track parked at an offset.
      return this.clamp(this.offset.push(0, deltaSeconds));
    }

    const sung = hzToMidi(frame.f0);
    const interval = foldedInterval(sung, target);

    this.voiced++;
    if (Math.abs(interval) <= 1) {
      this.hits++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else {
      this.streak = 0;
    }

    // A single wild frame should not drag the track. Anything beyond a fourth
    // is more likely a detection error or a harmony than a key preference.
    if (Math.abs(interval) > 5) {
      return this.clamp(this.offset.current);
    }

    return this.clamp(this.offset.push(interval, deltaSeconds));
  }

  private clamp(value: number): number {
    return Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, value));
  }

  get stats() {
    return {
      accuracy: this.voiced > 0 ? this.hits / this.voiced : 0,
      notesHit: this.hits,
      notesTotal: this.voiced,
      longestStreak: this.bestStreak,
    };
  }
}

/**
 * Estimates how fast the singer is going relative to the track.
 *
 * Onset intervals from a single voice are a noisy tempo cue at the best of
 * times. This wants a solid run of onsets that agree with each other before it
 * moves anything, and decays back to 1.0 whenever that evidence dries up.
 * Holding still is the correct behaviour when unsure, not a limitation worked
 * around.
 */
export class TempoTracker {
  private readonly onsets: number[] = [];
  private readonly ratio = new Smoothed(1, 4);

  constructor(private readonly songBpm: number | null) {}

  get usable(): boolean {
    return this.songBpm !== null && this.songBpm > 30;
  }

  onset(seconds: number): void {
    this.onsets.push(seconds);
    while (this.onsets.length > 0 && seconds - this.onsets[0] > 8) {
      this.onsets.shift();
    }
  }

  update(seconds: number, deltaSeconds: number): number {
    if (!this.usable) return 1;

    const target = this.estimate(seconds);
    return this.clamp(this.ratio.push(target ?? 1, deltaSeconds));
  }

  private estimate(seconds: number): number | null {
    if (this.onsets.length < 6) return null;

    const intervals: number[] = [];
    for (let i = 1; i < this.onsets.length; i++) {
      const gap = this.onsets[i] - this.onsets[i - 1];
      if (gap > 0.15 && gap < 2.0) intervals.push(gap);
    }
    if (intervals.length < 5) return null;

    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];

    // Spread check: if the onsets do not agree with each other, this is not a
    // pulse, it is noise.
    const spread =
      intervals[Math.floor(intervals.length * 0.75)] -
      intervals[Math.floor(intervals.length * 0.25)];
    if (spread > median * 0.5) return null;

    const beatPeriod = 60 / (this.songBpm as number);

    // Fold the observed interval into the same octave as the beat period, so
    // singing on the half note still reads as the same tempo.
    let observed = median;
    while (observed < beatPeriod * 0.7) observed *= 2;
    while (observed > beatPeriod * 1.4) observed /= 2;

    const ratio = beatPeriod / observed;
    if (!isFinite(ratio) || ratio <= 0) return null;

    // Anything outside the correction range is a bad estimate, not a fast
    // singer. Ignore rather than clamp, so it does not bias the smoother.
    if (Math.abs(ratio - 1) > MAX_TEMPO_DRIFT * 1.5) return null;

    void seconds;
    return ratio;
  }

  private clamp(value: number): number {
    return Math.max(1 - MAX_TEMPO_DRIFT, Math.min(1 + MAX_TEMPO_DRIFT, value));
  }
}
