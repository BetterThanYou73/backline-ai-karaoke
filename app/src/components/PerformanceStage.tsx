"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { BacklineCrew } from "@/components/BacklineCrew";
import { CameraOverlay } from "@/components/CameraOverlay";
import { LoadingStage } from "@/components/LoadingStage";
import { LyricsView } from "@/components/LyricsView";
import { Recap } from "@/components/Recap";
import { PerformanceEngine, type EngineFrame } from "@/audio/engine";
import type { StyleSkin } from "@/lib/styles";
import type { LyricLine, RecapStats, StyleId, TrackJob } from "@/lib/types";

type Phase =
  | { kind: "loading"; progress: number; queuePosition?: number | null; eta?: number }
  | { kind: "ready"; trackUrl: string }
  | { kind: "starting" }
  | { kind: "singing" }
  | { kind: "done"; stats: RecapStats }
  | { kind: "error"; message: string };

interface Props {
  songId: string;
  songTitle: string;
  songArtist: string;
  style: StyleId;
  skin: StyleSkin;
  lyrics: LyricLine[];
  melodyContour: [number, number | null][];
  bpm: number | null;
}

export function PerformanceStage(props: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading", progress: 0 });
  const [frame, setFrame] = useState<EngineFrame | null>(null);
  const [clock, setClock] = useState(0);

  const engineRef = useRef<PerformanceEngine | null>(null);
  const trackUrlRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);

  // Cache-or-generate, then poll. The server hides the job queue behind three
  // states, so this only has to care about cached, pending and error.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(jobId: string) {
      if (cancelled) return;
      const response = await fetch(
        `/api/tracks?jobId=${encodeURIComponent(jobId)}&songId=${encodeURIComponent(
          props.songId,
        )}&style=${props.style}`,
        { cache: "no-store" },
      );
      const job = (await response.json()) as TrackJob;
      if (cancelled) return;

      if (job.state === "cached" && job.track) {
        trackUrlRef.current = job.track.audioUrl;
        setPhase({ kind: "ready", trackUrl: job.track.audioUrl });
        return;
      }
      if (job.state === "error") {
        setPhase({ kind: "error", message: job.error ?? "generation failed" });
        return;
      }

      setPhase({
        kind: "loading",
        progress: job.progress ?? 0,
        queuePosition: job.queuePosition,
      });
      timer = setTimeout(() => void poll(jobId), 1200);
    }

    async function begin() {
      try {
        const response = await fetch("/api/tracks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ songId: props.songId, style: props.style }),
        });
        const job = (await response.json()) as TrackJob;
        if (cancelled) return;

        if (job.state === "cached" && job.track) {
          trackUrlRef.current = job.track.audioUrl;
          setPhase({ kind: "ready", trackUrl: job.track.audioUrl });
        } else if (job.state === "pending" && job.jobId) {
          setPhase({ kind: "loading", progress: 0, eta: job.etaSeconds });
          void poll(job.jobId);
        } else {
          setPhase({ kind: "error", message: job.error ?? "could not start a render" });
        }
      } catch (error) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    void begin();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [props.songId, props.style]);

  // Clock for the idle crew animation, independent of audio position.
  useEffect(() => {
    let handle = requestAnimationFrame(function tick() {
      setClock(performance.now() / 1000);
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, []);

  useEffect(() => {
    return () => {
      void engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const finish = useCallback(() => {
    const engine = engineRef.current;
    const stats = engine?.stats ?? {
      accuracy: 0,
      notesHit: 0,
      notesTotal: 0,
      longestStreak: 0,
    };
    setPhase({
      kind: "done",
      stats: {
        ...stats,
        durationSang: (performance.now() - startedAtRef.current) / 1000,
        averageEnergy: 0,
      },
    });
    void engineRef.current?.dispose();
    engineRef.current = null;
  }, []);

  const start = useCallback(async () => {
    const trackUrl = trackUrlRef.current;
    if (!trackUrl) return;

    setPhase({ kind: "starting" });
    try {
      const engine = new PerformanceEngine({
        trackUrl,
        melodyContour: props.melodyContour,
        bpm: props.bpm,
        onFrame: setFrame,
        onEnded: finish,
      });
      await engine.prepare();
      engineRef.current = engine;
      startedAtRef.current = performance.now();
      await engine.start();
      setPhase({ kind: "singing" });
    } catch (error) {
      setPhase({
        kind: "error",
        message:
          error instanceof Error
            ? `${error.message}. Microphone access is required to sing along.`
            : String(error),
      });
    }
  }, [finish, props.bpm, props.melodyContour]);

  if (phase.kind === "loading") {
    return (
      <LoadingStage
        skin={props.skin}
        progress={phase.progress}
        queuePosition={phase.queuePosition}
        etaSeconds={phase.eta}
      />
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="panel" style={{ borderColor: "var(--bad)" }}>
        <strong>Could not get the stage ready.</strong>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>{phase.message}</p>
        <Link href={`/style/${props.songId}`} className="btn" style={{ display: "inline-block" }}>
          Pick another style
        </Link>
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <Recap
        stats={phase.stats}
        skin={props.skin}
        songId={props.songId}
        songTitle={props.songTitle}
        hadReference={props.melodyContour.length > 0}
      />
    );
  }

  const singing =
    phase.kind === "singing" && !!frame && frame.f0 > 0 && frame.clarity > 0.55;
  const energy = frame ? Math.min(1, frame.rms * 9) : 0;
  const accuracy = frame?.accuracy ?? 0;

  return (
    <div className="stage">
      <div className="stage-main">
        <CameraOverlay
          skin={props.skin}
          reaction={{ energy, accuracy, singing }}
        />

        <LyricsView
          lyrics={props.lyrics}
          position={frame?.position ?? 0}
          accent={props.skin.accent}
        />
      </div>

      <aside className="stage-side">
        <BacklineCrew
          skin={props.skin}
          className="stage-crew"
          energy={energy}
          accuracy={accuracy}
          time={clock}
        />

        {phase.kind === "ready" || phase.kind === "starting" ? (
          <div className="panel">
            <strong>Ready when you are.</strong>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, margin: "6px 0 12px" }}>
              Starting needs your microphone, and the camera if you want the
              overlay. Nothing is recorded or uploaded.
            </p>
            <button
              className="btn primary"
              disabled={phase.kind === "starting"}
              onClick={() => void start()}
            >
              {phase.kind === "starting" ? (
                <>
                  <span className="spinner" /> Setting up
                </>
              ) : (
                "Start singing"
              )}
            </button>
          </div>
        ) : (
          <div className="panel meters">
            <Meter label="Pitch match" value={accuracy} accent={props.skin.accent} />
            <Meter label="Energy" value={energy} accent={props.skin.trim} />

            <div className="meter-readouts">
              <span className="pill">
                key {frame && frame.shift >= 0 ? "+" : ""}
                {frame?.shift.toFixed(1) ?? "0.0"} st
              </span>
              <span className="pill">
                tempo {(((frame?.tempo ?? 1) - 1) * 100).toFixed(0)}%
              </span>
              {props.melodyContour.length === 0 ? (
                <span className="pill warn" title="No reference melody was extracted for this song, so the key is not adapted.">
                  no reference melody
                </span>
              ) : null}
            </div>

            <button className="btn" onClick={finish}>
              End the take
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

function Meter({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <div
          className="meter-fill"
          style={{
            width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`,
            background: accent,
          }}
        />
      </div>
    </div>
  );
}
