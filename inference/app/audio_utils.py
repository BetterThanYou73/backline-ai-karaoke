"""Audio I/O helpers shared by the analyze / generate / transcribe paths.

librosa and soundfile are imported lazily: they pull in numba and take a few
seconds, and STUB_MODE health checks should not pay for that.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import uuid
from pathlib import Path

import numpy as np

from . import config


def resolve_source(
    audio_url: str | None = None,
    audio_base64: str | None = None,
    audio_path: str | None = None,
) -> Path:
    """Materialize any of the three source forms as a local file.

    Downloaded/decoded payloads land in UPLOAD_DIR under a content hash so the
    same upload does not accumulate copies across retries.
    """
    config.ensure_dirs()

    if audio_path:
        path = Path(audio_path)
        if not path.is_file():
            raise FileNotFoundError(f"audio_path does not exist: {audio_path}")
        return path

    if audio_base64:
        payload = audio_base64
        if "," in payload[:64] and payload.lstrip().startswith("data:"):
            payload = payload.split(",", 1)[1]
        try:
            raw = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"audio_base64 is not valid base64: {exc}") from exc
        return _write_upload(raw)

    if audio_url:
        import httpx

        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            response = client.get(audio_url)
            response.raise_for_status()
            return _write_upload(response.content)

    raise ValueError("no audio source provided")


def _write_upload(raw: bytes) -> Path:
    if not raw:
        raise ValueError("audio payload is empty")
    digest = hashlib.sha256(raw).hexdigest()[:20]
    # Extension is unknown here; soundfile/librosa sniff the container, and
    # librosa falls back to audioread/ffmpeg for mp3.
    path = config.UPLOAD_DIR / f"{digest}.audio"
    if not path.exists():
        path.write_bytes(raw)
    return path


def load_mono(path: Path, sr: int) -> tuple[np.ndarray, int]:
    """Load `path` as mono float32 at `sr`."""
    import librosa

    audio, actual_sr = librosa.load(str(path), sr=sr, mono=True)
    return audio.astype(np.float32, copy=False), int(actual_sr)


def write_wav(audio: np.ndarray, sr: int, path: Path) -> Path:
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(audio, -1.0, 1.0), sr, subtype="PCM_16")
    return path


def output_path(stem: str, suffix: str = ".wav") -> Path:
    config.ensure_dirs()
    return config.OUTPUT_DIR / f"{stem}{suffix}"


def unique_stem(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def equal_power_crossfade(a: np.ndarray, b: np.ndarray, overlap: int) -> np.ndarray:
    """Join two buffers with an equal-power crossfade over `overlap` samples.

    Equal-power (cos/sin) rather than linear: successive MusicGen chunks are
    uncorrelated, so a linear fade dips audibly in the middle of every seam.
    """
    if a.size == 0:
        return b
    if b.size == 0:
        return a

    overlap = int(min(overlap, a.size, b.size))
    if overlap <= 0:
        return np.concatenate([a, b])

    t = np.linspace(0.0, 1.0, overlap, endpoint=False, dtype=np.float32)
    fade_out = np.cos(t * np.pi / 2.0)
    fade_in = np.sin(t * np.pi / 2.0)

    head = a[:-overlap]
    seam = a[-overlap:] * fade_out + b[:overlap] * fade_in
    tail = b[overlap:]
    return np.concatenate([head, seam, tail])


def match_length(audio: np.ndarray, target_samples: int) -> np.ndarray:
    """Trim or zero-pad to exactly `target_samples`.

    MusicGen returns whole tokens, so a chunk is usually a few dozen ms longer
    than requested. Forcing the exact length keeps chunk N's start aligned to
    the melody it was conditioned on instead of drifting later every seam.
    """
    if audio.size == target_samples:
        return audio
    if audio.size > target_samples:
        return audio[:target_samples]
    return np.pad(audio, (0, target_samples - audio.size))


def normalize_peak(audio: np.ndarray, peak: float = 0.89) -> np.ndarray:
    current = float(np.max(np.abs(audio))) if audio.size else 0.0
    if current < 1e-6:
        return audio
    return (audio * (peak / current)).astype(np.float32, copy=False)
