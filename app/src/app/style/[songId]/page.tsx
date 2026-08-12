import Link from "next/link";
import { notFound } from "next/navigation";

import { Masthead } from "@/components/Masthead";
import { StylePicker } from "@/components/StylePicker";
import { getSong } from "@/lib/library";

export const dynamic = "force-dynamic";

export default async function StylePage({
  params,
}: {
  params: Promise<{ songId: string }>;
}) {
  const { songId } = await params;
  const song = getSong(songId);
  if (!song) notFound();

  return (
    <main className="shell">
      <Masthead tagline="Who is backing you tonight?" />

      <section className="panel" style={{ marginTop: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{song.title}</div>
            <div className="muted" style={{ fontSize: 14 }}>{song.artist}</div>
          </div>
          <div className="song-meta" style={{ alignItems: "center" }}>
            {song.analyzed ? (
              <>
                <span className="pill">{Math.round(song.bpm ?? 0)} bpm</span>
                <span className="pill">{song.key}</span>
              </>
            ) : (
              <span className="pill warn">still analysing</span>
            )}
            <Link href="/" className="pill">
              Back to library
            </Link>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 6px" }}>Pick a style</h2>
        <p className="muted" style={{ fontSize: 14, margin: "0 0 16px", maxWidth: 640, lineHeight: 1.6 }}>
          The instrumental is generated fresh for this song in the style you
          pick, following the original melody. The first time a combination is
          used it takes a moment to render. After that it loads instantly.
        </p>
        <StylePicker songId={song.id} />
      </section>
    </main>
  );
}
