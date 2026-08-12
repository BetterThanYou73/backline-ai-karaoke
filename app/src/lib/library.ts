import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { AUDIO_EXTENSIONS, IMPORTS_DIR, SONGS_DIR, SONGS_INDEX } from "./config";
import * as inference from "./inference";
import type { LyricLine, Song } from "./types";

/**
 * The song library is a folder, not a database. Drop audio into data/songs and
 * it shows up. Metadata that costs real work to compute, bpm, key and melody
 * contour, is cached in data/songs.json keyed by content hash, so renaming a
 * file does not trigger a re-analysis and editing one does.
 */

export interface SongRecord extends Song {
  /** Absolute path on this machine, never sent to the browser. */
  absolutePath: string;
  /** Downsampled reference f0 track, [seconds, midi | null][]. */
  melodyContour: [number, number | null][];
  analyzed: boolean;
  analysisError?: string;
}

type Index = Record<string, SongRecord>;

let indexCache: Index | null = null;
let analysing = false;

function readIndex(): Index {
  if (indexCache) return indexCache;
  try {
    const raw = fs.readFileSync(SONGS_INDEX, "utf8");
    indexCache = JSON.parse(raw) as Index;
  } catch {
    indexCache = {};
  }
  return indexCache;
}

function writeIndex(index: Index): void {
  indexCache = index;
  fs.mkdirSync(path.dirname(SONGS_INDEX), { recursive: true });
  // Write then rename: a crash mid-write must not leave a truncated index.
  const temporary = `${SONGS_INDEX}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(temporary, SONGS_INDEX);
}

/** Stable id from file identity rather than name, so renames keep the cache. */
function songId(file: string, size: number, mtimeMs: number): string {
  const digest = crypto
    .createHash("sha1")
    .update(`${path.basename(file).toLowerCase()}:${size}:${Math.round(mtimeMs)}`)
    .digest("hex");
  return digest.slice(0, 12);
}

function titleFromFilename(file: string): { title: string; artist: string } {
  const base = path.basename(file, path.extname(file));
  // "Artist - Title" is how NCS names its downloads.
  const split = base.split(/\s+-\s+/);
  if (split.length >= 2) {
    return { artist: split[0].trim(), title: split.slice(1).join(" - ").trim() };
  }
  return { artist: "Unknown artist", title: base.replace(/[_-]+/g, " ").trim() };
}

async function readSidecarLyrics(audioPath: string): Promise<LyricLine[] | null> {
  const sidecar = `${audioPath.replace(/\.[^.]+$/, "")}.lyrics.json`;
  try {
    const raw = await fsp.readFile(sidecar, "utf8");
    const parsed = JSON.parse(raw);
    const lines: unknown = Array.isArray(parsed) ? parsed : parsed?.lyrics;
    if (!Array.isArray(lines)) return null;
    return lines
      .filter(
        (line): line is LyricLine =>
          typeof line?.text === "string" &&
          typeof line?.start === "number" &&
          typeof line?.end === "number",
      )
      .sort((a, b) => a.start - b.start);
  } catch {
    return null;
  }
}

async function scanDirectory(
  directory: string,
  source: Song["source"],
): Promise<SongRecord[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: SongRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) continue;

    const absolutePath = path.join(directory, entry.name);
    const stat = await fsp.stat(absolutePath);
    const id = songId(entry.name, stat.size, stat.mtimeMs);
    const { title, artist } = titleFromFilename(entry.name);

    found.push({
      id,
      title,
      artist,
      source,
      file: entry.name,
      absolutePath,
      duration: 0,
      bpm: null,
      key: null,
      lyrics: (await readSidecarLyrics(absolutePath)) ?? [],
      melodyContour: [],
      analyzed: false,
      createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    });
  }
  return found;
}

/**
 * Reconcile the folder with the index. New files get a placeholder record and
 * are queued for analysis; files that disappeared are dropped.
 */
export async function scanLibrary(): Promise<SongRecord[]> {
  const index = readIndex();
  const discovered = [
    ...(await scanDirectory(SONGS_DIR, "ncs")),
    ...(await scanDirectory(IMPORTS_DIR, "import")),
  ];

  const next: Index = {};
  for (const song of discovered) {
    const existing = index[song.id];
    next[song.id] = existing
      ? {
          ...existing,
          // Path and name can move; analysis results are what we are keeping.
          absolutePath: song.absolutePath,
          file: song.file,
          title: existing.title || song.title,
          artist: existing.artist || song.artist,
          source: song.source,
          lyrics: song.lyrics.length ? song.lyrics : existing.lyrics,
        }
      : song;
  }

  writeIndex(next);
  void runAnalysisQueue();
  return Object.values(next).sort((a, b) => a.title.localeCompare(b.title));
}

export async function listSongs(): Promise<SongRecord[]> {
  return scanLibrary();
}

export function getSong(id: string): SongRecord | null {
  return readIndex()[id] ?? null;
}

export function updateSong(id: string, patch: Partial<SongRecord>): SongRecord | null {
  const index = { ...readIndex() };
  const current = index[id];
  if (!current) return null;
  index[id] = { ...current, ...patch };
  writeIndex(index);
  return index[id];
}

/**
 * Analyse unanalysed songs one at a time in the background.
 *
 * Serial on purpose: the inference server runs analysis on the same box as
 * generation, and pyin on a full track is not cheap. The library stays usable
 * while this runs, songs just show bpm and key a little later.
 */
export async function runAnalysisQueue(): Promise<void> {
  if (analysing) return;
  analysing = true;

  try {
    for (;;) {
      const pending = Object.values(readIndex()).find(
        (song) => !song.analyzed && !song.analysisError,
      );
      if (!pending) return;

      try {
        const result = await inference.analyze(pending.absolutePath);
        updateSong(pending.id, {
          bpm: result.bpm,
          key: result.key,
          duration: result.duration,
          melodyContour: result.melody_contour,
          analyzed: true,
          analysisError: undefined,
        });
      } catch (error) {
        // Record the failure so the loop does not spin on the same file. A
        // restart, or re-adding the file, clears it.
        updateSong(pending.id, {
          analysisError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    analysing = false;
  }
}

export type PublicSong = Song & {
  analyzed: boolean;
  analysisError?: string;
  /** Route the browser uses to stream the original audio. */
  audioUrl: string;
};

/** Strip the server-only fields before anything reaches the browser. */
export function toPublicSong(song: SongRecord): PublicSong {
  const { absolutePath: _absolutePath, melodyContour: _melodyContour, ...rest } = song;
  return {
    ...rest,
    audioUrl: `/api/media/${song.source === "import" ? "import" : "song"}/${encodeURIComponent(
      song.file,
    )}`,
  };
}
