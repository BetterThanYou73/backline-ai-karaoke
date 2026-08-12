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


def analyze_file(path: Path, with_contour: bool = True) -> dict:
    audio, sr = load_mono(path, ANALYSIS_SR)
    duration = round(len(audio) / sr, 3)
    return {
        "bpm": estimate_bpm(audio, sr),
        "key": estimate_key(audio, sr),
        "melody_contour": extract_melody_contour(audio, sr) if with_contour else [],
        "duration": duration,
    }
