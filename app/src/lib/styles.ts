import type { StyleId } from "./types";

/**
 * Presentation side of the six Backline skins. The generation prompts live on
 * the inference server; this file is only colour, copy and mascot shape, so the
 * two can be tuned independently.
 */
export interface StyleSkin {
  id: StyleId;
  label: string;
  genre: string;
  vibe: string;
  /** Background gradient stops for the style picker and stage. */
  gradient: [string, string];
  accent: string;
  /** Mascot body colour and trim, used by the procedural crew renderer. */
  body: string;
  trim: string;
  /** Crew silhouette. Drives which shapes BacklineCrew draws. */
  crew: "robot" | "band" | "roadie" | "deckhand" | "spirit" | "glam";
  blurb: string;
}

export const STYLES: Record<StyleId, StyleSkin> = {
  neon: {
    id: "neon",
    label: "Backline: Neon",
    genre: "Synthwave",
    vibe: "Retro future robots",
    gradient: ["#1b0736", "#08111f"],
    accent: "#ff4ecd",
    body: "#3a2c6b",
    trim: "#42e8ff",
    crew: "robot",
    blurb: "Analog arpeggios, gated drums, a long drive under purple streetlights.",
  },
  velvet: {
    id: "velvet",
    label: "Backline: Velvet",
    genre: "Jazz",
    vibe: "Speakeasy band",
    gradient: ["#2a1108", "#120806"],
    accent: "#e0a755",
    body: "#5a2f1c",
    trim: "#f2d7a0",
    crew: "band",
    blurb: "Brushed drums, walking bass, a Rhodes in a room with low ceilings.",
  },
  riff: {
    id: "riff",
    label: "Backline: Riff",
    genre: "Rock",
    vibe: "Roadie gang",
    gradient: ["#2b0d0d", "#100808"],
    accent: "#ff6a3d",
    body: "#4a1f1f",
    trim: "#ffd166",
    crew: "roadie",
    blurb: "Crunchy guitars and a drummer who has never once played quietly.",
  },
  tide: {
    id: "tide",
    label: "Backline: Tide",
    genre: "Sea shanty",
    vibe: "Deckhand crew",
    gradient: ["#06283d", "#03131f"],
    accent: "#4ecdc4",
    body: "#1b4a5c",
    trim: "#f4e3c1",
    crew: "deckhand",
    blurb: "Accordion, fiddle, and the whole ship stamping on the downbeat.",
  },
  grove: {
    id: "grove",
    label: "Backline: Grove",
    genre: "Chill lo-fi",
    vibe: "Forest spirits",
    gradient: ["#13291f", "#0a140f"],
    accent: "#9ae66e",
    body: "#265440",
    trim: "#d9f2c0",
    crew: "spirit",
    blurb: "Dusty vinyl, soft drums, nothing in a hurry.",
  },
  bloom: {
    id: "bloom",
    label: "Backline: Bloom",
    genre: "Pop",
    vibe: "Studio glam crew",
    gradient: ["#2d0f33", "#150a1c"],
    accent: "#ff7ab6",
    body: "#5b2a63",
    trim: "#ffe0f0",
    crew: "glam",
    blurb: "Bright plucks, four on the floor, mixed for a car stereo.",
  },
};

export const STYLE_IDS = Object.keys(STYLES) as StyleId[];

export function isStyleId(value: string): value is StyleId {
  return Object.prototype.hasOwnProperty.call(STYLES, value);
}
