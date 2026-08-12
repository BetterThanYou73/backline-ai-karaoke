import { NextResponse } from "next/server";

import { listSongs, toPublicSong } from "@/lib/library";

export const dynamic = "force-dynamic";

export async function GET() {
  const songs = await listSongs();
  return NextResponse.json({ songs: songs.map(toPublicSong) });
}
