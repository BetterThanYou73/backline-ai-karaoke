import path from "node:path";

const appRoot = process.cwd();

function resolveFromApp(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

export const INFERENCE_API_URL = (
  process.env.INFERENCE_API_URL ?? "http://127.0.0.1:8001"
).replace(/\/+$/, "");

/** Rendered backing tracks, copied out of the inference server's output. */
export const CACHE_DIR = resolveFromApp(process.env.CACHE_DIR ?? "../cache");

/** Audio the user drops in by hand. */
export const SONGS_DIR = resolveFromApp(process.env.SONGS_DIR ?? "./data/songs");

/** Audio uploaded through the import screen. */
export const IMPORTS_DIR = resolveFromApp(
  process.env.IMPORTS_DIR ?? "./data/imports",
);

/** Generated song metadata index. Rebuilt from SONGS_DIR when files change. */
export const SONGS_INDEX = resolveFromApp(
  process.env.SONGS_INDEX ?? "./data/songs.json",
);

export const DB_PATH = path.join(CACHE_DIR, "backline.db");

export const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".ogg",
  ".opus",
]);
