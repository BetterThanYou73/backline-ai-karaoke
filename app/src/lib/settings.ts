import fs from "node:fs";
import path from "node:path";

import { SETTINGS_PATH } from "./config";

/**
 * Runtime settings, owned by the App Server rather than the inference .env.
 *
 * Anything here is something a person might want to change between two songs,
 * so it must not require editing a file and restarting a Python process. The
 * inference .env keeps only what is genuinely deployment shaped: which device,
 * which model, which port.
 *
 * Read fresh on every access, guarded by mtime. Same reasoning as the song
 * index: server components and route handlers are separate module instances,
 * so an in-memory value would drift between them.
 */

export interface Settings {
  /** Seconds of audio to render per track. 0 renders the whole song. */
  maxRenderSeconds: number;
  /** How far the backing track may be shifted to follow the singer. */
  maxSemitones: number;
  /** How far the tempo may be pulled, as a fraction. 0.15 is 15 percent. */
  maxTempoDrift: number;
  /** Turn off the adaptive layer entirely and play the track straight. */
  adaptivePlayback: boolean;
  /** Camera overlay on the performance screen. */
  cameraOverlay: boolean;
  /** Reduce the on-screen motion regardless of the OS setting. */
  calmVisuals: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  maxRenderSeconds: 90,
  maxSemitones: 2,
  maxTempoDrift: 0.15,
  adaptivePlayback: true,
  cameraOverlay: true,
  calmVisuals: false,
};

export const SETTINGS_LIMITS = {
  maxRenderSeconds: { min: 0, max: 600 },
  maxSemitones: { min: 0, max: 6 },
  maxTempoDrift: { min: 0, max: 0.4 },
} as const;

let cache: Settings | null = null;
let cacheMtime = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Accept only known keys, coerced and clamped. Never trust the request body. */
function coerce(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const pickNumber = (
    key: "maxRenderSeconds" | "maxSemitones" | "maxTempoDrift",
  ): number => {
    const value = Number(input[key]);
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS[key];
    const { min, max } = SETTINGS_LIMITS[key];
    return clamp(value, min, max);
  };
  const pickBoolean = (
    key: "adaptivePlayback" | "cameraOverlay" | "calmVisuals",
  ): boolean =>
    typeof input[key] === "boolean" ? (input[key] as boolean) : DEFAULT_SETTINGS[key];

  return {
    maxRenderSeconds: pickNumber("maxRenderSeconds"),
    maxSemitones: pickNumber("maxSemitones"),
    maxTempoDrift: pickNumber("maxTempoDrift"),
    adaptivePlayback: pickBoolean("adaptivePlayback"),
    cameraOverlay: pickBoolean("cameraOverlay"),
    calmVisuals: pickBoolean("calmVisuals"),
  };
}

export function getSettings(): Settings {
  let mtime = 0;
  try {
    mtime = fs.statSync(SETTINGS_PATH).mtimeMs;
  } catch {
    return DEFAULT_SETTINGS;
  }

  if (cache && mtime === cacheMtime) return cache;

  try {
    cache = coerce(JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")));
    cacheMtime = mtime;
  } catch {
    return cache ?? DEFAULT_SETTINGS;
  }

  return cache;
}

export function saveSettings(patch: unknown): Settings {
  const merged = coerce({ ...getSettings(), ...(patch as object) });

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const temporary = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(merged, null, 2), "utf8");
  fs.renameSync(temporary, SETTINGS_PATH);

  cache = merged;
  try {
    cacheMtime = fs.statSync(SETTINGS_PATH).mtimeMs;
  } catch {
    cacheMtime = 0;
  }

  return merged;
}
