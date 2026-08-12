import Link from "next/link";
import { notFound } from "next/navigation";

import { Masthead } from "@/components/Masthead";
import { PerformanceStage } from "@/components/PerformanceStage";
import { getCachedLyrics, putCachedLyrics } from "@/lib/db";
import * as inference from "@/lib/inference";
import { getSong } from "@/lib/library";
import { STYLES, isStyleId } from "@/lib/styles";
import type { LyricLine } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Screen four. Resolves lyrics server side so the client starts with them in
 * hand: a transcription request in the middle of loading a performance would
 * be the one network call the spec says must not happen near a take.
 */
async function resolveLyrics(
  songId: string,
  bundled: LyricLine[],
  audioPath: string,
): Promise<LyricLine[]> {
  if (bundled.length > 0) return bundled;

  const cached = getCachedLyrics<LyricLine[]>(songId);
  if (cached) return cached;

  try {
    const result = await inference.transcribe(audioPath);
    putCachedLyrics(songId, result.lyrics);
    return result.lyrics;
  } catch {
    return [];
  }
}

export default async function PerformPage({
  params,
}: {
  params: Promise<{ songId: string; style: string }>;
}) {
  const { songId, style } = await params;
  if (!isStyleId(style)) notFound();

  const song = getSong(songId);
  if (!song) notFound();

  const skin = STYLES[style];
  const lyrics = await resolveLyrics(song.id, song.lyrics, song.absolutePath);

  return (
    <main className="shell stage-shell">
      <Masthead tagline={`${song.title}, with ${skin.label}`} />

      <div className="stage-bar">
        <div className="song-meta">
          <span className="pill">{song.artist}</span>
          {song.bpm ? <span className="pill">{Math.round(song.bpm)} bpm</span> : null}
          {song.key ? <span className="pill">{song.key}</span> : null}
          <span className="pill" style={{ color: skin.accent, borderColor: skin.accent }}>
            {skin.genre}
          </span>
        </div>
        <Link href={`/style/${song.id}`} className="pill">
          Change style
        </Link>
      </div>

      <PerformanceStage
        songId={song.id}
        songTitle={song.title}
        style={style}
        skin={skin}
        lyrics={lyrics}
        melodyContour={song.melodyContour}
        bpm={song.bpm}
      />
    </main>
  );
}
