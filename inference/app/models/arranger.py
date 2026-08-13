"""Placeholder instrumental renderer for STUB_MODE.

The first version of this played the detected melody as a decaying sine over a
metronome click. It followed the tune, which was all it was asked to do, and it
sounded like a toy keyboard demo. That is a real problem rather than a cosmetic
one: stub mode is what the app runs in before the model is installed, so it is
the first thing anyone hears, and it sets their expectation of the product.

So this builds an actual arrangement instead:

* Key and chords are inferred from the melody rather than assumed, and the
  progression is voiced in a register that sits under the tune rather than on
  top of it.
* Each style gets its own instrument definitions, drum pattern and swing, so
  jazz and rock differ in rhythm and articulation rather than only in timbre.
* Notes have real envelopes, a resonant low-pass sweep, and light saturation.
* The mix has a tempo-synced delay and a cheap reverb tail, which is most of
  what separates "a synth in a room" from "a beep".

It is still a placeholder and still says so in the UI. It should just sound
like a placeholder made by someone who cared.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Semitone offsets from the tonic for the diatonic triads of a major and a
# minor key, indexed by scale degree.
_MAJOR_TRIADS = [(0, 4, 7), (2, 5, 9), (4, 7, 11), (5, 9, 12), (7, 11, 14), (9, 12, 16)]
_MINOR_TRIADS = [(0, 3, 7), (2, 5, 8), (3, 7, 10), (5, 8, 12), (7, 10, 14), (8, 12, 15)]

# Progressions written as scale degrees, one bar each.
_PROGRESSIONS = {
    "neon": [0, 5, 3, 4],
    "velvet": [1, 4, 0, 3],
    "riff": [0, 3, 4, 3],
    "tide": [0, 4, 5, 4],
    "grove": [0, 5, 3, 4],
    "bloom": [0, 4, 5, 3],
}


@dataclass
class Voice:
    """One instrument: a harmonic recipe plus how it is played."""

    harmonics: list[tuple[float, float]]  # (partial number, amplitude)
    attack: float
    decay: float
    sustain: float
    release: float
    detune_cents: float = 0.0
    # Filter sweep, as a multiple of the note's own frequency.
    cutoff_start: float = 8.0
    cutoff_end: float = 3.0
    resonance: float = 0.0
    drive: float = 1.0
    level: float = 1.0


@dataclass
class StyleKit:
    lead: Voice
    pad: Voice
    bass: Voice
    kick: float
    snare: float
    hat: float
    # Fraction of a beat that offbeats are pushed late. 0 is straight.
    swing: float = 0.0
    delay_beats: float = 0.75
    delay_mix: float = 0.22
    reverb: float = 0.18
    # Which sixteenths the bass plays, as a repeating one-bar pattern.
    bass_pattern: tuple[int, ...] = (0, 8)
    hat_division: int = 2  # in sixteenths
    tempo_bias: float = 1.0
    field_: dict = field(default_factory=dict)


KITS: dict[str, StyleKit] = {
    "neon": StyleKit(
        lead=Voice(
            harmonics=[(1, 1.0), (2, 0.5), (3, 0.34), (4, 0.2), (5, 0.12)],
            attack=0.006,
            decay=0.35,
            sustain=0.45,
            release=0.25,
            detune_cents=9,
            cutoff_start=11,
            cutoff_end=3.2,
            resonance=0.35,
            drive=1.5,
        ),
        pad=Voice(
            harmonics=[(1, 1.0), (2, 0.42), (3, 0.2), (4, 0.1)],
            attack=0.45,
            decay=1.2,
            sustain=0.7,
            release=1.1,
            detune_cents=14,
            cutoff_start=5,
            cutoff_end=2.2,
            level=0.5,
        ),
        bass=Voice(
            harmonics=[(1, 1.0), (2, 0.55), (3, 0.22)],
            attack=0.004,
            decay=0.22,
            sustain=0.55,
            release=0.12,
            cutoff_start=6,
            cutoff_end=2.4,
            resonance=0.3,
            drive=1.8,
            level=0.95,
        ),
        kick=0.95,
        snare=0.55,
        hat=0.3,
        delay_beats=0.75,
        delay_mix=0.3,
        reverb=0.22,
        bass_pattern=(0, 6, 8, 14),
    ),
    "velvet": StyleKit(
        lead=Voice(
            harmonics=[(1, 1.0), (2, 0.3), (3, 0.16), (5, 0.06)],
            attack=0.03,
            decay=0.9,
            sustain=0.32,
            release=0.5,
            cutoff_start=6,
            cutoff_end=2.6,
            drive=1.1,
        ),
        pad=Voice(
            harmonics=[(1, 1.0), (2, 0.24), (3, 0.14), (5, 0.05)],
            attack=0.12,
            decay=1.4,
            sustain=0.4,
            release=0.9,
            cutoff_start=4,
            cutoff_end=2.0,
            level=0.42,
        ),
        bass=Voice(
            harmonics=[(1, 1.0), (2, 0.34), (3, 0.1)],
            attack=0.012,
            decay=0.5,
            sustain=0.3,
            release=0.25,
            cutoff_start=4,
            cutoff_end=1.8,
            level=0.9,
        ),
        kick=0.45,
        snare=0.3,
        hat=0.26,
        swing=0.32,
        delay_beats=0.5,
        delay_mix=0.1,
        reverb=0.3,
        # Walking bass: a note on every beat.
        bass_pattern=(0, 4, 8, 12),
        hat_division=3,
    ),
    "riff": StyleKit(
        lead=Voice(
            harmonics=[(1, 1.0), (2, 0.7), (3, 0.6), (4, 0.42), (5, 0.3), (6, 0.2)],
            attack=0.004,
            decay=0.3,
            sustain=0.6,
            release=0.18,
            detune_cents=12,
            cutoff_start=9,
            cutoff_end=4.0,
            resonance=0.2,
            drive=3.2,
        ),
        pad=Voice(
            harmonics=[(1, 1.0), (2, 0.6), (3, 0.44), (4, 0.3)],
            attack=0.02,
            decay=0.8,
            sustain=0.5,
            release=0.4,
            detune_cents=16,
            cutoff_start=7,
            cutoff_end=3.0,
            drive=2.6,
            level=0.45,
        ),
        bass=Voice(
            harmonics=[(1, 1.0), (2, 0.6), (3, 0.35), (4, 0.18)],
            attack=0.003,
            decay=0.25,
            sustain=0.7,
            release=0.1,
            cutoff_start=5,
            cutoff_end=2.2,
            drive=2.4,
            level=1.0,
        ),
        kick=1.0,
        snare=0.85,
        hat=0.34,
        delay_beats=0.5,
        delay_mix=0.08,
        reverb=0.14,
        bass_pattern=(0, 2, 4, 6, 8, 10, 12, 14),
    ),
    "tide": StyleKit(
        lead=Voice(
            harmonics=[(1, 1.0), (2, 0.5), (3, 0.36), (4, 0.22), (6, 0.1)],
            attack=0.02,
            decay=0.5,
            sustain=0.55,
            release=0.3,
            detune_cents=11,
            cutoff_start=7,
            cutoff_end=3.0,
            drive=1.4,
        ),
        pad=Voice(
            harmonics=[(1, 1.0), (2, 0.46), (3, 0.3), (4, 0.16)],
            attack=0.08,
            decay=1.0,
            sustain=0.6,
            release=0.6,
            detune_cents=18,
            cutoff_start=5,
            cutoff_end=2.4,
            level=0.5,
        ),
        bass=Voice(
            harmonics=[(1, 1.0), (2, 0.4), (3, 0.14)],
            attack=0.008,
            decay=0.4,
            sustain=0.5,
            release=0.2,
            cutoff_start=4,
            cutoff_end=1.9,
            level=0.95,
        ),
        kick=0.8,
        snare=0.5,
        hat=0.2,
        delay_beats=0.75,
        delay_mix=0.12,
        reverb=0.34,
        # Three-four feel: strong one, two lighter beats.
        bass_pattern=(0, 6, 12),
        hat_division=4,
    ),
    "grove": StyleKit(
        lead=Voice(
            harmonics=[(1, 1.0), (2, 0.22), (3, 0.1), (4, 0.04)],
            attack=0.05,
            decay=1.1,
            sustain=0.3,
            release=0.7,
            cutoff_start=4.5,
            cutoff_end=1.9,
            drive=1.05,
        ),
        pad=Voice(
            harmonics=[(1, 1.0), (2, 0.2), (3, 0.09)],
            attack=0.5,
            decay=1.6,
            sustain=0.6,
            release=1.4,
            detune_cents=7,
            cutoff_start=3.4,
            cutoff_end=1.6,
            level=0.55,
        ),
        bass=Voice(
            harmonics=[(1, 1.0), (2, 0.26)],
            attack=0.015,
            decay=0.6,
            sustain=0.45,
            release=0.3,
            cutoff_start=3.2,
            cutoff_end=1.5,
            level=0.9,
        ),
        kick=0.6,
        snare=0.34,
        hat=0.18,
        swing=0.22,
        delay_beats=0.75,
        delay_mix=0.2,
        reverb=0.4,
        bass_pattern=(0, 10),
        hat_division=4,
    ),
    "bloom": StyleKit(
        lead=Voice(
            harmonics=[(1, 1.0), (2, 0.4), (3, 0.24), (4, 0.12), (6, 0.05)],
            attack=0.005,
            decay=0.28,
            sustain=0.4,
            release=0.22,
            detune_cents=6,
            cutoff_start=10,
            cutoff_end=3.6,
            resonance=0.2,
            drive=1.3,
        ),
        pad=Voice(
            harmonics=[(1, 1.0), (2, 0.36), (3, 0.18), (4, 0.08)],
            attack=0.2,
            decay=1.0,
            sustain=0.65,
            release=0.8,
            detune_cents=10,
            cutoff_start=5.5,
            cutoff_end=2.4,
            level=0.5,
        ),
        bass=Voice(
            harmonics=[(1, 1.0), (2, 0.45), (3, 0.16)],
            attack=0.004,
            decay=0.24,
            sustain=0.6,
            release=0.12,
            cutoff_start=5,
            cutoff_end=2.2,
            drive=1.6,
            level=0.95,
        ),
        kick=0.95,
        snare=0.6,
        hat=0.28,
        delay_beats=0.5,
        delay_mix=0.16,
        reverb=0.24,
        bass_pattern=(0, 8, 12),
    ),
}


def _adsr(length: int, sr: int, voice: Voice) -> np.ndarray:
    """Attack, decay, sustain, release as a single envelope array."""
    env = np.zeros(length, dtype=np.float32)

    attack = max(1, int(voice.attack * sr))
    decay = max(1, int(voice.decay * sr))
    release = max(1, int(voice.release * sr))
    sustain_len = max(0, length - attack - decay - release)

    cursor = 0
    end = min(length, cursor + attack)
    if end > cursor:
        env[cursor:end] = np.linspace(0, 1, end - cursor, dtype=np.float32)
    cursor = end

    end = min(length, cursor + decay)
    if end > cursor:
        env[cursor:end] = np.linspace(1, voice.sustain, end - cursor, dtype=np.float32)
    cursor = end

    end = min(length, cursor + sustain_len)
    if end > cursor:
        env[cursor:end] = voice.sustain
    cursor = end

    if length > cursor:
        env[cursor:] = np.linspace(
            voice.sustain, 0, length - cursor, dtype=np.float32
        )

    return env


def _one_pole_lowpass(signal: np.ndarray, cutoff: np.ndarray, sr: int) -> np.ndarray:
    """Time varying one-pole low-pass.

    Not a filter anyone would ship in a synth, but a moving cutoff is most of
    what makes a note sound plucked or bowed rather than switched on, and this
    is cheap enough to run per note without slowing the stub down.
    """
    out = np.empty_like(signal)
    alpha = 1.0 - np.exp(-2.0 * np.pi * np.clip(cutoff, 20.0, sr * 0.45) / sr)
    state = 0.0
    for i in range(signal.size):
        state += alpha[i] * (signal[i] - state)
        out[i] = state
    return out


def _note(
    freq: float, seconds: float, sr: int, voice: Voice, rng: np.random.Generator
) -> np.ndarray:
    """Render one note."""
    length = max(1, int(seconds * sr))
    t = np.arange(length, dtype=np.float32) / sr
    signal = np.zeros(length, dtype=np.float32)

    # Detuned voices, as (semitone offset, weight). A single pair beating
    # against itself is what stops an additive tone sounding synthetic.
    detune = voice.detune_cents / 1200.0
    layers = ((-detune, 0.5), (detune, 0.5)) if detune else ((0.0, 1.0),)

    for partial, amplitude in voice.harmonics:
        for offset, weight in layers:
            f = freq * partial * (2.0**offset)
            if f >= sr * 0.48:
                continue  # would alias
            phase = rng.random() * 2 * np.pi
            signal += amplitude * weight * np.sin(2 * np.pi * f * t + phase)

    total = sum(a for _, a in voice.harmonics) or 1.0
    signal /= total

    cutoff = freq * np.linspace(
        voice.cutoff_start, voice.cutoff_end, length, dtype=np.float32
    )
    filtered = _one_pole_lowpass(signal, cutoff, sr)
    if voice.resonance > 0:
        # Crude resonance: blend back some of what the filter removed.
        filtered = filtered + voice.resonance * (signal - filtered)

    shaped = filtered * _adsr(length, sr, voice)
    if voice.drive != 1.0:
        shaped = np.tanh(shaped * voice.drive) / np.tanh(voice.drive)

    return (shaped * voice.level).astype(np.float32)


def _infer_key(pitches: np.ndarray) -> tuple[int, bool]:
    """Tonic pitch class and whether the melody reads as minor.

    Histogram the sung pitch classes, correlate against the two triad shapes.
    Rough, but it is the difference between chords that belong under the tune
    and chords that fight it.
    """
    voiced = pitches[pitches > 0]
    if voiced.size == 0:
        return 0, True

    midi = 69 + 12 * np.log2(voiced / 440.0)
    classes = np.bincount(np.round(midi).astype(int) % 12, minlength=12).astype(float)
    if classes.sum() == 0:
        return 0, True
    classes /= classes.sum()

    best = (0, True, -np.inf)
    for tonic in range(12):
        for minor, triad in ((False, (0, 4, 7)), (True, (0, 3, 7))):
            score = sum(classes[(tonic + interval) % 12] for interval in triad)
            # Reward the tonic itself, so the key does not drift to a relative.
            score += classes[tonic] * 0.6
            if score > best[2]:
                best = (tonic, minor, score)

    return best[0], best[1]


def _chord_notes(tonic: int, minor: bool, degree: int) -> list[int]:
    table = _MINOR_TRIADS if minor else _MAJOR_TRIADS
    return [tonic + interval for interval in table[degree % len(table)]]


def _midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _drums(
    samples: int,
    sr: int,
    beat: float,
    kit: StyleKit,
    rng: np.random.Generator,
    beat_times: np.ndarray | None = None,
    bar_offset: int = 0,
) -> np.ndarray:
    """Kick on 1 and 3, snare on 2 and 4, hats between.

    When the song's own beat times are supplied, every hit is placed on one of
    them. That is the difference between a backing track someone can sing over
    and one they cannot: a grid computed from average tempo and started at zero
    is at the right speed but the wrong phase, and drifts as the song breathes.
    Real recordings are not metronomic, so following the measured beats is the
    only way to stay locked for three minutes.
    """
    out = np.zeros(samples, dtype=np.float32)
    sixteenth = beat / 4.0

    def place(buffer: np.ndarray, at: float) -> None:
        start = int(at * sr)
        # A beat just before this chunk still has its tail inside it, so a
        # negative start trims the buffer rather than being dropped. Without
        # the trim, numpy reads the negative index from the end of the array
        # and the shapes stop matching.
        if start < 0:
            buffer = buffer[-start:]
            start = 0
        if buffer.size == 0 or start >= samples:
            return
        end = min(samples, start + buffer.size)
        out[start:end] += buffer[: end - start]

    # Kick: pitch dropping fast, which is what makes it read as a drum.
    kick_len = int(0.18 * sr)
    kt = np.arange(kick_len, dtype=np.float32) / sr
    kick = (
        np.sin(2 * np.pi * (110 * np.exp(-kt * 28) + 42) * kt)
        * np.exp(-kt * 14)
        * kit.kick
    ).astype(np.float32)

    # Snare: noise plus a tuned body.
    snare_len = int(0.16 * sr)
    st = np.arange(snare_len, dtype=np.float32) / sr
    snare = (
        (rng.normal(0, 1, snare_len).astype(np.float32) * 0.7
         + np.sin(2 * np.pi * 190 * st) * 0.3)
        * np.exp(-st * 22)
        * kit.snare
    ).astype(np.float32)

    hat_len = int(0.05 * sr)
    ht = np.arange(hat_len, dtype=np.float32) / sr
    hat = (
        rng.normal(0, 1, hat_len).astype(np.float32) * np.exp(-ht * 90) * kit.hat
    ).astype(np.float32)

    if beat_times is not None and beat_times.size >= 2:
        # Play the song's beats. Subdivisions are interpolated between
        # consecutive measured beats, so they follow any tempo drift too.
        for index, start in enumerate(beat_times):
            if start >= samples / sr:
                break
            nxt = beat_times[index + 1] if index + 1 < beat_times.size else start + beat
            span = max(1e-3, float(nxt - start))
            # bar_offset shifts which beat counts as one. Without it the kick
            # lands on the backbeat roughly half the time, which is a whole
            # beat of phase error and the single most disorienting thing a
            # backing track can do.
            in_bar = (index - bar_offset) % 4

            if in_bar in (0, 2):
                place(kick, float(start))
            if in_bar in (1, 3):
                place(snare, float(start))
            if kit.kick > 0.9 and in_bar == 2:
                place(kick, float(start) + span * 0.5)

            # Hats on the beat and, unless the style is sparse, the offbeat.
            place(hat, float(start))
            if kit.hat_division <= 2:
                offset = span * (0.5 + kit.swing * 0.25)
                place(hat * 0.7, float(start) + offset)
        return out

    # No measured beats: fall back to a metronomic grid.
    step = 0
    position = 0.0
    while position < samples / sr:
        in_bar = step % 16

        if in_bar in (0, 8) or (kit.kick > 0.9 and in_bar == 10):
            place(kick, position)
        if in_bar in (4, 12):
            place(snare, position)
        if in_bar % kit.hat_division == 0:
            offset = kit.swing * sixteenth if in_bar % 2 == 1 else 0.0
            place(hat * (0.7 if in_bar % 4 else 1.0), position + offset)

        step += 1
        position = step * sixteenth

    return out


def _delay(signal: np.ndarray, sr: int, seconds: float, mix: float) -> np.ndarray:
    """Feedback delay. Cheap, and it is most of what creates a sense of space."""
    if mix <= 0 or seconds <= 0:
        return signal
    out = signal.copy()
    lag = int(seconds * sr)
    if lag <= 0 or lag >= signal.size:
        return out
    level = mix
    offset = lag
    while level > 0.02 and offset < signal.size:
        out[offset:] += signal[: signal.size - offset] * level
        level *= 0.45
        offset += lag
    return out


def _reverb_tail(signal: np.ndarray, sr: int, amount: float) -> np.ndarray:
    """Exponentially decaying noise convolution, truncated short.

    A real reverb this is not, but a dry additive synth sounds like it was
    recorded inside a phone, and this is enough to put it in a room.
    """
    if amount <= 0:
        return signal
    length = int(0.45 * sr)
    rng = np.random.default_rng(7)
    impulse = (
        rng.normal(0, 1, length).astype(np.float32) * np.exp(
            -np.arange(length, dtype=np.float32) / (0.13 * sr)
        )
    )
    impulse /= np.abs(impulse).sum() + 1e-9
    wet = np.convolve(signal, impulse, mode="full")[: signal.size].astype(np.float32)
    return ((1 - amount) * signal + amount * wet).astype(np.float32)


def _chord_voicing(root: int, quality: str) -> list[int]:
    """Triad as semitone offsets above the root."""
    return [root, root + (3 if quality == "min" else 4), root + 7]


def _plan_from_chords(
    chords: list[dict], chunk_start: float, seconds: float
) -> list[tuple[float, float, int, str]]:
    """Chord segments overlapping this chunk, in chunk-local time."""
    plan: list[tuple[float, float, int, str]] = []
    for chord in chords:
        start = chord["start"] - chunk_start
        end = chord["end"] - chunk_start
        if end <= 0 or start >= seconds:
            continue
        plan.append((max(0.0, start), min(seconds, end), int(chord["root"]), chord["quality"]))
    return plan


def render(
    pitches: np.ndarray,
    frame_seconds: float,
    style_id: str,
    bpm: float,
    seconds: float,
    sr: int,
    seed: int,
    chords: list[dict] | None = None,
    chunk_start: float = 0.0,
    beat_times: np.ndarray | None = None,
    downbeat_phase: int = 0,
) -> np.ndarray:
    """Render a placeholder instrumental for one chunk.

    `pitches` is a coarse per-frame f0 track of the source, zero where unvoiced.
    `chords` is the source song's own progression, in absolute song time.

    Using the real chords is the whole difference between an instrumental that
    belongs to this song and one that merely shares its key. An earlier version
    inferred a tonic and then looped a canned four bar progression, which was
    fine for a few seconds and increasingly wrong over a verse: the backing was
    playing a different song in the same key.
    """
    kit = KITS.get(style_id, KITS["bloom"])
    rng = np.random.default_rng(seed)
    samples = max(1, int(seconds * sr))

    tonic, minor = _infer_key(pitches)

    bpm = float(np.clip(bpm if bpm and bpm > 0 else 100.0, 60, 170))
    beat = 60.0 / bpm
    bar = beat * 4

    lead = np.zeros(samples, dtype=np.float32)
    pad = np.zeros(samples, dtype=np.float32)
    bass = np.zeros(samples, dtype=np.float32)

    def mix_into(target: np.ndarray, buffer: np.ndarray, at: float) -> None:
        start = int(at * sr)
        # See the note in _drums.place: a negative start trims, it does not
        # index from the end of the array.
        if start < 0:
            buffer = buffer[-start:]
            start = 0
        if buffer.size == 0 or start >= samples:
            return
        end = min(samples, start + buffer.size)
        target[start:end] += buffer[: end - start]

    # Beats arrive in absolute song time; the chunk needs them relative to its
    # own start, and only the ones that fall inside it.
    local_beats = None
    if beat_times is not None and np.asarray(beat_times).size:
        shifted = np.asarray(beat_times, dtype=np.float64) - chunk_start
        local_beats = shifted[(shifted >= -beat) & (shifted < seconds + beat)]

    # --- chords and bass ---
    plan = _plan_from_chords(chords or [], chunk_start, seconds)

    if not plan:
        # No chord analysis available, so fall back to a progression in the
        # inferred key. Better than silence, and honest about being a guess.
        progression = _PROGRESSIONS.get(style_id, _PROGRESSIONS["bloom"])
        bar_index = 0
        while bar_index * bar < seconds:
            degree = progression[bar_index % len(progression)]
            notes = _chord_notes(tonic, minor, degree)
            plan.append(
                (
                    bar_index * bar,
                    min(seconds, (bar_index + 1) * bar),
                    notes[0] % 12,
                    "min" if minor else "maj",
                )
            )
            bar_index += 1

    for start, end, root, quality in plan:
        span = end - start
        if span <= 0.05:
            continue

        # Pad holds the triad for as long as the chord lasts, voiced around the
        # octave below middle C so it sits under a sung melody.
        for interval in _chord_voicing(root, quality):
            mix_into(
                pad,
                _note(_midi_to_hz(48 + (interval % 24)), span * 1.05, sr, kit.pad, rng),
                start,
            )

        # Bass on the measured beats inside this chord, so it moves with the
        # song rather than against it. Which beats depends on the style: a
        # walking jazz line hits every one, a pop line hits the strong ones.
        if local_beats is not None and local_beats.size:
            inside = local_beats[(local_beats >= start - 0.03) & (local_beats < end)]
            every = 1 if len(kit.bass_pattern) >= 4 else 2
            for offset, at in enumerate(inside):
                if offset % every:
                    continue
                mix_into(
                    bass,
                    _note(_midi_to_hz(36 + (root % 24)), beat * 0.95, sr, kit.bass, rng),
                    float(at),
                )
        else:
            position = start
            while position < end - 0.05:
                for sixteenth in kit.bass_pattern:
                    at = position + sixteenth * (beat / 4)
                    if at >= end:
                        break
                    mix_into(
                        bass,
                        _note(_midi_to_hz(36 + (root % 24)), beat * 0.9, sr, kit.bass, rng),
                        at,
                    )
                position += bar

    # --- counter-line ---
    #
    # Deliberately not the vocal melody. An earlier version tracked the melody
    # with autocorrelation over the full mix and played it back an octave down.
    # Two things were wrong with that. Autocorrelation on a full mix locks onto
    # whatever is loudest from moment to moment, bass one instant and a cymbal
    # the next, so the line was largely random notes. And even done perfectly,
    # a backing track that plays the tune competes with the person singing it,
    # which is why commercial karaoke tracks leave the melody out.
    #
    # What is left is a sparse chord-tone line: notes drawn from the chord
    # under them, held long, sitting well below the vocal register.
    for start, end, root, quality in plan:
        span = end - start
        if span <= 0.4:
            continue

        voicing = _chord_voicing(root, quality)
        # The third and fifth, not the root: the bass already has the root, and
        # doubling it just thickens the low end.
        tone = voicing[1 + (int(start * 2) % 2)]

        # One note per chord, entering just after the change so it answers the
        # harmony rather than announcing it, and held for most of the chord.
        mix_into(
            lead,
            _note(_midi_to_hz(60 + (tone % 12)), span * 0.7, sr, kit.lead, rng),
            start + min(0.25, span * 0.15),
        )

    # The chunk starts partway through the song, so the bar phase has to be
    # rotated by however many beats were dropped ahead of it.
    dropped = 0
    if beat_times is not None and np.asarray(beat_times).size:
        dropped = int(np.sum(np.asarray(beat_times) < chunk_start - beat))
    local_offset = (downbeat_phase - dropped) % 4

    drums = _drums(samples, sr, beat, kit, rng, local_beats, local_offset)

    mixed = (
        0.42 * _delay(lead, sr, kit.delay_beats * beat, kit.delay_mix)
        + 0.30 * pad
        + 0.44 * bass
        + 0.38 * drums
    ).astype(np.float32)

    mixed = _reverb_tail(mixed, sr, kit.reverb)

    # Gentle bus compression, so the drums do not punch holes in the mix.
    mixed = np.tanh(mixed * 1.35) / np.tanh(1.35)

    peak = float(np.max(np.abs(mixed))) or 1.0
    return (mixed * (0.85 / peak)).astype(np.float32)
