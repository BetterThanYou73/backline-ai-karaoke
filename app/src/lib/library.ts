import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { AUDIO_EXTENSIONS, CACHE_DIR, IMPORTS_DIR, SONGS_DIR, SONGS_INDEX } from "./config";
import { pruneOrphanedTracks } from "./db";
import * as inference from "./inference";
import { readTags } from "./metadata";
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
  /** Size and mtime. A change here means re-analyse, but keep the id. */
  fingerprint: string;
  /** Downsampled reference f0 track, [seconds, midi | null][]. */
  melodyContour: [number, number | null][];
  analyzed: boolean;
  analysisError?: string;
}

type Index = Record<string, SongRecord>;

let indexCache: Index | null = null;
let indexCacheMtime = 0;
let analysing = false;

/**
 * Read the song index, reloading whenever songs.json has changed on disk.
 *
 * The mtime check is not an optimisation, it is the whole point. Next runs
 * route handlers and server components as separate module instances, so this
 * module exists more than once in one process, each copy with its own cache.
 * An earlier version cached the parsed index forever: the API route's scan
 * updated its own copy and the file, while the page's copy kept serving the
 * snapshot it read at startup, and every song added afterwards 404ed on the
 * style and perform pages while listing correctly in the library.
 *
 * Disk is the shared source of truth between those instances, so the cache has
 * to be validated against it rather than trusted.
 */
function readIndex(): Index {
  let mtime = 0;
  try {
    mtime = fs.statSync(SONGS_INDEX).mtimeMs;
  } catch {
    // No index yet. An empty result is correct, and it must not be cached as
    // though it were authoritative.
    indexCache = null;
    indexCacheMtime = 0;
    return {};
  }

  if (indexCache && mtime === indexCacheMtime) return indexCache;

  try {
    indexCache = JSON.parse(fs.readFileSync(SONGS_INDEX, "utf8")) as Index;
    indexCacheMtime = mtime;
  } catch {
    // Corrupt or mid-write. Serve what we last had rather than pretending the
    // library is empty, and retry on the next call.
    return indexCache ?? {};
  }

  return indexCache;
}

function writeIndex(index: Index): void {
  fs.mkdirSync(path.dirname(SONGS_INDEX), { recursive: true });
  // Write then rename: a crash mid-write must not leave a truncated index.
  const temporary = `${SONGS_INDEX}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(temporary, SONGS_INDEX);

  indexCache = index;
  try {
    indexCacheMtime = fs.statSync(SONGS_INDEX).mtimeMs;
  } catch {
    indexCacheMtime = 0;
  }
}

/**
 * Song id, derived from the file name alone.
 *
 * Size and mtime used to be in here, which meant re-copying a file, editing
 * its tags, or a backup tool touching it all produced a different id. Every
 * link to the old id died, and the expensive thing keyed by it, the generated
 * tracks, was orphaned. The name is the stable part of a song's identity from
 * a user's point of view, so that is what the id follows.
 */
function songId(file: string): string {
  return crypto
    .createHash("sha1")
    .update(path.basename(file).toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

/**
 * Changes when the bytes might have changed, which is the signal to re-analyse.
 * Kept separate from identity so a re-analysis does not also invalidate every
 * rendered track for that song.
 */
function fingerprint(size: number, mtimeMs: number): string {
  return `${size}:${Math.round(mtimeMs)}`;
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

/**
 * List the audio in one directory.
 *
 * Returns null when the directory could not be read at all, which the caller
 * must treat differently from an empty directory. An earlier version returned
 * [] for both, and since the reconcile builds the new index purely from what
 * was discovered, a single transient EBUSY produced an empty index, which was
 * then committed and handed to the cache pruner, deleting every generated
 * track on disk. One failed readdir could destroy hours of GPU output.
 */
async function scanDirectory(
  directory: string,
  source: Song["source"],
): Promise<SongRecord[] | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A directory that simply does not exist yet is empty, not broken.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return null;
  }

  const found: SongRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) continue;

    const absolutePath = path.join(directory, entry.name);
    const stat = await fsp.stat(absolutePath);

    // A file still being copied in shows up as a partial. Picking it up here
    // would analyse a truncated stream and cache the wrong bpm, so skip it and
    // let the next scan take it.
    if (stat.size < 1024) continue;

    // Embedded tags first: a file that knows its own title and artist is
    // telling the truth, whereas "Artist - Title.mp3" is a convention people
    // follow only sometimes.
    const tags = await readTags(absolutePath);
    const guessed = titleFromFilename(entry.name);
    const title = tags.title || guessed.title;
    const artist = tags.artist || guessed.artist;

    found.push({
      // Scoped by source directory: without it, importing a file whose name
      // matches a built-in one silently replaced the built-in entry, and the
      // pruner then deleted the loser's renders.
      id: songId(`${source}/${entry.name}`),
      title,
      artist,
      source,
      file: entry.name,
      absolutePath,
      album: tags.album,
      fingerprint: fingerprint(stat.size, stat.mtimeMs),
      // Tags usually carry duration, which means the library can show a real
      // running time immediately rather than "--:--" until analysis lands.
      duration: tags.durationSeconds ? Number(tags.durationSeconds.toFixed(3)) : 0,
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
 * Serializes every read-modify-write of the index.
 *
 * A scan does slow async I/O between reading the index and writing it back,
 * and the analysis queue writes results into the same file throughout. Without
 * this, a completed analysis landing inside that window was overwritten by the
 * scan's stale snapshot, which reset `analyzed` to false, which made the
 * analysis queue pick the same song up again, forever. The library polls every
 * 2.5 seconds while anything is unanalysed, so the window came around
 * constantly.
 */
let indexWrites: Promise<unknown> = Promise.resolve();

function withIndexLock<T>(work: () => T | Promise<T>): Promise<T> {
  const result = indexWrites.then(work, work);
  indexWrites = result.catch(() => undefined);
  return result;
}

/**
 * Reconcile the folder with the index. New files get a placeholder record and
 * are queued for analysis; files that disappeared are dropped.
 */
export async function scanLibrary(): Promise<SongRecord[]> {
  const [songsDir, importsDir] = await Promise.all([
    scanDirectory(SONGS_DIR, "ncs"),
    scanDirectory(IMPORTS_DIR, "import"),
  ]);

  // If either directory could not be read, we do not actually know what the
  // library contains, and reconciling against a partial view would delete
  // whatever it failed to see. Serve what we have and try again next time.
  if (songsDir === null || importsDir === null) {
    return Object.values(readIndex()).sort((a, b) => a.title.localeCompare(b.title));
  }

  const discovered = [...songsDir, ...importsDir];

  const next = await withIndexLock(() => {
    // Read inside the lock, after the slow directory I/O, so analysis results
    // written while we were scanning are still here.
    const index = readIndex();
    const merged: Index = {};

    for (const song of discovered) {
      const existing = index[song.id];

      if (!existing) {
        merged[song.id] = song;
        continue;
      }

      // The bytes changed underneath us, so cached tempo, key and melody are
      // describing audio that is no longer there. Keep the id, drop the
      // analysis.
      if (existing.fingerprint !== song.fingerprint) {
        merged[song.id] = song;
        continue;
      }

      merged[song.id] = {
        ...existing,
        // Path can move between scans; the analysis is what we are keeping.
        absolutePath: song.absolutePath,
        file: song.file,
        source: song.source,
        lyrics: song.lyrics.length ? song.lyrics : existing.lyrics,
      };
    }

    writeIndex(merged);
    return merged;
  });

  void pruneCache(new Set(Object.keys(next)));
  void runAnalysisQueue();
  return Object.values(next).sort((a, b) => a.title.localeCompare(b.title));
}

/** Delete renders belonging to songs that are no longer in the library. */
async function pruneCache(validSongIds: Set<string>): Promise<void> {
  try {
    const orphaned = pruneOrphanedTracks(validSongIds);
    await Promise.all(
      orphaned.map((file) =>
        fsp.rm(path.join(CACHE_DIR, file), { force: true }).catch(() => undefined),
      ),
    );
  } catch {
    // Pruning is housekeeping. A failure here must never take out a scan.
  }
}

export async function listSongs(): Promise<SongRecord[]> {
  return scanLibrary();
}

export function getSong(id: string): SongRecord | null {
  return readIndex()[id] ?? null;
}

export function updateSong(
  id: string,
  patch: Partial<SongRecord>,
): Promise<SongRecord | null> {
  return withIndexLock(() => {
    const index = { ...readIndex() };
    const current = index[id];
    if (!current) return null;
    index[id] = { ...current, ...patch };
    writeIndex(index);
    return index[id];
  });
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
        await updateSong(pending.id, {
          bpm: result.bpm,
          key: result.key,
          duration: result.duration,
          melodyContour: result.melody_contour,
          analyzed: true,
          analysisError: undefined,
        });
      } catch (error) {
        // Record the failure so the loop does not spin on the same file.
        // Cleared by retryAnalysis, or by the file's bytes changing.
        await updateSong(pending.id, {
          analysisError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    analysing = false;
  }
}

/**
 * Clear a recorded analysis failure and try again.
 *
 * Without this a failed analysis was permanent: the error is persisted to
 * songs.json, so even a restart did not clear it, and the only way out was to
 * leave the browser and touch the file on disk. Analysis failing is not exotic
 * either, since pyin on a long track can outrun the request timeout.
 */
export async function retryAnalysis(id: string): Promise<SongRecord | null> {
  const updated = await updateSong(id, { analysisError: undefined });
  if (updated) void runAnalysisQueue();
  return updated;
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
