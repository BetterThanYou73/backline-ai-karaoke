import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CACHE_DIR } from "./config";
import { findTrack, saveTrack } from "./db";
import * as inference from "./inference";
import { getSong } from "./library";
import type { StyleId, TrackJob } from "./types";

/**
 * Cache-or-generate for one song and style combination.
 *
 * The in-flight map is what stops a double click, or two tabs, from queueing
 * the same expensive render twice. It lives in memory only, which is fine: a
 * lost entry degrades to one duplicate render, never to a corrupt cache.
 */

const inFlight = new Map<string, string>();

function comboKey(songId: string, style: StyleId): string {
  return `${songId}::${style}`;
}

function cacheFileName(songId: string, style: StyleId): string {
  return `${songId}-${style}.wav`;
}

export async function requestTrack(
  songId: string,
  style: StyleId,
): Promise<TrackJob> {
  const song = getSong(songId);
  if (!song) return { state: "error", error: `unknown song ${songId}` };

  const cached = findTrack(songId, style);
  if (cached && fs.existsSync(path.join(CACHE_DIR, cacheFileName(songId, style)))) {
    return { state: "cached", track: cached };
  }

  const key = comboKey(songId, style);
  const existingJob = inFlight.get(key);
  if (existingJob) {
    return { state: "pending", jobId: existingJob, progress: 0 };
  }

  try {
    const { job_id } = await inference.generate({
      audioPath: song.absolutePath,
      style,
      songId,
    });
    inFlight.set(key, job_id);
    return { state: "pending", jobId: job_id, progress: 0, etaSeconds: await estimateEta() };
  } catch (error) {
    return {
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function pollTrack(
  jobId: string,
  songId: string,
  style: StyleId,
): Promise<TrackJob> {
  const key = comboKey(songId, style);

  let job: inference.JobStatus;
  try {
    job = await inference.status(jobId);
  } catch (error) {
    inFlight.delete(key);
    return {
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (job.status === "error") {
    inFlight.delete(key);
    return { state: "error", error: job.error ?? "generation failed" };
  }

  if (job.status !== "done") {
    return {
      state: "pending",
      jobId,
      progress: job.progress ?? 0,
      queuePosition: job.queue_position ?? null,
    };
  }

  if (!job.result_url) {
    inFlight.delete(key);
    return { state: "error", error: "job finished without a result url" };
  }

  try {
    const track = await ingest(job.result_url, songId, style, job.duration ?? 0);
    inFlight.delete(key);
    return { state: "cached", track };
  } catch (error) {
    inFlight.delete(key);
    return {
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Copy a finished render into the local cache and index it. */
async function ingest(
  resultUrl: string,
  songId: string,
  style: StyleId,
  duration: number,
) {
  const bytes = await inference.download(resultUrl);
  await fsp.mkdir(CACHE_DIR, { recursive: true });

  const fileName = cacheFileName(songId, style);
  const destination = path.join(CACHE_DIR, fileName);

  // Same write-then-rename discipline as the song index: a half-written wav in
  // the cache would look like a valid cache hit forever.
  const temporary = `${destination}.part`;
  await fsp.writeFile(temporary, bytes);
  await fsp.rename(temporary, destination);

  const song = getSong(songId);
  return saveTrack({
    songId,
    style,
    file: fileName,
    bpm: song?.bpm ?? null,
    key: song?.key ?? null,
    duration: duration || song?.duration || 0,
  });
}

/** Rough wall clock for the loading screen. Stub renders are near instant. */
async function estimateEta(): Promise<number> {
  try {
    const status = await inference.health();
    if (status.stub_mode) return 3;
    return status.cuda_available ? 60 : 600;
  } catch {
    return 60;
  }
}
