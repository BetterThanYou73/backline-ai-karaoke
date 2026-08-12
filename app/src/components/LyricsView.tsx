"use client";

import { useEffect, useMemo, useRef } from "react";

import type { LyricLine } from "@/lib/types";

/**
 * Karaoke captions.
 *
 * Three lines visible: what just went, what is now, what is next. A full
 * scrolling transcript is harder to sing from, because finding your place
 * costs more attention than the words are worth.
 *
 * The active line fills left to right across its own time span, which is the
 * cue people actually read: not which line, but how far into it.
 */
export function LyricsView({
  lyrics,
  position,
  accent,
}: {
  lyrics: LyricLine[];
  position: number;
  accent: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const activeIndex = useMemo(() => {
    if (lyrics.length === 0) return -1;

    // Lines are sorted, and position moves forward, so a scan from the start
    // is fine at these list sizes.
    let index = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (position >= lyrics[i].start) index = i;
      else break;
    }
    // Past the end of a line with a gap before the next: nothing is active.
    if (index >= 0 && position > lyrics[index].end + 0.4) {
      const next = lyrics[index + 1];
      if (!next || position < next.start) return -1;
    }
    return index;
  }, [lyrics, position]);

  useEffect(() => {
    const active = containerRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  if (lyrics.length === 0) {
    return (
      <div className="lyrics lyrics-empty muted">
        No lyrics for this track. Sing it however you remember it.
      </div>
    );
  }

  const window = lyrics
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => index >= activeIndex - 1 && index <= activeIndex + 2);

  return (
    <div className="lyrics" ref={containerRef}>
      {window.map(({ line, index }) => {
        const isActive = index === activeIndex;
        const span = Math.max(0.4, line.end - line.start);
        const progress = isActive
          ? Math.max(0, Math.min(1, (position - line.start) / span))
          : 0;

        return (
          <div
            key={`${index}-${line.start}`}
            data-active={isActive}
            className={isActive ? "lyric-line active" : "lyric-line"}
          >
            <span className="lyric-base">{line.text}</span>
            {isActive ? (
              <span
                className="lyric-fill"
                style={{ width: `${progress * 100}%`, color: accent }}
                aria-hidden="true"
              >
                {line.text}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
