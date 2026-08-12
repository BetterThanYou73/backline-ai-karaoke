"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { BacklineCrew } from "@/components/BacklineCrew";
import { SkinProvider } from "@/components/SkinProvider";
import { STYLES, STYLE_IDS } from "@/lib/styles";
import type { StyleId } from "@/lib/types";

/**
 * Screen two. Each card previews the skin it will put on stage, so the choice
 * is made on the look as much as the genre name.
 *
 * Hovering a card repaints the whole page in that skin. It costs nothing and
 * it turns picking a style from reading a list into looking around a room,
 * which is the difference between six options and six places.
 */
export function StylePicker({ songId }: { songId: string }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<StyleId | null>(null);
  const [previewing, setPreviewing] = useState<StyleId | null>(null);
  const [time, setTime] = useState(0);

  // One shared clock for every preview, rather than six independent loops.
  useEffect(() => {
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      setTime((performance.now() - started) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const active = chosen ?? previewing;

  return (
    <>
      <SkinProvider skin={active ? STYLES[active] : null} />
      <ul
        className="style-grid"
        onMouseLeave={() => setPreviewing(null)}
      >
      {STYLE_IDS.map((id, index) => {
        const skin = STYLES[id];
        return (
          <li key={id}>
            <button
              className={active === id ? "style-card active" : "style-card"}
              disabled={chosen !== null}
              style={{ borderColor: active === id ? skin.accent : undefined }}
              onMouseEnter={() => setPreviewing(id)}
              onFocus={() => setPreviewing(id)}
              onClick={() => {
                setChosen(id);
                router.push(`/perform/${songId}/${id}`);
              }}
            >
              <BacklineCrew
                skin={skin}
                className="style-card-art"
                energy={0.3}
                accuracy={0.55}
                // Stagger so the six previews are not in lockstep.
                time={time + index * 0.7}
              />
              <div className="style-card-body">
                <span className="style-card-name" style={{ color: skin.accent }}>
                  {skin.label}
                </span>
                <span className="style-card-blurb">{skin.blurb}</span>
                <div className="style-card-tags">
                  <span className="pill">{skin.genre}</span>
                  <span className="pill">{skin.vibe}</span>
                  {chosen === id ? <span className="pill good">Loading</span> : null}
                </div>
              </div>
            </button>
          </li>
        );
      })}
      </ul>
    </>
  );
}
