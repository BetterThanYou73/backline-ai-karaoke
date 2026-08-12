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
from . import registry

ProgressFn = Callable[[float], None]


def stable_seed(song_id: str, style: str) -> int:
    """Deterministic per song+style, so a re-render reproduces the cached take."""
    digest = hashlib.sha256(f"{song_id}::{style}".encode()).digest()
    return int.from_bytes(digest[:4], "big")


def _chunk_plan(total_seconds: float) -> list[tuple[float, float]]:
    """Window start/length pairs covering `total_seconds`.

    Windows are contiguous; the crossfade is applied by overlapping the joined
    audio, not by overlapping the conditioning, so the melody stays aligned to
    absolute song time.
    """
    chunk = max(5.0, min(config.CHUNK_SECONDS, 30.0))
    plan: list[tuple[float, float]] = []
    position = 0.0
    while position < total_seconds - 0.25:
        length = min(chunk, total_seconds - position)
        plan.append((position, length))
        position += length
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
    render_chunk = _stub_chunk if config.STUB_MODE else _musicgen_chunk

    rendered = np.zeros(0, dtype=np.float32)
    crossfade = int(max(0.0, config.CROSSFADE_SECONDS) * config.GENERATION_SR)

    for index, (start, length) in enumerate(plan):
        begin = int(start * sr)
        end = int((start + length) * sr)
        melody = audio[begin:end]

        chunk = render_chunk(melody, sr, style, seed + index, length)
        chunk = match_length(chunk, int(length * config.GENERATION_SR))

        rendered = (
            chunk
            if rendered.size == 0
            else equal_power_crossfade(rendered, chunk, crossfade)
        )
        if progress:
            progress((index + 1) / len(plan))

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
# Stub path: additive synth driven by the melody contour
# --------------------------------------------------------------------------

# Per-style timbre for the stub renderer, so the six styles are actually
# distinguishable while building the UI.
_STUB_VOICES: dict[str, dict] = {
    "neon": {"harmonics": [1.0, 0.5, 0.35, 0.2], "detune": 0.012, "decay": 0.75, "beat": 0.35},
    "velvet": {"harmonics": [1.0, 0.28, 0.12], "detune": 0.004, "decay": 1.6, "beat": 0.16},
    "riff": {"harmonics": [1.0, 0.7, 0.55, 0.45, 0.3], "detune": 0.02, "decay": 0.5, "beat": 0.42},
    "tide": {"harmonics": [1.0, 0.45, 0.3, 0.15], "detune": 0.008, "decay": 0.9, "beat": 0.38},
    "grove": {"harmonics": [1.0, 0.22, 0.08], "detune": 0.003, "decay": 1.9, "beat": 0.2},
    "bloom": {"harmonics": [1.0, 0.4, 0.25, 0.1], "detune": 0.006, "decay": 0.7, "beat": 0.3},
}


def _stub_chunk(
    melody: np.ndarray, sr: int, style: Style, seed: int, seconds: float
) -> np.ndarray:
    voice = _STUB_VOICES.get(style.id, _STUB_VOICES["bloom"])
    out_sr = config.GENERATION_SR
    samples = int(seconds * out_sr)
    rng = np.random.default_rng(seed)

    # Coarse pitch track: peak of the autocorrelation per 46ms frame. Good
    # enough to make the stub follow the tune; the real path uses MusicGen's
    # own chroma conditioner.
    frame = int(0.046 * sr)
    hop = frame
    pitches: list[float] = []
    for start in range(0, max(0, len(melody) - frame), hop):
        window = melody[start : start + frame]
        pitches.append(_autocorr_pitch(window, sr))

    if not pitches:
        pitches = [220.0]

    out = np.zeros(samples, dtype=np.float32)
    per_frame = max(1, samples // len(pitches))

    phase = 0.0
    for index, hz in enumerate(pitches):
        begin = index * per_frame
        end = min(samples, begin + per_frame)
        if begin >= samples:
            break
        length = end - begin
        if length <= 0 or hz <= 0:
            continue

        t = np.arange(length, dtype=np.float32) / out_sr
        tone = np.zeros(length, dtype=np.float32)
        for order, amplitude in enumerate(voice["harmonics"], start=1):
            detune = 1.0 + voice["detune"] * (rng.random() - 0.5)
            tone += amplitude * np.sin(
                2 * np.pi * hz * order * detune * t + phase * order
            )
        tone /= max(1.0, sum(voice["harmonics"]))
        phase = (phase + 2 * np.pi * hz * length / out_sr) % (2 * np.pi)

        envelope = np.exp(-t / max(0.05, voice["decay"]))
        out[begin:end] += 0.55 * tone * envelope

        # Bass an octave and a half down, longer envelope.
        bass = np.sin(2 * np.pi * (hz / 3.0) * t)
        out[begin:end] += 0.3 * bass * np.exp(-t / (voice["decay"] * 2.0))

    out += _stub_percussion(samples, out_sr, bpm=112.0, level=voice["beat"], rng=rng)
    return normalize_peak(out, 0.8)


def _autocorr_pitch(window: np.ndarray, sr: int, fmin: float = 65.0, fmax: float = 1000.0) -> float:
    if window.size < 64 or float(np.max(np.abs(window))) < 1e-3:
        return 0.0
    window = window - float(np.mean(window))
    correlation = np.correlate(window, window, mode="full")[window.size - 1 :]
    min_lag = int(sr / fmax)
    max_lag = min(int(sr / fmin), correlation.size - 1)
    if max_lag <= min_lag:
        return 0.0
    segment = correlation[min_lag:max_lag]
    lag = int(np.argmax(segment)) + min_lag
    if correlation[0] <= 0 or correlation[lag] / correlation[0] < 0.3:
        return 0.0
    return float(sr) / lag


def _stub_percussion(
    samples: int, sr: int, bpm: float, level: float, rng: np.random.Generator
) -> np.ndarray:
    out = np.zeros(samples, dtype=np.float32)
    if level <= 0:
        return out
    step = int(sr * 60.0 / bpm / 2.0)  # eighth notes
    click_length = int(sr * 0.05)
    decay = np.exp(-np.linspace(0, 12, click_length, dtype=np.float32))
    for index, start in enumerate(range(0, samples, max(1, step))):
        end = min(samples, start + click_length)
        if end <= start:
            break
        # Downbeats get a low thud, offbeats a quiet noise tick.
        if index % 4 == 0:
            t = np.arange(end - start, dtype=np.float32) / sr
            hit = np.sin(2 * np.pi * 58.0 * t) * decay[: end - start]
            out[start:end] += level * hit
        elif index % 2 == 0:
            noise = rng.normal(0, 1, end - start).astype(np.float32)
            out[start:end] += level * 0.25 * noise * decay[: end - start]
    return out


__all__ = ["render_track", "stable_seed"]
