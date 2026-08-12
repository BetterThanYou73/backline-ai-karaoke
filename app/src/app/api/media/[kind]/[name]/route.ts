import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { CACHE_DIR, IMPORTS_DIR, SONGS_DIR } from "@/lib/config";

export const dynamic = "force-dynamic";

const ROOTS: Record<string, string> = {
  track: CACHE_DIR,
  song: SONGS_DIR,
  import: IMPORTS_DIR,
};

const MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

/**
 * Streams audio out of the cache and the songs folder.
 *
 * Range support is not optional here: without it Chrome will not seek, and the
 * performance screen needs to be able to restart a take without refetching a
 * multi-megabyte wav.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; name: string }> },
) {
  const { kind, name: rawName } = await params;

  const root = ROOTS[kind];
  if (!root) {
    return NextResponse.json({ error: "unknown media kind" }, { status: 404 });
  }

  const name = decodeURIComponent(rawName);
  // Only plain file names directly inside the root. Rejects traversal and
  // absolute paths before they ever reach the filesystem.
  if (path.basename(name) !== name) {
    return NextResponse.json({ error: "invalid file name" }, { status: 400 });
  }

  const filePath = path.join(root, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    return NextResponse.json({ error: "invalid file name" }, { status: 400 });
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const contentType = MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.get("range");

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;

      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start > end ||
        start >= stat.size
      ) {
        return new NextResponse(null, {
          status: 416,
          headers: { "content-range": `bytes */${stat.size}` },
        });
      }

      const clampedEnd = Math.min(end, stat.size - 1);
      const stream = fs.createReadStream(resolved, { start, end: clampedEnd });

      return new NextResponse(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          "content-type": contentType,
          "content-length": String(clampedEnd - start + 1),
          "content-range": `bytes ${start}-${clampedEnd}/${stat.size}`,
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=3600",
        },
      });
    }
  }

  const stream = fs.createReadStream(resolved);
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(stat.size),
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=3600",
    },
  });
}
