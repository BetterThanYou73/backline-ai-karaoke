"use client";

import { useState } from "react";

import { HealthBanner } from "@/components/HealthBanner";
import { ImportPanel } from "@/components/ImportPanel";
import { Masthead } from "@/components/Masthead";
import { SongLibrary } from "@/components/SongLibrary";

export default function LibraryPage() {
  // Bumped after an import so the library refetches without a full reload.
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <main className="shell">
      <Masthead tagline="Pick a song, pick a band. Then sing." />
      <HealthBanner />

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 14px" }}>Song library</h2>
        <SongLibrary refreshToken={refreshToken} />
      </section>

      <section style={{ marginTop: 28 }}>
        <ImportPanel onImported={() => setRefreshToken((value) => value + 1)} />
      </section>
    </main>
  );
}
