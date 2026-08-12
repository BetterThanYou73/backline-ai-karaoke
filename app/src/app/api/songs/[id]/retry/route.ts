import { NextResponse } from "next/server";

import { retryAnalysis, toPublicSong } from "@/lib/library";

export const dynamic = "force-dynamic";

/** Clear a stored analysis failure and queue the song again. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const song = await retryAnalysis(id);
  if (!song) {
    return NextResponse.json({ error: "unknown song" }, { status: 404 });
  }
  return NextResponse.json({ song: toPublicSong(song) });
}
