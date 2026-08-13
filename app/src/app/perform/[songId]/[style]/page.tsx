import Link from "next/link";
import { notFound } from "next/navigation";

import { Masthead } from "@/components/Masthead";
import { PerformanceStage } from "@/components/PerformanceStage";
import { SkinProvider } from "@/components/SkinProvider";
import { getSong } from "@/lib/library";
import { resolveLyrics } from "@/lib/lyrics";
import { STYLES, isStyleId } from "@/lib/styles";

export const dynamic = "force-dynamic";

/**
 * Screen four. Lyrics resolve server side so the client starts with them in
 * hand: a transcription request in the middle of loading a performance would
 * be the one network call the spec says must not happen near a take.
 */
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
  const resolved = await resolveLyrics(song);

  return (
    <main className="shell stage-shell">
      <SkinProvider skin={skin} />
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
        <div className="song-meta">
          {resolved.source === "lrclib" ? (
            <span className="pill good" title={resolved.match}>
              synced lyrics
            </span>
          ) : null}
          {resolved.source === "whisper" ? (
            <span className="pill" title="Transcribed from the audio. Turn on online lookup in settings for the real words.">
              transcribed lyrics
            </span>
          ) : null}
          <Link href={`/style/${song.id}`} className="pill">
            Change style
          </Link>
        </div>
      </div>

      <PerformanceStage
        songId={song.id}
        songTitle={song.title}
        style={style}
        skin={skin}
        lyrics={resolved.lyrics}
        melodyContour={song.melodyContour}
        bpm={song.bpm}
      />
    </main>
  );
}
