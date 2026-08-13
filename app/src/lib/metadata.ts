import type { LyricLine } from "./types";

/**
 * Where a song's identity and words come from.
 *
 * Three tiers, cheapest and most private first:
 *
 *   1. Embedded tags. Almost every file that came from a store or a rip
 *      already knows its own title, artist and album. Reading them costs
 *      nothing and leaves the machine untouched, and it beats parsing a
 *      filename, which is guesswork.
 *   2. LRCLIB, for real synced lyrics. A karaoke app transcribing lyrics it
 *      could simply look up is doing hard work badly: Whisper on singing
 *      mishears words and smears timings across sustained vowels, while LRCLIB
 *      returns the actual words on a proper timing grid.
 *   3. Whisper, for anything not in a database, which is where it is genuinely
 *      the only option.
 *
 * Tier 2 leaves this machine, so it is behind a setting and off by default.
 * Only a title, artist and duration are sent, never audio.
 */

export interface FileTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  durationSeconds?: number;
}

/** Read embedded tags. Never throws: a file with no tags is normal. */
export async function readTags(absolutePath: string): Promise<FileTags> {
  try {
    const { parseFile } = await import("music-metadata");
    const parsed = await parseFile(absolutePath, { duration: true });

    const title = parsed.common.title?.trim();
    const artist = (parsed.common.artist ?? parsed.common.albumartist)?.trim();

    return {
      title: title || undefined,
      artist: artist || undefined,
      album: parsed.common.album?.trim() || undefined,
      year: parsed.common.year,
      durationSeconds: parsed.format.duration,
    };
  } catch {
    return {};
  }
}

interface LrclibHit {
  id: number;
  trackName: string;
  artistName: string;
  duration: number | null;
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

/**
 * Parse an LRC file into timed lines.
 *
 * A line may carry several timestamps when the same words repeat, so each one
 * becomes its own entry. Ends are inferred from the following line's start,
 * because LRC only marks beginnings.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const entries: { start: number; text: string }[] = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (stamps.length === 0) continue;

    const text = rawLine.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue; // a timestamp with no words is a gap marker

    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2].replace(":", "."));
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
      entries.push({ start: minutes * 60 + seconds, text });
    }
  }

  entries.sort((a, b) => a.start - b.start);

  return entries.map((entry, index) => ({
    text: entry.text,
    start: Number(entry.start.toFixed(3)),
    // Hold a line until the next one, capped so a long instrumental gap does
    // not leave one line highlighted for a minute.
    end: Number(
      Math.min(
        entries[index + 1]?.start ?? entry.start + 6,
        entry.start + 8,
      ).toFixed(3),
    ),
  }));
}

export interface LyricsLookup {
  lyrics: LyricLine[];
  source: "lrclib";
  matchedTitle: string;
  matchedArtist: string;
}

/**
 * Look up synced lyrics by title, artist and duration.
 *
 * Duration is the discriminator that makes this trustworthy. Popular songs
 * have live versions, remasters and radio edits with the same title and
 * artist, and picking the wrong one gives lyrics that drift further out of
 * time the longer you sing.
 */
export async function lookupLyrics(
  title: string,
  artist: string,
  durationSeconds: number | null,
  signal?: AbortSignal,
): Promise<LyricsLookup | null> {
  const query = new URLSearchParams({ track_name: title });
  if (artist) query.set("artist_name", artist);

  const response = await fetch(`https://lrclib.net/api/search?${query}`, {
    signal,
    headers: {
      // LRCLIB asks clients to identify themselves.
      "user-agent": "Backline/1.0 (https://github.com/BetterThanYou73/backline-ai-karaoke)",
    },
  });
  if (!response.ok) return null;

  const hits = (await response.json()) as LrclibHit[];
  const synced = hits.filter((hit) => hit.syncedLyrics);
  if (synced.length === 0) return null;

  let best = synced[0];
  if (durationSeconds && durationSeconds > 0) {
    let bestGap = Infinity;
    for (const hit of synced) {
      const gap = hit.duration ? Math.abs(hit.duration - durationSeconds) : Infinity;
      if (gap < bestGap) {
        bestGap = gap;
        best = hit;
      }
    }
    // More than a few seconds out is a different recording, not this one.
    if (bestGap > 8) return null;
  }

  const lyrics = parseLrc(best.syncedLyrics as string);
  if (lyrics.length === 0) return null;

  return {
    lyrics,
    source: "lrclib",
    matchedTitle: best.trackName,
    matchedArtist: best.artistName,
  };
}
