"""Environment-backed configuration for the Inference API server."""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")


def _flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(float(os.getenv(name, "") or default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


STUB_MODE = _flag("STUB_MODE", "1")

DEVICE = os.getenv("DEVICE", "cuda")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = _int("PORT", 8001)

MUSICGEN_MODEL = os.getenv("MUSICGEN_MODEL", "facebook/musicgen-melody")
MODEL_PATH = os.getenv("MODEL_PATH") or None
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")

OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR") or (BASE_DIR / "output"))
if not OUTPUT_DIR.is_absolute():
    OUTPUT_DIR = (BASE_DIR / OUTPUT_DIR).resolve()

UPLOAD_DIR = OUTPUT_DIR / "uploads"

CHUNK_SECONDS = _float("CHUNK_SECONDS", 30.0)
CROSSFADE_SECONDS = _float("CROSSFADE_SECONDS", 1.0)
MAX_RENDER_SECONDS = _float("MAX_RENDER_SECONDS", 90.0)
IDLE_UNLOAD_SECONDS = _float("IDLE_UNLOAD_SECONDS", 300.0)

# Sample rate MusicGen emits. Everything downstream is resampled to match.
GENERATION_SR = 32000


def ensure_dirs() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
