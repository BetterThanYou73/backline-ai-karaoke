import { NextResponse } from "next/server";

import { INFERENCE_API_URL } from "@/lib/config";
import * as inference from "@/lib/inference";

export const dynamic = "force-dynamic";

/**
 * Surfaced in the UI so a demo does not start with a mystery failure. The
 * common one is the inference server simply not being up yet.
 */
export async function GET() {
  try {
    const upstream = await inference.health();
    return NextResponse.json({ appServer: true, inference: upstream, url: INFERENCE_API_URL });
  } catch (error) {
    return NextResponse.json({
      appServer: true,
      inference: null,
      url: INFERENCE_API_URL,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
