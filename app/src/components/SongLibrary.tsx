"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PublicSong } from "@/lib/library";

function formatDuration(seconds: number): string {
  if (!seconds) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function SongLibrary({ refreshToken }: { refreshToken: number }) {
  const [songs, setSongs] = useState<PublicSong[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/songs", { cache: "no-store" });
      const data = await response.json();
      setSongs(data.songs ?? []);
      setError(null);

      // Analysis runs in the background on the server. Keep polling only while
      // something is still unanalysed, then stop.
      const pending = (data.songs as PublicSong[]).some(
        (song) => !song.analyzed && !song.analysisError,
      );
      if (pending) {
        pollRef.current = setTimeout(load, 2500);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [load, refreshToken]);

  if (error) {
    return (
      <div className="panel" style={{ borderColor: "var(--bad)" }}>
        Could not load the library: {error}
      </div>
    );
  }

  if (!songs) {
    return (
      <div className="panel muted">
        <span className="spinner" /> Reading the songs folder...
      </div>
    );
  }

  if (songs.length === 0) {
    return (
      <div className="panel">
        <strong>No songs yet.</strong>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
          Drop any mp3, wav, flac or m4a into <code>app/data/songs</code> and
          refresh, or import one below. Files named{" "}
          <code>Artist - Title.mp3</code> get their title and artist filled in
          automatically. Tempo and key are worked out on first sight.
        </p>
      </div>
    );
  }

  return (
    <ul className="song-grid">
      {songs.map((song) => (
        <li key={song.id}>
          <Link href={`/style/${song.id}`} className="song-card">
            <div className="song-card-top">
              <span className="song-title">{song.title}</span>
              <span className="muted song-artist">{song.artist}</span>
            </div>
            <div className="song-meta">
              <span className="pill">{formatDuration(song.duration)}</span>
              {song.analyzed ? (
                <>
                  <span className="pill">{Math.round(song.bpm ?? 0)} bpm</span>
                  <span className="pill">{song.key}</span>
                </>
              ) : song.analysisError ? (
                <span className="pill bad" title={song.analysisError}>
                  analysis failed
                </span>
              ) : (
                <span className="pill warn">
                  <span className="spinner" style={{ width: 10, height: 10 }} />
                  analysing
                </span>
              )}
              {song.source === "import" ? (
                <span className="pill">imported</span>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
