"use client";

import Link from "next/link";
import { useState } from "react";

import { SettingsPanel } from "@/components/SettingsPanel";

export function Masthead({ tagline }: { tagline?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            <Link href="/">
              Back<span>line</span>
            </Link>
          </h1>
          <p className="tagline">{tagline ?? "Sing, and the band follows you."}</p>
        </div>

        <button
          className="icon-btn"
          onClick={() => setOpen(true)}
          aria-label="Settings"
          title="Settings"
        >
          {/* Gear drawn as a hub plus eight radial teeth, so it stays crisp at
              this size instead of relying on one fiddly hand-written path. */}
          <svg viewBox="-12 -12 24 24" width="20" height="20" aria-hidden="true">
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle r="4.2" />
              {Array.from({ length: 8 }, (_, i) => (
                <line
                  key={i}
                  x1="0"
                  y1="-7"
                  x2="0"
                  y2="-9.6"
                  transform={`rotate(${i * 45})`}
                />
              ))}
            </g>
          </svg>
        </button>
      </header>

      {open ? <SettingsPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}
