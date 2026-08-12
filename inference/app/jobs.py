"""In-process job queue for /generate.

Single worker thread on purpose: there is one GPU, and running two generations
concurrently would OOM rather than finish sooner. Jobs live in memory only,
which is fine for the LAN/demo scope in section 8 of the spec - the App Server
treats a lost job as a cache miss and asks again.
"""

from __future__ import annotations

import queue
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class Job:
    id: str
    kind: str
    run: Callable[["Job"], dict]
    status: str = "queued"
    progress: float = 0.0
    result: dict = field(default_factory=dict)
    error: Optional[str] = None
    meta: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    def set_progress(self, value: float) -> None:
        self.progress = max(0.0, min(1.0, float(value)))


class JobQueue:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._loop, name="job-worker", daemon=True)
        self._worker.start()

    def submit(self, kind: str, run: Callable[[Job], dict], meta: Optional[dict] = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:16], kind=kind, run=run, meta=meta or {})
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._evict_old()
        self._queue.put(job.id)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def queue_position(self, job_id: str) -> Optional[int]:
        """0 = next up. None once the job is no longer waiting."""
        with self._lock:
            waiting = [
                jid
                for jid in self._order
                if jid in self._jobs and self._jobs[jid].status == "queued"
            ]
        return waiting.index(job_id) if job_id in waiting else None

    def _evict_old(self, keep: int = 200) -> None:
        while len(self._order) > keep:
            stale = self._order.pop(0)
            self._jobs.pop(stale, None)

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            job = self.get(job_id)
            if job is None:
                continue
            job.status = "running"
            job.started_at = time.time()
            try:
                job.result = job.run(job)
                job.status = "done"
                job.progress = 1.0
            except Exception as exc:
                job.status = "error"
                job.error = f"{type(exc).__name__}: {exc}"
                traceback.print_exc()
            finally:
                job.finished_at = time.time()


_singleton: Optional[JobQueue] = None


def jobs() -> JobQueue:
    global _singleton
    if _singleton is None:
        _singleton = JobQueue()
    return _singleton


def as_dict(job: Job, extra: Optional[dict[str, Any]] = None) -> dict:
    payload = {
        "job_id": job.id,
        "status": job.status,
        "progress": round(job.progress, 3),
        "error": job.error,
        **job.meta,
        **job.result,
    }
    if extra:
        payload.update(extra)
    return payload
