import { NextResponse } from "next/server";

import { isStyleId } from "@/lib/styles";
import { pollTrack, requestTrack } from "@/lib/tracks";

export const dynamic = "force-dynamic";

/**
 * Cache-or-generate entry point.
 *
 * POST starts (or joins) a render. GET polls one. The client only ever sees
 * "cached", "pending" or "error", so it does not need to know that a job queue
 * exists on the other side.
 */

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const songId = typeof body?.songId === "string" ? body.songId : null;
  const style = typeof body?.style === "string" ? body.style : null;

  if (!songId || !style || !isStyleId(style)) {
    return NextResponse.json(
      { error: "songId and a known style are required" },
      { status: 400 },
    );
  }

  const result = await requestTrack(songId, style);
  return NextResponse.json(result, { status: result.state === "error" ? 502 : 200 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  const songId = url.searchParams.get("songId");
  const style = url.searchParams.get("style");

  if (!jobId || !songId || !style || !isStyleId(style)) {
    return NextResponse.json(
      { error: "jobId, songId and a known style are required" },
      { status: 400 },
    );
  }

  const result = await pollTrack(jobId, songId, style);
  return NextResponse.json(result, { status: result.state === "error" ? 502 : 200 });
}
