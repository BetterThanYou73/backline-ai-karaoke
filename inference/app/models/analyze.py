"""Tempo / key / melody extraction. Pure librosa, no GPU, no model download.

This path stays real even in STUB_MODE, so the App Server gets true BPM and key
metadata long before the generation model is installed.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..audio_utils import load_mono

ANALYSIS_SR = 22050
HOP = 512

# Krumhansl-Kessler key profiles.
_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
_PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def estimate_key(audio: np.ndarray, sr: int) -> str:
    """Krumhansl-Schmuckler: correlate mean chroma against all 24 rotations."""
    import librosa

    chroma = librosa.feature.chroma_cqt(y=audio, sr=sr, hop_length=HOP)
    profile = chroma.mean(axis=1)
    if profile.sum() <= 0:
        return "unknown"
    profile = profile / profile.sum()

    best_score = -np.inf
    best_key = "unknown"
    for tonic in range(12):
        for name, reference in (("major", _MAJOR), ("minor", _MINOR)):
            rotated = np.roll(reference, tonic)
            score = float(np.corrcoef(profile, rotated)[0, 1])
            if score > best_score:
                best_score = score
                best_key = f"{_PITCH_CLASSES[tonic]} {name}"
    return best_key


def estimate_bpm(audio: np.ndarray, sr: int) -> float:
    import librosa

    onset_env = librosa.onset.onset_strength(y=audio, sr=sr, hop_length=HOP)

    # librosa moved tempo() from .beat to .feature.rhythm during 0.10, and the
    # submodule is not always pulled in by `import librosa`. Try both.
    try:
        from librosa.feature import rhythm as _rhythm

        tempo = _rhythm.tempo(onset_envelope=onset_env, sr=sr, hop_length=HOP)
    except (ImportError, AttributeError):
        tempo = librosa.beat.tempo(onset_envelope=onset_env, sr=sr, hop_length=HOP)

    value = float(np.atleast_1d(tempo)[0])
    # librosa occasionally locks onto a half/double-time interpretation. Fold
    # into the range most karaoke backing tracks actually sit in.
    while value > 0 and value < 60:
        value *= 2
    while value > 190:
        value /= 2
    return round(value, 2)


def extract_melody_contour(
    audio: np.ndarray, sr: int, target_fps: float = 10.0
) -> list[list[float | None]]:
    """Monophonic f0 track as [[seconds, midi | None], ...].

    pyin is the slow step here (tens of seconds on a full song) but it runs once
    per song, and its voiced-flag output is what keeps silence from being
    reported as a bogus pitch.
    """
    import librosa

    f0, voiced_flag, _ = librosa.pyin(
        audio,
        fmin=float(librosa.note_to_hz("C2")),
        fmax=float(librosa.note_to_hz("C7")),
        sr=sr,
        hop_length=HOP,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=HOP)

    stride = max(1, int(round((sr / HOP) / target_fps)))
    contour: list[list[float | None]] = []
    for index in range(0, len(f0), stride):
        hz = f0[index]
        voiced = bool(voiced_flag[index]) if voiced_flag is not None else False
        midi = (
            round(float(librosa.hz_to_midi(hz)), 2)
            if voiced and hz is not None and not np.isnan(hz)
            else None
        )
        contour.append([round(float(times[index]), 3), midi])
    return contour


def extract_beats(audio: np.ndarray, sr: int) -> np.ndarray:
    """The song's actual beat times, in seconds.

    This is the spine of the whole product. Lyrics are timed to the original
    recording, so anything the backing track plays has to land on the
    original's beats, not on a grid computed from an average tempo and started
    at zero. A track at exactly the right bpm but the wrong phase is just as
    unsingable as one at the wrong tempo.
    """
    import librosa

    if audio.size < sr:
        return np.array([])

    # Percussive component: beat tracking wants transients, and the sustained
    # harmonic material only blurs the onset envelope.
    percussive = librosa.effects.percussive(audio, margin=3.0)
    onset = librosa.onset.onset_strength(y=percussive, sr=sr, hop_length=HOP)
    _, frames = librosa.beat.beat_track(
        onset_envelope=onset, sr=sr, hop_length=HOP, tightness=100
    )
    return librosa.frames_to_time(frames, sr=sr, hop_length=HOP)


def estimate_downbeat_phase(
    beat_times: np.ndarray, chords: list[dict], beats_per_bar: int = 4
) -> int:
    """Which beat in the cycle is beat one.

    Beat tracking finds where the beats are, not which of them starts a bar,
    and it has no reason to start its list on a downbeat. Placing a kick on
    index 0 of that list therefore puts it on the backbeat about half the time.
    That is a whole beat of phase error: the grid is right, the bar is wrong,
    and to anyone singing along the song feels displaced.

    Chords are the giveaway. Harmony changes on bar lines far more often than
    inside them, so the phase that catches the most chord changes is the one
    that starts bars.
    """
    if beat_times.size < beats_per_bar or not chords:
        return 0

    changes = np.array([chord["start"] for chord in chords[1:]], dtype=np.float64)
    if changes.size == 0:
        return 0

    # Half a beat: close enough to call a chord change "on" that beat.
    tolerance = float(np.median(np.diff(beat_times))) * 0.5 if beat_times.size > 1 else 0.25

    scores = np.zeros(beats_per_bar)
    for phase in range(beats_per_bar):
        candidates = beat_times[phase::beats_per_bar]
        if candidates.size == 0:
            continue
        for change in changes:
            if np.min(np.abs(candidates - change)) <= tolerance:
                scores[phase] += 1

    return int(np.argmax(scores))


def extract_chords(audio: np.ndarray, sr: int) -> list[dict]:
    """Recover the song's chord progression as timed segments.

    Beat-synchronous chroma matched against the 24 major and minor triads.
    Three things matter for this being usable rather than noise:

    * The harmonic component only. Drums smear energy across every pitch class,
      and on a percussive track the chroma is mostly kick and snare.
    * Aggregating per beat, not per frame. Chords change on musical time, so
      averaging within a beat both denoises and puts the boundaries where they
      belong.
    * Smoothing across beats before committing. Raw per-beat matches flap
      between a chord and its relative, which sounds like a mistake even when
      the average is right.

    Returns [{start, end, root, quality, name}], root as a pitch class 0-11.
    """
    import librosa

    if audio.size < sr:
        return []

    harmonic = librosa.effects.harmonic(audio, margin=3.0)
    tempo, beats = librosa.beat.beat_track(y=harmonic, sr=sr, hop_length=HOP)
    del tempo

    if len(beats) < 4:
        return []

    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=HOP)
    # Median rather than mean: resistant to a single bright transient frame
    # dragging the whole beat toward the wrong pitch class.
    per_beat = librosa.util.sync(chroma, beats, aggregate=np.median)

    templates = []
    labels = []
    for root in range(12):
        for quality, intervals in (("maj", (0, 4, 7)), ("min", (0, 3, 7))):
            template = np.zeros(12, dtype=np.float32)
            for interval in intervals:
                template[(root + interval) % 12] = 1.0
            templates.append(template / np.linalg.norm(template))
            labels.append((root, quality))
    template_matrix = np.stack(templates)

    norms = np.linalg.norm(per_beat, axis=0, keepdims=True)
    normalized = per_beat / np.where(norms > 0, norms, 1.0)
    scores = template_matrix @ normalized  # (24, n_beats)

    raw = np.argmax(scores, axis=0)

    # Smooth over a five beat window, roughly a bar either side.
    smoothed = np.copy(raw)
    window = 2
    for i in range(len(raw)):
        lo = max(0, i - window)
        hi = min(len(raw), i + window + 1)
        values, counts = np.unique(raw[lo:hi], return_counts=True)
        smoothed[i] = values[np.argmax(counts)]

    # sync() aggregates the spans *between* boundaries, so N beat frames give
    # N+1 columns: before the first beat, each gap, and after the last. The
    # time boundaries have to be padded to match or the last beat indexes off
    # the end.
    beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=HOP)
    bounds = np.concatenate([[0.0], beat_times, [len(audio) / sr]])

    segments: list[dict] = []
    for index, choice in enumerate(smoothed):
        if index + 1 >= len(bounds):
            break
        root, quality = labels[int(choice)]
        start = float(bounds[index])
        end = float(bounds[index + 1])

        if segments and segments[-1]["root"] == root and segments[-1]["quality"] == quality:
            segments[-1]["end"] = round(end, 3)
            continue

        segments.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "root": int(root),
                "quality": quality,
                "name": f"{_PITCH_CLASSES[root]}{'' if quality == 'maj' else 'm'}",
            }
        )

    # Drop anything shorter than half a beat: those are transitions, not chords.
    minimum = 0.2
    return [s for s in segments if s["end"] - s["start"] >= minimum]


def analyze_file(path: Path, with_contour: bool = True) -> dict:
    audio, sr = load_mono(path, ANALYSIS_SR)
    duration = round(len(audio) / sr, 3)
    return {
        "bpm": estimate_bpm(audio, sr),
        "key": estimate_key(audio, sr),
        "chords": extract_chords(audio, sr),
        "melody_contour": extract_melody_contour(audio, sr) if with_contour else [],
        "duration": duration,
    }
