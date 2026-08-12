"""Backline Inference API Server.

Headless, GPU-bound, LAN-only. Owns every ML model; knows nothing about
sessions, users, or the cache index - that is the App Server's job.

Endpoints follow section 5 of the build spec:
    POST /analyze          -> {bpm, key, melody_contour, duration}
    POST /generate         -> {job_id}                (async)
    GET  /status/{job_id}  -> {status, result_url?}
    POST /transcribe       -> {lyrics: [{text,start,end}]}
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import config
from .audio_utils import output_path, resolve_source, unique_stem, write_wav
from .jobs import Job, as_dict, jobs
from .models import analyze, melody, registry, transcribe
from .schemas import (
    AnalyzeResponse,
    AudioSource,
    GenerateRequest,
    GenerateResponse,
    HealthResponse,
    StatusResponse,
    TranscribeResponse,
)
from .styles import STYLE_IDS, STYLES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backline.inference")


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    registry.start_idle_sweeper()
    log.info(
        "inference server up | stub_mode=%s device=%s cuda=%s",
        config.STUB_MODE,
        config.DEVICE,
        registry.cuda_available(),
    )
    if config.STUB_MODE:
        log.warning(
            "STUB_MODE=1: /generate returns synthesized placeholder audio and "
            "/transcribe returns placeholder lyrics. Set STUB_MODE=0 once "
            "audiocraft and faster-whisper are installed."
        )
    yield
    registry.unload()


api = FastAPI(title="Backline Inference API", version="1.0.0", lifespan=lifespan)

# LAN-only per the spec, so a permissive CORS policy is acceptable here. This
# server must not be exposed to the internet as configured.
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@api.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    total, free = registry.vram_mb()
    return HealthResponse(
        ok=True,
        stub_mode=config.STUB_MODE,
        device=config.DEVICE,
        cuda_available=registry.cuda_available(),
        vram_total_mb=total,
        vram_free_mb=free,
        loaded_model=registry.loaded_kind(),
        styles=list(STYLE_IDS),
    )


@api.get("/styles")
def styles() -> dict:
    return {
        "styles": [
            {"id": s.id, "label": s.label, "genre": s.genre} for s in STYLES.values()
        ]
    }


@api.post("/analyze", response_model=AnalyzeResponse)
def post_analyze(body: AudioSource) -> AnalyzeResponse:
    path = _resolve(body)
    try:
        return AnalyzeResponse(**analyze.analyze_file(path))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"analysis failed: {exc}") from exc


@api.post("/generate", response_model=GenerateResponse)
def post_generate(body: GenerateRequest, request: Request) -> GenerateResponse:
    source = _resolve(body)
    song_id = body.song_id or source.stem
    base = request.base_url

    def run(job: Job) -> dict:
        audio, sr = melody.render_track(
            source_path=source,
            style_id=body.style,
            song_id=song_id,
            max_seconds=body.max_render_seconds,
            seed=body.seed,
            progress=job.set_progress,
        )
        stem = unique_stem(f"{song_id}-{body.style}")
        written = write_wav(audio, sr, output_path(stem))
        return {
            "result_url": str(base).rstrip("/") + f"/files/{written.name}",
            "duration": round(len(audio) / sr, 3),
        }

    job = jobs().submit(
        "generate",
        run,
        meta={"song_id": song_id, "style": body.style},
    )
    log.info("queued generate job %s for %s/%s", job.id, song_id, body.style)
    return GenerateResponse(job_id=job.id)


@api.get("/status/{job_id}", response_model=StatusResponse)
def get_status(job_id: str) -> StatusResponse:
    job = jobs().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    return StatusResponse(
        **as_dict(job, {"queue_position": jobs().queue_position(job_id)})
    )


@api.post("/transcribe", response_model=TranscribeResponse)
def post_transcribe(body: AudioSource) -> TranscribeResponse:
    path = _resolve(body)
    try:
        return TranscribeResponse(**transcribe.transcribe_file(path))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc


@api.get("/files/{name}")
def get_file(name: str) -> FileResponse:
    """Serve a rendered track back to the App Server, which caches it."""
    # Reject traversal: only plain names directly inside OUTPUT_DIR.
    if Path(name).name != name:
        raise HTTPException(status_code=400, detail="invalid file name")
    path = config.OUTPUT_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="audio/wav", filename=name)


def _resolve(body: AudioSource) -> Path:
    try:
        return resolve_source(body.audio_url, body.audio_base64, body.audio_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad audio source: {exc}") from exc


def main() -> None:
    import uvicorn

    uvicorn.run(api, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    main()
