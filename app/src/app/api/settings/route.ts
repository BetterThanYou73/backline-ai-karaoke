import { NextResponse } from "next/server";

import { SETTINGS_LIMITS, getSettings, saveSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ settings: getSettings(), limits: SETTINGS_LIMITS });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "expected a settings object" }, { status: 400 });
  }

  // saveSettings coerces and clamps, so an out of range value is corrected
  // rather than rejected. The response carries what was actually stored.
  return NextResponse.json({ settings: saveSettings(body), limits: SETTINGS_LIMITS });
}
