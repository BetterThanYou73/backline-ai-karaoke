import { INFERENCE_API_URL } from "./config";
import type { LyricLine, StyleId } from "./types";

/**
 * Thin client for the Inference API. Every call is server side; the browser
 * never talks to the GPU box directly, which keeps that server LAN-only.
 */

export interface AnalyzeResult {
  bpm: number;
  key: string;
  melody_contour: [number, number | null][];
  duration: number;
}

export interface JobStatus {
  job_id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  result_url?: string | null;
  song_id?: string | null;
  style?: string | null;
  duration?: number | null;
  error?: string | null;
  queue_position?: number | null;
}

export interface InferenceHealth {
  ok: boolean;
  stub_mode: boolean;
  device: string;
  cuda_available: boolean;
  vram_total_mb: number | null;
  vram_free_mb: number | null;
  loaded_model: string | null;
  styles: string[];
}

class InferenceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

async function call<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 180_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${INFERENCE_API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new InferenceError(
        `inference ${path} returned ${response.status}: ${body.slice(0, 300)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof InferenceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new InferenceError(`inference ${path} timed out after ${timeoutMs}ms`);
    }
    throw new InferenceError(
      `cannot reach inference server at ${INFERENCE_API_URL}. Is it running? (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function health(): Promise<InferenceHealth> {
  return call<InferenceHealth>("/health", { method: "GET" }, 5_000);
}

/**
 * Analysis walks the whole file through pyin, which is slow on a long track.
 * Callers that only need bpm and key should still use this; it runs once per
 * song at import time.
 */
export function analyze(audioPath: string): Promise<AnalyzeResult> {
  return call<AnalyzeResult>("/analyze", {
    method: "POST",
    body: JSON.stringify({ audio_path: audioPath }),
  });
}

export function generate(input: {
  audioPath: string;
  style: StyleId;
  songId: string;
}): Promise<{ job_id: string }> {
  return call<{ job_id: string }>(
    "/generate",
    {
      method: "POST",
      body: JSON.stringify({
        audio_path: input.audioPath,
        style: input.style,
        song_id: input.songId,
      }),
    },
    30_000,
  );
}

export function status(jobId: string): Promise<JobStatus> {
  return call<JobStatus>(`/status/${encodeURIComponent(jobId)}`, { method: "GET" }, 15_000);
}

export function transcribe(audioPath: string): Promise<{
  lyrics: LyricLine[];
  language: string | null;
}> {
  return call("/transcribe", {
    method: "POST",
    body: JSON.stringify({ audio_path: audioPath }),
  });
}

/** Pull a finished render off the inference server so it can be cached locally. */
export async function download(resultUrl: string): Promise<Buffer> {
  const response = await fetch(resultUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new InferenceError(
      `could not fetch rendered track: ${response.status}`,
      response.status,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

export { InferenceError };
