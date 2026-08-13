export type StyleId = "neon" | "velvet" | "riff" | "tide" | "grove" | "bloom";

export interface LyricLine {
  text: string;
  start: number;
  end: number;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  album?: string;
  source: "ncs" | "import";
  /** Where the lyrics came from, so the UI can be honest about it. */
  lyricsSource?: "sidecar" | "lrclib" | "whisper" | "none";
  /** What LRCLIB matched, when it was used. */
  lyricsMatch?: string;
  /** Path relative to SONGS_DIR, or to the imports directory. */
  file: string;
  duration: number;
  bpm: number | null;
  key: string | null;
  lyrics: LyricLine[];
  createdAt: string;
}

export interface GeneratedTrack {
  id: string;
  songId: string;
  style: StyleId;
  /** Which engine rendered it, so provenance is never ambiguous. */
  engine: string;
  /** App server route that streams the cached audio. */
  audioUrl: string;
  bpm: number | null;
  key: string | null;
  duration: number;
  createdAt: string;
}

/** What the client polls while a cache miss renders. */
export interface TrackJob {
  state: "cached" | "pending" | "error";
  jobId?: string;
  progress?: number;
  queuePosition?: number | null;
  track?: GeneratedTrack;
  error?: string;
  /** Rough seconds remaining, for the loading screen copy. */
  etaSeconds?: number;
}

export interface RecapStats {
  durationSang: number;
  /** Share of voiced frames landing within a semitone of the melody. */
  accuracy: number;
  longestStreak: number;
  averageEnergy: number;
  notesHit: number;
  notesTotal: number;
}

