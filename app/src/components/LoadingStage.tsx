"use client";

import { useEffect, useState } from "react";

import { BacklineCrew } from "@/components/BacklineCrew";
import type { StyleSkin } from "@/lib/styles";

/**
 * Screen three: what a cache miss looks like.
 *
 * Renders can take a minute on a laptop GPU, so this shows real progress from
 * the job rather than an indeterminate spinner, and names the actual stage.
 */
function describeEta(seconds: number): string {
  if (seconds < 90) return `around ${Math.round(seconds)}s`;
  return `around ${Math.round(seconds / 60)} min`;
}

export function LoadingStage({
  skin,
  progress,
  queuePosition,
  etaSeconds,
  onCancel,
}: {
  skin: StyleSkin;
  progress: number;
  queuePosition?: number | null;
  etaSeconds?: number;
  onCancel?: () => void;
}) {
  const [time, setTime] = useState(0);

  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      setTime(performance.now() / 1000);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  // Position 0 means first in the waiting line, behind whatever is running.
  // Gating on > 0 told a genuinely queued user nothing at all.
  const waiting = typeof queuePosition === "number" && queuePosition >= 0;

  return (
    <div className="loading-stage panel">
      <BacklineCrew
        skin={skin}
        className="loading-art"
        energy={0.2 + progress * 0.5}
        accuracy={0.4}
        time={time}
      />

      <div className="loading-copy">
        <h2 style={{ margin: 0, fontSize: 20 }}>Tuning your stage</h2>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, margin: "8px 0 0" }}>
          {waiting
            ? `Waiting behind ${(queuePosition ?? 0) + 1} other render${
                (queuePosition ?? 0) === 0 ? "" : "s"
              }. One job at a time keeps the GPU from running out of memory.`
            : `The ${skin.genre.toLowerCase()} crew is learning this song. It only happens once for each song and style, after that it loads instantly.`}
        </p>

        <div
          className="progress-track"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="progress-fill"
            style={{ width: `${percent}%`, background: skin.accent }}
          />
        </div>

        <div className="loading-meta">
          <span className="pill">{percent}%</span>
          {etaSeconds ? <span className="pill">{describeEta(etaSeconds)}</span> : null}
          <span className="pill">{skin.label}</span>
        </div>

        {/* A render can run for minutes. Leaving the only exit as the browser
            back button is not an exit. */}
        {onCancel ? (
          <button className="btn" style={{ marginTop: 16 }} onClick={onCancel}>
            Stop and pick another style
          </button>
        ) : null}
      </div>
    </div>
  );
}
