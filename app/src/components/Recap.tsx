"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { BacklineCrew } from "@/components/BacklineCrew";
import type { StyleSkin } from "@/lib/styles";
import type { RecapStats } from "@/lib/types";

/**
 * Average mic level over the frames where someone was audible, described in
 * words. A number out of one would read as a score, which is the thing this
 * screen is specifically not.
 */
function describeEnergy(value: number): string {
  if (value <= 0) return "Nothing picked up";
  if (value < 0.2) return "Barely above a whisper";
  if (value < 0.4) return "Politely, as if flatmates were in";
  if (value < 0.65) return "A proper singing voice";
  if (value < 0.85) return "Committed";
  return "The neighbours know";
}

/**
 * Screen five. A summary, not a score.
 *
 * The brief cut scoring from version one deliberately, and it was right to:
 * putting a number on someone's singing changes what the app is for. This
 * reports what happened and leaves the judging out of it.
 */
export function Recap({
  stats,
  skin,
  songId,
  songTitle,
  hadReference,
}: {
  stats: RecapStats;
  skin: StyleSkin;
  songId: string;
  songTitle: string;
  hadReference: boolean;
}) {
  const [time, setTime] = useState(0);

  useEffect(() => {
    let handle = requestAnimationFrame(function tick() {
      setTime(performance.now() / 1000);
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, []);

  const minutes = Math.floor(stats.durationSang / 60);
  const seconds = Math.floor(stats.durationSang % 60);

  return (
    <div className="panel recap">
      <BacklineCrew
        skin={skin}
        className="recap-art"
        energy={0.55}
        accuracy={stats.accuracy}
        time={time}
      />

      <div className="recap-body">
        <h2 style={{ margin: 0, fontSize: 22 }}>That is a take.</h2>
        <p className="muted" style={{ margin: "6px 0 18px", fontSize: 14 }}>
          {songTitle}, backed by {skin.label}.
        </p>

        <dl className="recap-stats">
          <div>
            <dt>Time on stage</dt>
            <dd>
              {minutes}:{String(seconds).padStart(2, "0")}
            </dd>
          </div>

          {hadReference ? (
            <>
              <div>
                <dt>Notes within a semitone</dt>
                <dd>
                  {stats.notesHit} of {stats.notesTotal}
                </dd>
              </div>
              <div>
                <dt>Longest run on pitch</dt>
                <dd>{stats.longestStreak} frames</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>Pitch match</dt>
              <dd className="muted" style={{ fontSize: 14 }}>
                Not measured, this track has no reference melody yet
              </dd>
            </div>
          )}

          <div>
            <dt>How loud you got</dt>
            <dd>{describeEnergy(stats.averageEnergy)}</dd>
          </div>
        </dl>

        <div className="recap-actions">
          <Link href={`/style/${songId}`} className="btn primary">
            Try another style
          </Link>
          <Link href="/" className="btn">
            Back to the library
          </Link>
        </div>
      </div>
    </div>
  );
}
