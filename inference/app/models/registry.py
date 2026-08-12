"""Single-resident model registry.

The spec assumed a 12GB desktop 4070. This box is an 8GB laptop 4070, where
MusicGen-melody at fp16 (~6GB) and Whisper cannot both stay resident. So the
registry holds at most one model: acquiring a different kind evicts the current
one first, and an idle sweeper frees VRAM after IDLE_UNLOAD_SECONDS.

All GPU work is serialized behind `gpu_lock`. There is one GPU; concurrent
generate + transcribe would OOM rather than go faster.
"""

from __future__ import annotations

import gc
import threading
import time
from typing import Any, Callable, Optional

from .. import config

gpu_lock = threading.RLock()

_loaded_kind: Optional[str] = None
_loaded_obj: Any = None
_last_used: float = 0.0


def _torch():
    import torch

    return torch


def cuda_available() -> bool:
    if config.STUB_MODE:
        return False
    try:
        return bool(_torch().cuda.is_available())
    except Exception:
        return False


def vram_mb() -> tuple[Optional[int], Optional[int]]:
    """(total, free) in MB, or (None, None) when CUDA is unavailable."""
    if not cuda_available():
        return None, None
    try:
        free, total = _torch().cuda.mem_get_info()
        return int(total / 1024**2), int(free / 1024**2)
    except Exception:
        return None, None


def loaded_kind() -> Optional[str]:
    return _loaded_kind


def acquire(kind: str, loader: Callable[[], Any]) -> Any:
    """Return the model for `kind`, loading it (and evicting any other) first.

    Callers must hold `gpu_lock` for as long as they use the returned object;
    otherwise the idle sweeper may free it mid-inference.
    """
    global _loaded_kind, _loaded_obj, _last_used

    with gpu_lock:
        if _loaded_kind == kind and _loaded_obj is not None:
            _last_used = time.monotonic()
            return _loaded_obj

        if _loaded_kind is not None:
            unload()

        _loaded_obj = loader()
        _loaded_kind = kind
        _last_used = time.monotonic()
        return _loaded_obj


def touch() -> None:
    global _last_used
    _last_used = time.monotonic()


def unload() -> None:
    global _loaded_kind, _loaded_obj

    with gpu_lock:
        if _loaded_obj is None:
            _loaded_kind = None
            return
        _loaded_obj = None
        _loaded_kind = None
        gc.collect()
        try:
            if not config.STUB_MODE:
                _torch().cuda.empty_cache()
        except Exception:
            pass


def start_idle_sweeper() -> threading.Thread:
    """Free VRAM once the resident model has gone unused long enough."""

    def sweep() -> None:
        while True:
            time.sleep(15.0)
            if config.IDLE_UNLOAD_SECONDS <= 0:
                continue
            # Never block a running job just to check the clock.
            if not gpu_lock.acquire(blocking=False):
                continue
            try:
                if _loaded_obj is not None and (
                    time.monotonic() - _last_used > config.IDLE_UNLOAD_SECONDS
                ):
                    unload()
            finally:
                gpu_lock.release()

    thread = threading.Thread(target=sweep, name="idle-sweeper", daemon=True)
    thread.start()
    return thread
