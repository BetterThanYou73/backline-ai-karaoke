import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { CACHE_DIR, DB_PATH } from "./config";
import type { GeneratedTrack, StyleId } from "./types";

/**
 * Cache index.
 *
 * SQLite rather than a flat JSON file because the miss path does a read, then
 * a write, then more reads from a poll loop, and a whole-file rewrite would
 * race with itself under one user hitting refresh twice.
 *
 * Uses Node's built-in node:sqlite rather than better-sqlite3 so that cloning
 * this repo does not require a C++ toolchain. Needs Node 22.5 or newer, and
 * prints an experimental-feature warning on startup.
 */

let db: DatabaseSync | null = null;

function connect(): DatabaseSync {
  if (db) return db;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const handle = new DatabaseSync(DB_PATH);

  // WAL so a poll loop reading the index cannot block the write that finishes
  // a render.
  handle.exec("PRAGMA journal_mode = WAL");

  handle.exec(`
    CREATE TABLE IF NOT EXISTS generated_track (
      id          TEXT PRIMARY KEY,
      song_id     TEXT NOT NULL,
      style       TEXT NOT NULL,
      file        TEXT NOT NULL,
      bpm         REAL,
      key         TEXT,
      duration    REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      UNIQUE (song_id, style)
    );

    CREATE INDEX IF NOT EXISTS idx_track_song ON generated_track (song_id);

    CREATE TABLE IF NOT EXISTS lyrics_cache (
      song_id     TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);

  db = handle;
  return db;
}

interface TrackRow {
  id: string;
  song_id: string;
  style: string;
  file: string;
  bpm: number | null;
  key: string | null;
  duration: number;
  created_at: string;
}

function toTrack(row: TrackRow): GeneratedTrack {
  return {
    id: row.id,
    songId: row.song_id,
    style: row.style as StyleId,
    audioUrl: `/api/media/track/${encodeURIComponent(row.file)}`,
    bpm: row.bpm,
    key: row.key,
    duration: row.duration,
    createdAt: row.created_at,
  };
}

export function findTrack(songId: string, style: StyleId): GeneratedTrack | null {
  const row = connect()
    .prepare("SELECT * FROM generated_track WHERE song_id = ? AND style = ?")
    .get(songId, style) as TrackRow | undefined;
  return row ? toTrack(row) : null;
}

export function saveTrack(input: {
  songId: string;
  style: StyleId;
  file: string;
  bpm: number | null;
  key: string | null;
  duration: number;
}): GeneratedTrack {
  const id = `${input.songId}::${input.style}`;

  connect()
    .prepare(
      `INSERT INTO generated_track (id, song_id, style, file, bpm, key, duration, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (song_id, style) DO UPDATE SET
         file = excluded.file,
         bpm = excluded.bpm,
         key = excluded.key,
         duration = excluded.duration,
         created_at = excluded.created_at`,
    )
    .run(
      id,
      input.songId,
      input.style,
      input.file,
      input.bpm,
      input.key,
      input.duration,
      new Date().toISOString(),
    );

  const saved = findTrack(input.songId, input.style);
  if (!saved) throw new Error("track insert did not round-trip");
  return saved;
}

export function getCachedLyrics<T>(songId: string): T | null {
  const row = connect()
    .prepare("SELECT payload FROM lyrics_cache WHERE song_id = ?")
    .get(songId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : null;
}

export function putCachedLyrics(songId: string, payload: unknown): void {
  connect()
    .prepare(
      `INSERT INTO lyrics_cache (song_id, payload, created_at) VALUES (?, ?, ?)
       ON CONFLICT (song_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    )
    .run(songId, JSON.stringify(payload), new Date().toISOString());
}
