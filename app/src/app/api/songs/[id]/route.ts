import { NextResponse } from "next/server";

import { getSong, toPublicSong } from "@/lib/library";
import { resolveLyrics } from "@/lib/lyrics";

export const dynamic = "force-dynamic";

/**
 * Full song detail: metadata, lyrics, and the reference melody contour the
 * pitch scoring compares against.
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

  const lyrics = await resolveLyrics(song);

  // Duration is filled in by the background analysis pass. Until that lands
  // the client reads it off the audio element once the buffer decodes.
  return NextResponse.json({
    song: { ...toPublicSong(song), lyrics },
    melodyContour: song.melodyContour,
  });
}
