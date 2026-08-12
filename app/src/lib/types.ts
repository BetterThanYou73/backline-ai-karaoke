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
  source: "ncs" | "import";
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
