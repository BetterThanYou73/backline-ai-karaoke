"use client";

import { useEffect, useState } from "react";

/**
 * DSP test bench.
 *
 * The audio path is the part of this project most likely to be quietly wrong,
 * and it is the hardest to eyeball: a pitch shift that is a few percent off
 * still sounds like music. So both worklets get driven with synthetic signals
 * whose correct answer is known in advance, inside an OfflineAudioContext.
 *
 * Offline rather than live on purpose. It renders faster than real time, needs
 * no microphone permission and no audio output device, and it is deterministic,
 * so a failure here is a real failure rather than a flaky machine.
 *
 * Open /dev/dsp to run it.
 */

interface Result {
  name: string;
  detail: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const RATE = 48000;

/**
 * Fundamental frequency of the rendered output.
 *
 * Uses YIN's cumulative mean normalised difference rather than plain
 * autocorrelation. Raw autocorrelation is prone to octave and subharmonic
 * errors on signals with harmonics, and it does exactly that on resampled
 * output: an earlier version of this bench reported a correct 392 Hz result as
 * 196 Hz and failed a working pitch shift. Taking the first minimum below a
 * threshold, rather than the global maximum, is the part that fixes it.
 */
function dominantHz(samples: Float32Array, rate: number): number {
  // Skip the first 250 ms: WSOLA needs a few frames before output settles.
  const start = Math.floor(rate * 0.25);
  const half = 4096;
  const maxLag = Math.floor(rate / 80);
  const minLag = Math.floor(rate / 1200);

  if (samples.length < start + half + maxLag) return 0;
  const window = samples.subarray(start, start + half + maxLag);

  const difference = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const delta = window[i] - window[i + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  let runningSum = 0;
  const normalised = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    runningSum += difference[tau];
    normalised[tau] =
      runningSum > 0 ? (difference[tau] * (tau - minLag + 1)) / runningSum : 1;
  }

  let chosen = -1;
  for (let tau = minLag; tau < maxLag; tau++) {
    if (normalised[tau] < 0.1) {
      while (tau + 1 <= maxLag && normalised[tau + 1] < normalised[tau]) tau++;
      chosen = tau;
      break;
    }
  }
  if (chosen === -1) {
    chosen = minLag;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (normalised[tau] < normalised[chosen]) chosen = tau;
    }
  }

  let refined = chosen;
  if (chosen > minLag && chosen < maxLag) {
    const before = normalised[chosen - 1];
    const at = normalised[chosen];
    const after = normalised[chosen + 1];
    const denominator = 2 * (2 * at - before - after);
    if (Math.abs(denominator) > 1e-12) {
      refined = chosen + (after - before) / denominator;
    }
  }

  return refined > 0 ? rate / refined : 0;
}

function toneBuffer(
  context: BaseAudioContext,
  hz: number,
  seconds: number,
): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(RATE * seconds), RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // A couple of harmonics, so the detectors have something more realistic
    // than a pure sine to lock onto.
    const t = i / RATE;
    data[i] =
      0.6 * Math.sin(2 * Math.PI * hz * t) +
      0.25 * Math.sin(4 * Math.PI * hz * t) +
      0.1 * Math.sin(6 * Math.PI * hz * t);
  }
  return buffer;
}

async function testPitchDetector(hz: number): Promise<Result> {
  const context = new OfflineAudioContext(1, RATE * 1.5, RATE);
  await context.audioWorklet.addModule("/worklets/pitch-detector.worklet.js");

  const source = context.createBufferSource();
  source.buffer = toneBuffer(context, hz, 1.5);

  const node = new AudioWorkletNode(context, "pitch-detector", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
  });

  const readings: number[] = [];
  node.port.onmessage = (event) => {
    const { f0, clarity } = event.data as { f0: number; clarity: number };
    if (f0 > 0 && clarity > 0.5) readings.push(f0);
  };

  source.connect(node);
  node.connect(context.destination);
  source.start();
  await context.startRendering();

  // Let the queued port messages drain before reading them.
  await new Promise((resolve) => setTimeout(resolve, 60));

  readings.sort((a, b) => a - b);
  const median = readings.length ? readings[Math.floor(readings.length / 2)] : 0;
  const errorCents = median > 0 ? 1200 * Math.log2(median / hz) : Infinity;

  return {
    name: `YIN detects ${hz} Hz`,
    detail: `${readings.length} voiced frames`,
    expected: `${hz} Hz, within 20 cents`,
    actual:
      median > 0
        ? `${median.toFixed(1)} Hz (${errorCents >= 0 ? "+" : ""}${errorCents.toFixed(1)} cents)`
        : "no pitch detected",
    pass: Math.abs(errorCents) < 20 && readings.length > 5,
  };
}

/**
 * How much source audio a render consumed, measured from the worklet's own
 * read position.
 *
 * This is the only thing that actually tests the tempo axis. Measuring pitch
 * alone cannot: the test tone is stationary, and a stationary tone stretched by
 * any factor is the same tone, so a processor that ignored `tempo` outright
 * passed both tempo rows. Consuming N seconds of source in M seconds of output
 * is what "tempo" means here.
 */
async function measureConsumption(
  tempo: number,
  pitch: number,
  seconds: number,
): Promise<number> {
  const context = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE);
  await context.audioWorklet.addModule("/worklets/stretch.worklet.js");

  const source = toneBuffer(context, 440, 12);
  const channel = new Float32Array(source.getChannelData(0));

  const node = new AudioWorkletNode(context, "adaptive-stretch", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      channels: [channel.buffer],
      sampleRate: RATE,
      tempo,
      pitch,
      playing: true,
    },
  });

  let lastPosition = 0;
  node.port.onmessage = (event) => {
    if (event.data?.type === "position") lastPosition = event.data.seconds;
  };

  node.connect(context.destination);
  await context.startRendering();
  await new Promise((resolve) => setTimeout(resolve, 60));

  return lastPosition;
}

async function testTempo(
  label: string,
  tempo: number,
  seconds = 1.5,
): Promise<Result> {
  const consumed = await measureConsumption(tempo, 1, seconds);
  // Position messages arrive every 2400 samples, so the last one lands a
  // little before the end of the render.
  const observed = consumed / seconds;
  const error = Math.abs(observed - tempo) / tempo;

  return {
    name: label,
    detail: `${consumed.toFixed(3)}s of source consumed in ${seconds}s of output`,
    expected: `${tempo.toFixed(2)}x source consumed, within 6 percent`,
    actual: `${observed.toFixed(3)}x`,
    pass: error < 0.06,
  };
}

async function testStretch(
  label: string,
  tempo: number,
  pitch: number,
  sourceHz: number,
  expectedHz: number,
): Promise<Result> {
  const seconds = 1.2;
  const context = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE);
  await context.audioWorklet.addModule("/worklets/stretch.worklet.js");

  const source = toneBuffer(context, sourceHz, 4);
  const channel = new Float32Array(source.getChannelData(0));

  // Everything goes through processorOptions rather than postMessage. In an
  // OfflineAudioContext the render can complete before a port message is ever
  // delivered, which would make every test read as silence.
  const node = new AudioWorkletNode(context, "adaptive-stretch", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      channels: [channel.buffer],
      sampleRate: RATE,
      tempo,
      pitch,
      playing: true,
    },
  });

  node.connect(context.destination);

  const rendered = await context.startRendering();
  const measured = dominantHz(rendered.getChannelData(0), RATE);
  const errorCents = 1200 * Math.log2(measured / expectedHz);

  return {
    name: label,
    detail: `tempo ${tempo.toFixed(3)}, pitch ${pitch.toFixed(4)}`,
    expected: `${expectedHz.toFixed(1)} Hz, within 35 cents`,
    actual: `${measured.toFixed(1)} Hz (${errorCents >= 0 ? "+" : ""}${errorCents.toFixed(1)} cents)`,
    pass: Math.abs(errorCents) < 35,
  };
}

export default function DspTestPage() {
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const semitone = Math.pow(2, 1 / 12);
        const collected: Result[] = [];

        collected.push(await testPitchDetector(220));
        collected.push(await testPitchDetector(440));

        // Pitch only: the track moves up two semitones, tempo untouched.
        collected.push(
          await testStretch(
            "Shift up 2 semitones",
            1,
            Math.pow(semitone, 2),
            440,
            440 * Math.pow(semitone, 2),
          ),
        );

        // Pitch only, downward.
        collected.push(
          await testStretch(
            "Shift down 2 semitones",
            1,
            Math.pow(semitone, -2),
            440,
            440 * Math.pow(semitone, -2),
          ),
        );

        // Tempo, checked on both axes at once. The pitch row proves a naive
        // resampler is not dragging pitch along with the tempo; the
        // consumption row proves the tempo actually changed, which the pitch
        // measurement alone cannot see.
        collected.push(
          await testStretch("Speed up 15 percent, pitch held", 1.15, 1, 440, 440),
        );
        collected.push(await testTempo("Speed up 15 percent, source consumed", 1.15));

        collected.push(
          await testStretch("Slow down 15 percent, pitch held", 0.85, 1, 440, 440),
        );
        collected.push(await testTempo("Slow down 15 percent, source consumed", 0.85));

        collected.push(await testTempo("Unity consumes source in real time", 1.0));

        // Bypass path: both ratios at unity should be a clean passthrough.
        collected.push(await testStretch("Unity passthrough", 1, 1, 440, 440));

        if (!cancelled) setResults(collected);
      } catch (runError) {
        if (!cancelled) {
          setError(runError instanceof Error ? runError.message : String(runError));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <h1 className="wordmark">
        DSP <span>test bench</span>
      </h1>
      <p className="tagline">
        Both worklets driven with synthetic signals inside an OfflineAudioContext.
      </p>

      {error ? (
        <div className="panel" style={{ borderColor: "var(--bad)", marginTop: 20 }}>
          Test run failed: {error}
        </div>
      ) : null}

      {!results && !error ? (
        <div className="panel muted" style={{ marginTop: 20 }}>
          <span className="spinner" /> Rendering test signals...
        </div>
      ) : null}

      {results ? (
        <>
          <div className="panel" style={{ marginTop: 20 }}>
            <strong data-summary="true">
              {results.filter((r) => r.pass).length} of {results.length} passed
            </strong>
          </div>

          <ul className="song-grid" style={{ marginTop: 14 }}>
            {results.map((result) => (
              <li key={result.name}>
                <div className="song-card">
                  <div className="song-card-top">
                    <span className="song-title">{result.name}</span>
                    <span className="muted song-artist">{result.detail}</span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                    <div className="muted">expected: {result.expected}</div>
                    <div>measured: {result.actual}</div>
                  </div>
                  <div className="song-meta">
                    <span className={result.pass ? "pill good" : "pill bad"}>
                      {result.pass ? "PASS" : "FAIL"}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}
