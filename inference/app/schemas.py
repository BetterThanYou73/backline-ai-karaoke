"""Request/response models. Mirrors section 5 of the build spec."""

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class AudioSource(BaseModel):
    """Every endpoint accepts the same three ways of naming audio."""

    audio_url: Optional[str] = None
    audio_base64: Optional[str] = None
    audio_path: Optional[str] = None  # server-local path, convenient on one box

    @model_validator(mode="after")
    def _one_of(self):
        if not (self.audio_url or self.audio_base64 or self.audio_path):
            raise ValueError("one of audio_url, audio_base64, audio_path is required")
        return self


class AnalyzeResponse(BaseModel):
    bpm: float
    key: str
    # [[seconds, midi_note_or_null], ...] downsampled to ~10Hz for transport.
    melody_contour: list[list[Optional[float]]]
    duration: float


class GenerateRequest(AudioSource):
    style: str
    # Echoed back on the job so the App Server can key its cache without
    # tracking the job id across a restart.
    song_id: Optional[str] = None
    # Overrides config defaults; the App Server leaves these unset normally.
    max_render_seconds: Optional[float] = Field(default=None, ge=5, le=600)
    seed: Optional[int] = None

    @model_validator(mode="after")
    def _known_style(self):
        from .styles import STYLES

        if self.style not in STYLES:
            raise ValueError(f"unknown style {self.style!r}; expected one of {list(STYLES)}")
        return self


class GenerateResponse(BaseModel):
    job_id: str


JobStatus = Literal["queued", "running", "done", "error"]


class StatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    progress: float = 0.0
    result_url: Optional[str] = None
    song_id: Optional[str] = None
    style: Optional[str] = None
    bpm: Optional[float] = None
    key: Optional[str] = None
    duration: Optional[float] = None
    error: Optional[str] = None
    queue_position: Optional[int] = None


class LyricLine(BaseModel):
    text: str
    start: float
    end: float


class TranscribeResponse(BaseModel):
    lyrics: list[LyricLine]
    language: Optional[str] = None
    # True when these are placeholder lines from STUB_MODE rather than a real
    # transcription. The App Server refuses to cache those, so turning stub
    # mode off does not leave placeholder lyrics stuck in the cache forever.
    stub: bool = False


class HealthResponse(BaseModel):
    ok: bool
    stub_mode: bool
    device: str
    cuda_available: bool
    vram_total_mb: Optional[int] = None
    vram_free_mb: Optional[int] = None
    loaded_model: Optional[str] = None
    styles: list[str]
