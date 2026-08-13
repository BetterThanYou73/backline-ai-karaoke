"use client";

import { useCallback, useEffect, useState } from "react";

import type { Settings } from "@/lib/settings";

/**
 * Settings, reachable from every screen.
 *
 * These live here rather than in the inference server's .env because they are
 * things a person changes between two songs. Render length in particular is
 * the difference between a twenty second sketch and a five minute wait, and
 * asking someone to edit a file and restart a Python process to make that call
 * is not a real setting.
 */

const RENDER_PRESETS = [
  { value: 20, label: "20 seconds", hint: "quick sketch, good for trying styles" },
  { value: 60, label: "1 minute", hint: "a verse and a chorus" },
  { value: 90, label: "90 seconds", hint: "default" },
  { value: 0, label: "Whole song", hint: "slowest, one render can take minutes" },
];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setSettings(data.settings))
      .catch(() => undefined);
  }, []);

  // Escape closes, which people expect from anything that covers the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = useCallback(async (change: Partial<Settings>) => {
    setSettings((current) => (current ? { ...current, ...change } : current));
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      const data = await response.json();
      // Take the server's version back: it clamps, so what was stored may not
      // be exactly what was sent.
      setSettings(data.settings);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet">
        <header className="sheet-head">
          <div>
            <h2 style={{ margin: 0, fontSize: 19 }}>Settings</h2>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
              Saved as you change them. Applies to the next render.
            </p>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </header>

        {!settings ? (
          <div className="muted" style={{ padding: "24px 0" }}>
            <span className="spinner" /> Loading
          </div>
        ) : (
          <div className="sheet-body">
            <section className="setting">
              <div className="setting-label">
                <strong>Render length</strong>
                <span className="muted">
                  How much of each song gets a new instrumental. Longer sounds
                  better and takes proportionally longer, once per song and style.
                </span>
              </div>
              <div className="chip-row">
                {RENDER_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    className={
                      settings.maxRenderSeconds === preset.value ? "chip active" : "chip"
                    }
                    title={preset.hint}
                    onClick={() => void patch({ maxRenderSeconds: preset.value })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="setting">
              <div className="setting-label">
                <strong>Follow my voice</strong>
                <span className="muted">
                  Lets the backing track bend to your key and speed while you
                  sing. Turn it off to hear the track exactly as rendered.
                </span>
              </div>
              <Toggle
                checked={settings.adaptivePlayback}
                onChange={(value) => void patch({ adaptivePlayback: value })}
                label="Adaptive playback"
              />
            </section>

            {settings.adaptivePlayback ? (
              <>
                <section className="setting">
                  <div className="setting-label">
                    <strong>Key range</strong>
                    <span className="muted">
                      How far the track may move to meet you. Past about three
                      semitones it starts to sound processed.
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={6}
                    step={0.5}
                    value={settings.maxSemitones}
                    format={(v) => (v === 0 ? "locked" : `${v} semitones`)}
                    onChange={(value) => void patch({ maxSemitones: value })}
                  />
                </section>

                <section className="setting">
                  <div className="setting-label">
                    <strong>Tempo range</strong>
                    <span className="muted">
                      How far the track may speed up or slow down to stay with
                      you.
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={0.4}
                    step={0.05}
                    value={settings.maxTempoDrift}
                    format={(v) =>
                      v === 0 ? "locked" : `${Math.round(v * 100)} percent`
                    }
                    onChange={(value) => void patch({ maxTempoDrift: value })}
                  />
                </section>
              </>
            ) : null}

            <section className="setting">
              <div className="setting-label">
                <strong>Look up songs online</strong>
                <span className="muted">
                  Fetches real synced lyrics from LRCLIB instead of transcribing
                  them, which is both more accurate and better timed. Only the
                  title, artist and duration are sent. Never the audio. Off by
                  default because everything else here stays on this machine.
                </span>
              </div>
              <Toggle
                checked={settings.onlineLookup}
                onChange={(value) => void patch({ onlineLookup: value })}
                label="Look up songs online"
              />
            </section>

            <section className="setting">
              <div className="setting-label">
                <strong>Camera overlay</strong>
                <span className="muted">
                  Face tracking and reactive effects on the performance screen.
                </span>
              </div>
              <Toggle
                checked={settings.cameraOverlay}
                onChange={(value) => void patch({ cameraOverlay: value })}
                label="Camera overlay"
              />
            </section>

            <section className="setting">
              <div className="setting-label">
                <strong>Calm visuals</strong>
                <span className="muted">
                  Cuts the motion everywhere, on top of whatever your system
                  already asks for.
                </span>
              </div>
              <Toggle
                checked={settings.calmVisuals}
                onChange={(value) => void patch({ calmVisuals: value })}
                label="Calm visuals"
              />
            </section>

            <footer className="sheet-foot muted">
              {saving ? (
                <>
                  <span className="spinner" /> Saving
                </>
              ) : savedAt ? (
                "Saved"
              ) : null}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={checked ? "toggle on" : "toggle"}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function Slider({
  min,
  max,
  step,
  value,
  format,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="slider-row">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="pill">{format(value)}</span>
    </div>
  );
}
