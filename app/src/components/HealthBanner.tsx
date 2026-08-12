"use client";

import { useEffect, useState } from "react";

interface Health {
  inference: {
    stub_mode: boolean;
    cuda_available: boolean;
    vram_total_mb: number | null;
    device: string;
  } | null;
  url: string;
  error?: string;
}

/**
 * A demo that starts with a silent failure is a bad demo. The most common
 * cause by far is the inference server not being up, so say so plainly rather
 * than letting the first render attempt time out.
 */
export function HealthBanner() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => response.json())
      .then((data: Health) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!health) return null;

  if (!health.inference) {
    return (
      <div className="panel" style={{ borderColor: "var(--bad)", marginBottom: 20 }}>
        <strong>Inference server is not reachable at {health.url}.</strong>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 14 }}>
          Songs will still list, but nothing can be generated. Start it with{" "}
          <code>cd inference; .\run.ps1</code>, or point{" "}
          <code>INFERENCE_API_URL</code> at the machine that has the GPU.
        </p>
      </div>
    );
  }

  if (health.inference.stub_mode) {
    return (
      <div className="panel" style={{ borderColor: "var(--warn)", marginBottom: 20 }}>
        <strong>Running in stub mode.</strong>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 14 }}>
          Backing tracks are placeholder synth, not real generation. Tempo and
          key analysis are real. To switch on MusicGen, run{" "}
          <code>.\setup.ps1 -Gpu</code> and set <code>STUB_MODE=0</code> in{" "}
          <code>inference/.env</code>.
        </p>
      </div>
    );
  }

  if (!health.inference.cuda_available) {
    return (
      <div className="panel" style={{ borderColor: "var(--warn)", marginBottom: 20 }}>
        <strong>CUDA is not available, generation will run on CPU.</strong>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 14 }}>
          Expect several minutes per 30 second chunk instead of about a minute.
        </p>
      </div>
    );
  }

  return null;
}
