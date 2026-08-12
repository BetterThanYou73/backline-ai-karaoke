"use client";

import { useEffect } from "react";

import type { StyleSkin } from "@/lib/styles";

/**
 * Paints a skin's palette onto the document.
 *
 * Without this every screen was the same grey no matter which band you picked,
 * which made the six styles feel like a dropdown rather than six places. The
 * accent, the room light and the panel tints all come from the chosen skin, so
 * walking into the jazz stage actually looks like walking into a different
 * room.
 *
 * Applied at document level rather than through a wrapper element because the
 * ambient light is painted on body, and a scoped class cannot reach it.
 */
export function SkinProvider({ skin }: { skin: StyleSkin | null }) {
  useEffect(() => {
    const root = document.documentElement;

    // Remember what was there so leaving a stage restores the house palette
    // instead of leaking jazz brown onto the library.
    const previous = {
      accent: root.style.getPropertyValue("--accent"),
      near: root.style.getPropertyValue("--stage-near"),
      far: root.style.getPropertyValue("--stage-far"),
      raised: root.style.getPropertyValue("--bg-raised"),
      line: root.style.getPropertyValue("--line"),
    };

    if (skin) {
      root.style.setProperty("--accent", skin.accent);
      root.style.setProperty("--stage-near", skin.gradient[0]);
      root.style.setProperty("--stage-far", skin.gradient[1]);
      // Nudge the surfaces toward the skin rather than replacing them, so
      // contrast against the text stays where it was.
      root.style.setProperty(
        "--bg-raised",
        `color-mix(in srgb, ${skin.gradient[0]} 34%, #120d1c)`,
      );
      root.style.setProperty(
        "--line",
        `color-mix(in srgb, ${skin.accent} 22%, #2a2038)`,
      );
    }

    return () => {
      root.style.setProperty("--accent", previous.accent || "#ff4ecd");
      root.style.setProperty("--stage-near", previous.near || "#1b0736");
      root.style.setProperty("--stage-far", previous.far || "#08111f");
      root.style.setProperty("--bg-raised", previous.raised || "#151021");
      root.style.setProperty("--line", previous.line || "#2a2038");
    };
  }, [skin]);

  return null;
}

/**
 * Mirrors the calm visuals setting onto the body, where the ambient layer and
 * the global animation override can see it.
 */
export function CalmVisuals() {
  useEffect(() => {
    let cancelled = false;

    fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          document.body.dataset.calm = String(Boolean(data.settings?.calmVisuals));
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
