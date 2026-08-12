import { getCachedLyrics, putCachedLyrics } from "./db";
import * as inference from "./inference";
import type { SongRecord } from "./library";
import type { LyricLine } from "./types";

/**
 * Where a song's lyrics come from, in priority order:
 *
 *   1. A sidecar file next to the audio. Bundled timings beat transcription
 *      every time, so nothing is allowed to override these.
 *   2. A previously cached transcription.
 *   3. A fresh transcription from Whisper.
 *
 * Placeholder lines from the inference server's stub mode are deliberately not
 * cached. Otherwise the first visit while developing against the stub would
 * pin "la la la" into the cache permanently, and turning real transcription on
 * later would appear to do nothing.
 */

interface CachedLyrics {
  lyrics: LyricLine[];
  stub: boolean;
}

export async function resolveLyrics(song: SongRecord): Promise<LyricLine[]> {
  if (song.lyrics.length > 0) return song.lyrics;

  const cached = getCachedLyrics<CachedLyrics | LyricLine[]>(song.id);
  if (cached) {
    // Entries written before this shape existed were bare arrays, and some of
    // them are stub output. Treat them as absent so they get replaced once.
    if (!Array.isArray(cached) && !cached.stub) return cached.lyrics;
  }

  try {
    const result = await inference.transcribe(song.absolutePath);
    if (!result.stub) {
      putCachedLyrics(song.id, { lyrics: result.lyrics, stub: false });
    }
    return result.lyrics;
  } catch {
    // A missing transcription is not fatal. The performance screen has a
    // reasonable empty state for it.
    return [];
  }
}
