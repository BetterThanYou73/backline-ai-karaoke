"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BacklineCrew } from "@/components/BacklineCrew";
import { CameraOverlay } from "@/components/CameraOverlay";
import { LoadingStage } from "@/components/LoadingStage";
import { LyricsView } from "@/components/LyricsView";
import { Recap } from "@/components/Recap";
import { PerformanceEngine, type EngineFrame } from "@/audio/engine";
import type { StyleSkin } from "@/lib/styles";
import type { Settings } from "@/lib/settings";
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
  style: StyleId;
  skin: StyleSkin;
  lyrics: LyricLine[];
  melodyContour: [number, number | null][];
  bpm: number | null;
}

export function PerformanceStage(props: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading", progress: 0 });
  const [frame, setFrame] = useState<EngineFrame | null>(null);
  const [clock, setClock] = useState(0);

  const [settings, setSettings] = useState<Settings | null>(null);

  const engineRef = useRef<PerformanceEngine | null>(null);
  const trackUrlRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);

  // Loaded before a take so the correction bounds and the camera choice are
  // the ones the user actually asked for.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setSettings(data.settings);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Cache-or-generate, then poll. The server hides the job queue behind three
  // states, so this only has to care about cached, pending and error.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // A transient failure must not end the poll loop. Without this, one
    // non-JSON response, say a proxy error page, rejected into nothing, no
    // further poll was scheduled, and the user sat on "Tuning your stage"
    // forever with no feedback and no way back.
    let consecutiveFailures = 0;

    async function poll(jobId: string, eta?: number) {
      if (cancelled) return;

      try {
        const response = await fetch(
          `/api/tracks?jobId=${encodeURIComponent(jobId)}&songId=${encodeURIComponent(
            props.songId,
          )}&style=${props.style}`,
          { cache: "no-store" },
        );
        if (!response.ok && response.status !== 502) {
          throw new Error(`status ${response.status}`);
        }

        const job = (await response.json()) as TrackJob;
        if (cancelled) return;
        consecutiveFailures = 0;

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
          eta,
        });
      } catch (error) {
        if (cancelled) return;
        consecutiveFailures++;
        if (consecutiveFailures >= 8) {
          setPhase({
            kind: "error",
            message: `Lost contact with the app server while rendering (${
              error instanceof Error ? error.message : String(error)
            }).`,
          });
          return;
        }
      }

      timer = setTimeout(() => void poll(jobId, eta), 1200);
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
          // Carried through every poll, so the estimate does not vanish the
          // moment the first poll comes back.
          void poll(job.jobId, job.etaSeconds);
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
    const stats = engineRef.current?.stats ?? {
      accuracy: 0,
      notesHit: 0,
      notesTotal: 0,
      longestStreak: 0,
      averageEnergy: 0,
    };
    setPhase({
      kind: "done",
      stats: {
        ...stats,
        durationSang: (performance.now() - startedAtRef.current) / 1000,
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
        adaptive: settings?.adaptivePlayback ?? true,
        limits: {
          maxSemitones: settings?.maxSemitones ?? 2,
          maxTempoDrift: settings?.maxTempoDrift ?? 0.15,
        },
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
  }, [finish, props.bpm, props.melodyContour, settings]);

  if (phase.kind === "loading") {
    return (
      <LoadingStage
        skin={props.skin}
        progress={phase.progress}
        queuePosition={phase.queuePosition}
        etaSeconds={phase.eta}
        onCancel={() => router.push(`/style/${props.songId}`)}
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
        {/* Only once the take has started, and only if asked for. Rendering it
            on the ready screen fired a camera permission prompt while the
            panel beside it was still explaining that starting would ask. */}
        {settings?.cameraOverlay !== false && phase.kind === "singing" ? (
          <CameraOverlay skin={props.skin} reaction={{ energy, accuracy, singing }} />
        ) : (
          <div className="camera-wrap camera-idle">
            <BacklineCrew
              skin={props.skin}
              className="camera-idle-art"
              energy={energy}
              accuracy={accuracy}
              time={clock}
            />
          </div>
        )}

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
