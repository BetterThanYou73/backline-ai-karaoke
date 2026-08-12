import { NextResponse } from "next/server";

import { getCachedLyrics, putCachedLyrics } from "@/lib/db";
import * as inference from "@/lib/inference";
import { getSong, toPublicSong } from "@/lib/library";
import type { LyricLine } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Full song detail for the performance screen: metadata, lyrics, and the
 * reference melody contour the pitch scoring compares against.
 *
 * Lyrics resolve in priority order: a sidecar file next to the audio, then a
 * cached Whisper transcription, then a fresh transcription. Bundled timings
 * beat transcription every time, so the sidecar wins.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const song = getSong(id);
  if (!song) {
    return NextResponse.json({ error: "unknown song" }, { status: 404 });
  }

  let lyrics: LyricLine[] = song.lyrics;

  if (lyrics.length === 0) {
    const cached = getCachedLyrics<LyricLine[]>(song.id);
    if (cached) {
      lyrics = cached;
    } else {
      try {
        const result = await inference.transcribe(song.absolutePath);
        lyrics = result.lyrics;
        putCachedLyrics(song.id, lyrics);
      } catch {
        // A missing transcription is not fatal. The performance screen falls
        // back to a plain "no lyrics for this track" state.
        lyrics = [];
      }
    }
  }

  // Duration is filled in by the background analysis pass. Until that lands
  // the client reads it off the audio element once the buffer decodes.
  return NextResponse.json({
    song: { ...toPublicSong(song), lyrics },
    melodyContour: song.melodyContour,
  });
}
