"use client";

import { useEffect, useRef, useState } from "react";

import type { StyleSkin } from "@/lib/styles";

/**
 * Camera feed with a reactive overlay.
 *
 * MediaPipe face landmarks position the effects on the singer rather than in a
 * fixed corner, so the aura tracks the head and the sparks come off the mouth.
 * If the landmarker fails to load, the camera still shows and the overlay
 * falls back to a centred position. Losing the flourish is not worth losing
 * the performance screen.
 *
 * Accessibility, per the brief: soft glows and slow pulses only. Nothing here
 * flashes, and everything stops moving under prefers-reduced-motion.
 */

interface Reaction {
  energy: number;
  accuracy: number;
  singing: boolean;
}

const LANDMARK_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

export function CameraOverlay({
  skin,
  reaction,
}: {
  skin: StyleSkin;
  reaction: Reaction;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reactionRef = useRef(reaction);
  const [status, setStatus] = useState<"idle" | "ready" | "denied" | "no-landmarks">(
    "idle",
  );

  // The draw loop reads this rather than closing over the prop, so it does not
  // need to be torn down and rebuilt on every frame of new reaction data.
  reactionRef.current = reaction;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let landmarker: { detectForVideo: (v: HTMLVideoElement, t: number) => unknown; close: () => void } | null =
      null;
    let frame = 0;
    let cancelled = false;
    const sparks: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    async function begin() {
      try {
        const opened = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
        });
        // Unmounting while the permission prompt is open means cleanup has
        // already run and saw a null stream, so it stopped nothing. Close this
        // one here or the camera light stays on for the life of the tab.
        if (cancelled) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
      } catch {
        if (!cancelled) setStatus("denied");
        return;
      }

      const video = videoRef.current;
      if (!video || cancelled) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (!cancelled) setStatus("ready");

      try {
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
        const created = (await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: LANDMARK_MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 1,
        })) as unknown as NonNullable<typeof landmarker>;
        // Same race as the camera: this load takes seconds over a CDN, and
        // cleanup may already have run and closed nothing.
        if (cancelled) {
          created.close();
          return;
        }
        landmarker = created;
      } catch {
        // Offline, or the CDN is blocked. Keep the camera, drop the tracking.
        if (!cancelled) setStatus("no-landmarks");
      }

      const draw = () => {
        if (cancelled) return;
        frame = requestAnimationFrame(draw);

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context || !video.videoWidth) return;

        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }

        context.clearRect(0, 0, canvas.width, canvas.height);

        let headX = canvas.width / 2;
        let headY = canvas.height / 2;
        let mouthY = canvas.height * 0.62;
        let mouthOpen = 0;

        if (landmarker) {
          try {
            const result = landmarker.detectForVideo(video, performance.now()) as {
              faceLandmarks?: { x: number; y: number }[][];
            };
            const face = result.faceLandmarks?.[0];
            if (face && face.length > 200) {
              // Canonical face mesh indices: 1 nose tip, 13 upper lip, 14 lower lip.
              headX = (1 - face[1].x) * canvas.width;
              headY = face[1].y * canvas.height;
              mouthY = ((face[13].y + face[14].y) / 2) * canvas.height;
              mouthOpen = Math.abs(face[14].y - face[13].y) * canvas.height;
            }
          } catch {
            // A dropped frame is not worth stopping the loop over.
          }
        }

        const { energy, accuracy, singing } = reactionRef.current;
        const time = performance.now() / 1000;

        // Canvas animation is out of CSS's reach, so the reduced-motion
        // preference has to be honoured here explicitly. This used to be
        // claimed in a comment and implemented nowhere.
        const calm =
          reducedMotion.matches || document.body.dataset.calm === "true";

        // Aura: radius follows loudness, colour warms with accuracy. Slow
        // sine, no flashing.
        const pulse = calm ? 1 : 1 + Math.sin(time * 2.4) * 0.06;
        const radius = (70 + energy * 190) * pulse;
        const gradient = context.createRadialGradient(
          headX,
          headY,
          radius * 0.25,
          headX,
          headY,
          radius,
        );
        const strength = 0.1 + accuracy * 0.32;
        gradient.addColorStop(0, hexToRgba(skin.accent, strength));
        gradient.addColorStop(1, hexToRgba(skin.accent, 0));

        context.globalCompositeOperation = "lighter";
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(headX, headY, radius, 0, Math.PI * 2);
        context.fill();

        // Sparks from the mouth while actually singing, rate tied to loudness.
        if (!calm && singing && mouthOpen > 4 && Math.random() < 0.25 + energy * 0.5) {
          sparks.push({
            x: headX + (Math.random() - 0.5) * 24,
            y: mouthY,
            vx: (Math.random() - 0.5) * 60,
            vy: -40 - Math.random() * 90 * (0.4 + energy),
            life: 1,
          });
        }

        for (let i = sparks.length - 1; i >= 0; i--) {
          const spark = sparks[i];
          spark.x += spark.vx * 0.016;
          spark.y += spark.vy * 0.016;
          spark.vy += 42 * 0.016;
          spark.life -= 0.018;
          if (spark.life <= 0) {
            sparks.splice(i, 1);
            continue;
          }
          context.fillStyle = hexToRgba(skin.trim, spark.life * 0.85);
          context.beginPath();
          context.arc(spark.x, spark.y, 2.6 * spark.life + 0.6, 0, Math.PI * 2);
          context.fill();
        }

        // Hard cap so a long take cannot grow the array without bound.
        if (sparks.length > 220) sparks.splice(0, sparks.length - 220);

        context.globalCompositeOperation = "source-over";
      };

      frame = requestAnimationFrame(draw);
    }

    void begin();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      landmarker?.close();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [skin.accent, skin.trim]);

  return (
    <div className="camera-wrap">
      <video ref={videoRef} playsInline muted className="camera-video" />
      <canvas ref={canvasRef} className="camera-canvas" />

      {status === "denied" ? (
        <div className="camera-notice">
          Camera access was declined. Everything else still works, there is just
          nobody on screen.
        </div>
      ) : null}
      {status === "no-landmarks" ? (
        <div className="camera-notice subtle">
          Face tracking unavailable, overlay is centred.
        </div>
      ) : null}
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
