"""Lyrics transcription and alignment.

faster-whisper (CTranslate2) rather than openai-whisper: roughly half the VRAM
for the same checkpoint, which matters when it has to share an 8GB card with
the music model. It still goes through the registry, so loading Whisper evicts
MusicGen and vice versa.
"""

from __future__ import annotations

from pathlib import Path

from .. import config
from . import registry


def _load_whisper():
    from faster_whisper import WhisperModel

    device = "cuda" if registry.cuda_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    return WhisperModel(config.WHISPER_MODEL, device=device, compute_type=compute_type)


def transcribe_file(path: Path) -> dict:
    """Return {"lyrics": [{text, start, end}], "language": str | None}."""
    if config.STUB_MODE:
        return _stub_lyrics(path)

    with registry.gpu_lock:
        model = registry.acquire("whisper", _load_whisper)
        registry.touch()

        segments, info = model.transcribe(
            str(path),
            vad_filter=True,
            beam_size=5,
            # Singing is not speech; without this Whisper tends to collapse long
            # sustained vowels into repeated filler phrases.
            condition_on_previous_text=False,
        )

        lyrics = [
            {
                "text": segment.text.strip(),
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
            }
            for segment in segments
            if segment.text and segment.text.strip()
        ]

    return {
        "lyrics": lyrics,
        "language": getattr(info, "language", None),
        "stub": False,
    }


def _stub_lyrics(path: Path) -> dict:
    """Placeholder timing so the karaoke view has something to scroll.

    Deliberately obvious rather than plausible-sounding, so nobody mistakes stub
    output for a real transcription.
    """
    from ..audio_utils import load_mono

    audio, sr = load_mono(path, 22050)
    duration = len(audio) / sr

    lines = [
        "(stub transcription - install faster-whisper and set STUB_MODE=0)",
        "la la la",
        "this line is placeholder timing",
        "sing whatever you like",
        "the backing track is what matters here",
        "la la la",
    ]
    span = max(2.0, duration / max(1, len(lines)))
    return {
        "lyrics": [
            {
                "text": text,
                "start": round(index * span, 3),
                "end": round(min(duration, (index + 1) * span), 3),
            }
            for index, text in enumerate(lines)
        ],
        "language": "en",
        "stub": True,
    }
