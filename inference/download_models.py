"""Pre-download the model weights.

Worth doing before a demo rather than during one. MusicGen-melody is about 6 GB
and the first request that needs it would otherwise sit in "tuning your
stage..." for however long the download takes.

    .venv\\Scripts\\python.exe download_models.py
    .venv\\Scripts\\python.exe download_models.py --whisper-only

Downloads resume, so an interrupted run costs nothing but the time already
spent. Run it again and it picks up where it stopped.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import config  # noqa: E402


def _apply_local_ca() -> None:
    """Point TLS at a local inspection CA if one is present.

    Norton and similar re-sign HTTPS with a root the Python TLS stack does not
    trust, which shows up as a certificate verification failure against
    huggingface.co rather than anything that names the antivirus.
    """
    cert = Path(r"C:\ProgramData\Norton\Antivirus\wscert.pem")
    if cert.is_file():
        for variable in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "CURL_CA_BUNDLE"):
            os.environ.setdefault(variable, str(cert))
        print(f"using local TLS certificate: {cert}")


def human(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def cache_size(repo: str) -> int:
    from huggingface_hub.constants import HF_HUB_CACHE

    folder = Path(HF_HUB_CACHE) / f"models--{repo.replace('/', '--')}"
    if not folder.exists():
        return 0
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file())


def download_musicgen() -> None:
    from transformers import AutoProcessor, MusicgenMelodyForConditionalGeneration

    name = config.MODEL_PATH or config.MUSICGEN_MODEL
    print(f"\nMusicGen: {name}")
    print(f"  already cached: {human(cache_size(name))}")
    print("  downloading, this is roughly 6 GB and can take a while...")

    started = time.time()
    AutoProcessor.from_pretrained(name)
    MusicgenMelodyForConditionalGeneration.from_pretrained(name)
    print(f"  done in {time.time() - started:.0f}s, {human(cache_size(name))} on disk")


def download_whisper() -> None:
    from faster_whisper import WhisperModel

    print(f"\nWhisper: {config.WHISPER_MODEL}")
    started = time.time()
    # Instantiating on CPU pulls the weights without touching the GPU, which
    # matters if the music model is resident while this runs.
    WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
    print(f"  done in {time.time() - started:.0f}s")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--whisper-only", action="store_true")
    parser.add_argument("--musicgen-only", action="store_true")
    args = parser.parse_args()

    _apply_local_ca()
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "0")

    try:
        if not args.whisper_only:
            download_musicgen()
        if not args.musicgen_only:
            download_whisper()
    except KeyboardInterrupt:
        print("\ninterrupted. Downloads resume, so run this again to continue.")
        return 130
    except Exception as exc:
        print(f"\nfailed: {type(exc).__name__}: {exc}")
        return 1

    print("\nAll set. Set STUB_MODE=0 in .env and start the server.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
