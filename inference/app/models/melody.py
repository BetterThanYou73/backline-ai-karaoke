"""Melody-conditioned instrumental generation.

Two implementations behind one entry point, `render_track`:

* STUB_MODE=1 - a small additive synth that plays the extracted melody contour
  with per-style timbre. No model download, runs in about a second, and it
  exercises the exact same chunk/crossfade/length-match path as the real model,
  so the App Server and the client DSP layer can be built and tested first.

* STUB_MODE=0 - MusicGen-melody. MusicGen emits at most 30 seconds per call, so
  a full song is rendered as successive windows, each conditioned on the melody
  of that window, then crossfaded. Seams are the known quality seam of this
  approach: the model has no memory across windows, so harmony can shift at a
  boundary. Fixed per-song+style seeding keeps it deterministic.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from .. import config
from ..audio_utils import (
    equal_power_crossfade,
    load_mono,
    match_length,
    normalize_peak,
)
from ..styles import STYLES, Style
from . import registry, stub_synth

ProgressFn = Callable[[float], None]


def stable_seed(song_id: str, style: str) -> int:
    """Deterministic per song+style, so a re-render reproduces the cached take."""
    digest = hashlib.sha256(f"{song_id}::{style}".encode()).digest()
    return int.from_bytes(digest[:4], "big")


def _chunk_plan(total_seconds: float) -> list[tuple[float, float]]:
    """Window start/length pairs covering `total_seconds`.

    Windows overlap by exactly the crossfade length, because the crossfade
    consumes that much when the chunks are joined: joining two buffers with an
    overlap of C yields len(a) + len(b) - C samples.

    An earlier version planned contiguous windows, so every seam pulled the
    whole timeline earlier by C. Generated audio at output time T then carried
    material conditioned on source time T + k*C after k seams. That is not just
    a cosmetic wobble: lyric timestamps and the reference melody contour are
    both in source time, and the performance screen compares them against a
    position in the generated track. At the default 90 seconds it drifted two
    seconds by the end, and on a full song, seven.
    """
    chunk = max(5.0, min(config.CHUNK_SECONDS, 30.0))
    crossfade = max(0.0, min(config.CROSSFADE_SECONDS, chunk / 2))
    advance = max(1.0, chunk - crossfade)

    plan: list[tuple[float, float]] = []
    position = 0.0
    while position < total_seconds - 0.25:
        # The final window is short; everything before it is a full chunk so
        # the crossfade always has the material it needs on both sides.
        length = min(chunk, total_seconds - position)
        plan.append((position, length))
        if position + length >= total_seconds:
            break
        position += advance

    return plan or [(0.0, min(chunk, max(total_seconds, 5.0)))]


def render_track(
    source_path: Path,
    style_id: str,
    song_id: str,
    max_seconds: Optional[float] = None,
    seed: Optional[int] = None,
    progress: Optional[ProgressFn] = None,
) -> tuple[np.ndarray, int]:
    """Render a full backing track. Returns (mono float32 audio, sample_rate)."""
    style = STYLES[style_id]
    limit = max_seconds if max_seconds is not None else config.MAX_RENDER_SECONDS
    seed = seed if seed is not None else stable_seed(song_id, style_id)

    audio, sr = load_mono(source_path, config.GENERATION_SR)
    total = len(audio) / sr
    if limit and limit > 0:
        total = min(total, limit)

    plan = _chunk_plan(total)

    # Chords come from the whole song, once, not per chunk. A 30 second window
    # does not contain enough context to tell a progression from a coincidence,
    # and the chunk renderers need absolute song time anyway to know which
    # chord they are sitting on.
    chords = _chords_for(audio, sr) if config.STUB_MODE else []

    rendered = np.zeros(0, dtype=np.float32)
    chunk_seconds = max(5.0, min(config.CHUNK_SECONDS, 30.0))
    crossfade = int(
        max(0.0, min(config.CROSSFADE_SECONDS, chunk_seconds / 2))
        * config.GENERATION_SR
    )

    for index, (start, length) in enumerate(plan):
        begin = int(start * sr)
        end = int((start + length) * sr)
        melody = audio[begin:end]

        chunk = (
            _stub_chunk(melody, sr, style, seed + index, length, chords, start)
            if config.STUB_MODE
            else _musicgen_chunk(melody, sr, style, seed + index, length)
        )
        chunk = match_length(chunk, int(length * config.GENERATION_SR))

        rendered = (
            chunk
            if rendered.size == 0
            else equal_power_crossfade(rendered, chunk, crossfade)
        )
        if progress:
            progress((index + 1) / len(plan))

    # The plan overlaps windows by the crossfade so this lands on the source
    # length, but rounding across many seams can leave it a few samples out.
    # Lyric and melody timing are read against this, so pin it exactly.
    rendered = match_length(rendered, int(total * config.GENERATION_SR))

    return normalize_peak(rendered), config.GENERATION_SR


# --------------------------------------------------------------------------
# Real path: MusicGen-melody via transformers
# --------------------------------------------------------------------------
#
# transformers rather than audiocraft. audiocraft pulls in xformers and an `av`
# pin with no Windows wheel for this Python version, so it wants a full C++
# toolchain to install. transformers ships the same MusicGen-melody weights
# through MusicgenMelodyForConditionalGeneration as a pure-Python wheel, and
# the conditioning path is identical: the processor extracts chroma from the
# melody audio and the model generates against it.

# MusicGen's audio codec runs at 50 frames per second, so a token count is just
# seconds times fifty.
TOKENS_PER_SECOND = 50


def _load_musicgen():
    import torch
    from transformers import AutoProcessor, MusicgenMelodyForConditionalGeneration

    name = config.MODEL_PATH or config.MUSICGEN_MODEL
    use_cuda = torch.cuda.is_available() and config.DEVICE.startswith("cuda")

    # 1.5B params at fp32 is about 6GB of weights alone, which leaves nothing
    # for activations on an 8GB card. fp16 halves that.
    dtype = torch.float16 if use_cuda else torch.float32

    processor = AutoProcessor.from_pretrained(name)
    model = MusicgenMelodyForConditionalGeneration.from_pretrained(
        name, torch_dtype=dtype
    )
    model = model.to("cuda" if use_cuda else "cpu")
    model.eval()

    return {"model": model, "processor": processor}


def _musicgen_chunk(
    melody: np.ndarray, sr: int, style: Style, seed: int, seconds: float
) -> np.ndarray:
    import torch

    with registry.gpu_lock:
        bundle = registry.acquire("musicgen", _load_musicgen)
        registry.touch()

        model = bundle["model"]
        processor = bundle["processor"]
        device = next(model.parameters()).device

        inputs = processor(
            audio=melody,
            sampling_rate=sr,
            text=[style.prompt],
            padding=True,
            return_tensors="pt",
        ).to(device)

        # The processor always emits fp32 chroma, but the weights are fp16, and
        # the first matmul refuses to mix them. Cast only the floating point
        # entries: input_ids and attention masks are integer tensors and must
        # stay that way.
        model_dtype = next(model.parameters()).dtype
        for key, value in inputs.items():
            if torch.is_tensor(value) and value.is_floating_point():
                inputs[key] = value.to(model_dtype)

        torch.manual_seed(seed)

        try:
            with torch.inference_mode():
                output = model.generate(
                    **inputs,
                    do_sample=True,
                    guidance_scale=style.cfg_coef,
                    max_new_tokens=int(seconds * TOKENS_PER_SECOND),
                )
        except torch.cuda.OutOfMemoryError as exc:  # pragma: no cover
            registry.unload()
            raise RuntimeError(
                "CUDA out of memory during generation. On an 8GB card try "
                "lowering CHUNK_SECONDS to 15 in inference/.env, or set "
                "DEVICE=cpu to trade speed for headroom."
            ) from exc

        return output[0, 0].detach().float().cpu().numpy().astype(np.float32)




# --------------------------------------------------------------------------
# Stub path: a small arranged band, see stub_synth.py
# --------------------------------------------------------------------------


def _chords_for(audio: np.ndarray, sr: int) -> list[dict]:
    """The source song's own chord progression, or [] if it cannot be had."""
    try:
        from .analyze import extract_chords

        return extract_chords(audio, sr)
    except Exception:
        return []


def _stub_chunk(
    melody: np.ndarray,
    sr: int,
    style: Style,
    seed: int,
    seconds: float,
    chords: list[dict] | None = None,
    chunk_start: float = 0.0,
) -> np.ndarray:
    """Placeholder instrumental, built from the source melody and its chords.

    Extracts a coarse pitch track, then hands it and the song's real chord
    progression to the stub arranger.
    """
    frame = int(0.046 * sr)
    if frame <= 0:
        frame = 1024

    pitches = np.array(
        [
            _autocorr_pitch(melody[start : start + frame], sr)
            for start in range(0, max(frame, len(melody) - frame), frame)
        ],
        dtype=np.float32,
    )
    if pitches.size == 0:
        pitches = np.zeros(1, dtype=np.float32)

    return stub_synth.render(
        pitches=pitches,
        frame_seconds=frame / sr,
        style_id=style.id,
        bpm=_estimate_bpm(melody, sr),
        seconds=seconds,
        sr=config.GENERATION_SR,
        seed=seed,
        chords=chords,
        chunk_start=chunk_start,
    )


def _estimate_bpm(audio: np.ndarray, sr: int) -> float:
    """Tempo of the source, so the stub band plays along with it."""
    try:
        import librosa

        onset = librosa.onset.onset_strength(y=audio, sr=sr)
        try:
            from librosa.feature import rhythm as _rhythm

            tempo = _rhythm.tempo(onset_envelope=onset, sr=sr)
        except (ImportError, AttributeError):
            tempo = librosa.beat.tempo(onset_envelope=onset, sr=sr)
        return float(np.atleast_1d(tempo)[0])
    except Exception:
        return 100.0


def _autocorr_pitch(
    window: np.ndarray, sr: int, fmin: float = 65.0, fmax: float = 1000.0
) -> float:
    if window.size < 64 or float(np.max(np.abs(window))) < 1e-3:
        return 0.0
    window = window - float(np.mean(window))
    correlation = np.correlate(window, window, mode="full")[window.size - 1 :]
    min_lag = int(sr / fmax)
    max_lag = min(int(sr / fmin), correlation.size - 1)
    if max_lag <= min_lag:
        return 0.0
    lag = int(np.argmax(correlation[min_lag:max_lag])) + min_lag
    if correlation[0] <= 0 or correlation[lag] / correlation[0] < 0.3:
        return 0.0
    return float(sr) / lag


__all__ = ["render_track", "stable_seed"]
