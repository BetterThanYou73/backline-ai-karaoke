import { getCachedLyrics, putCachedLyrics } from "./db";
import * as inference from "./inference";
import { updateSong, type SongRecord } from "./library";
import { lookupLyrics } from "./metadata";
import { getSettings } from "./settings";
import type { LyricLine } from "./types";

/**
 * Where a song's lyrics come from, in priority order:
 *
 *   1. A sidecar file next to the audio. Someone typed those on purpose, so
 *      nothing is allowed to override them.
 *   2. A previously cached result.
 *   3. LRCLIB, if online lookup is enabled. Real words on a real timing grid.
 *   4. Whisper, for anything no database knows.
 *
 * Whisper is last on merit, not as a fallback of convenience: it mishears sung
 * words and smears timings across held vowels, so for any song that exists in
 * a lyrics database, looking it up is strictly better than transcribing it.
 *
 * Placeholder lines from the inference server's stub mode are never cached.
 */

interface CachedLyrics {
  lyrics: LyricLine[];
  stub: boolean;
  source?: SongRecord["lyricsSource"];
  match?: string;
}

export interface ResolvedLyrics {
  lyrics: LyricLine[];
  source: NonNullable<SongRecord["lyricsSource"]>;
  match?: string;
}

export async function resolveLyrics(song: SongRecord): Promise<ResolvedLyrics> {
  if (song.lyrics.length > 0) {
    return { lyrics: song.lyrics, source: "sidecar" };
  }

  const raw = getCachedLyrics<CachedLyrics | LyricLine[]>(song.id);
  // Entries written before this shape existed were bare arrays, some of them
  // stub output. Treat those as absent so they get replaced once.
  const cached = raw && !Array.isArray(raw) && !raw.stub ? raw : null;

  // A cached database result is final: nothing downstream can improve on it.
  if (cached && cached.source === "lrclib") {
    return { lyrics: cached.lyrics, source: "lrclib", match: cached.match };
  }

  const settings = getSettings();

  // Deliberately checked before the Whisper cache. A transcription that ran
  // while lookup was switched off, including one that produced nothing at all,
  // must not permanently block the better source that is now available.
  // Consulting the cache first made enabling the setting appear to do nothing.

  if (settings.onlineLookup && song.title) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      const found = await lookupLyrics(
        song.title,
        song.artist === "Unknown artist" ? "" : song.artist,
        song.duration || null,
        controller.signal,
      );
      clearTimeout(timeout);

      if (found) {
        const match = `${found.matchedArtist} - ${found.matchedTitle}`;
        putCachedLyrics(song.id, {
          lyrics: found.lyrics,
          stub: false,
          source: "lrclib",
          match,
        });
        void updateSong(song.id, { lyricsSource: "lrclib", lyricsMatch: match });
        return { lyrics: found.lyrics, source: "lrclib", match };
      }
    } catch {
      // Offline, blocked, or simply not found. Fall through to Whisper.
    }
  }

  // Only now is a cached transcription the best thing available. Reusing it
  // matters: Whisper runs on the GPU and evicts the music model to do so.
  if (cached) {
    return {
      lyrics: cached.lyrics,
      source: cached.lyrics.length > 0 ? (cached.source ?? "whisper") : "none",
      match: cached.match,
    };
  }

  try {
    const result = await inference.transcribe(song.absolutePath);
    if (!result.stub) {
      putCachedLyrics(song.id, {
        lyrics: result.lyrics,
        stub: false,
        source: "whisper",
      });
      void updateSong(song.id, { lyricsSource: "whisper" });
    }
    return {
      lyrics: result.lyrics,
      source: result.lyrics.length > 0 ? "whisper" : "none",
    };
  } catch {
    // A missing transcription is not fatal. The performance screen has a
    // reasonable empty state for it.
    return { lyrics: [], source: "none" };
  }
}
