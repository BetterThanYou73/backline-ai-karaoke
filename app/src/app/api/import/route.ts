import fsp from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { AUDIO_EXTENSIONS, IMPORTS_DIR } from "@/lib/config";
import { runAnalysisQueue, scanLibrary } from "@/lib/library";

export const dynamic = "force-dynamic";

// Generous but finite. A five minute wav is around 50 MB; anything much past
// this is not a song someone intends to sing along to.
const MAX_BYTES = 120 * 1024 * 1024;

/**
 * Import screen upload. The file lands in data/imports and is picked up by the
 * same scanner that watches data/songs, so imports and built-in tracks share
 * one code path from here on.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "expected a file field" }, { status: 400 });
  }

  const extension = path.extname(file.name).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    return NextResponse.json(
      {
        error: `unsupported file type ${extension || "(none)"}. Accepted: ${[
          ...AUDIO_EXTENSIONS,
        ].join(", ")}`,
      },
      { status: 415 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file is ${(file.size / 1024 / 1024).toFixed(0)} MB, limit is 120 MB` },
      { status: 413 },
    );
  }

  await fsp.mkdir(IMPORTS_DIR, { recursive: true });

  // Keep the user's name so the library reads sensibly, but strip anything
  // that could escape the imports folder or confuse the scanner.
  const safeName =
    path
      .basename(file.name)
      .replace(/[^\w\s.-]+/g, "")
      .replace(/\s+/g, " ")
      .trim() || `import${extension}`;

  // An earlier version prefixed a timestamp to guarantee uniqueness, which put
  // "mgk1frl - " in front of every import. The library reads "Artist - Title"
  // off the file name, so every imported song ended up by an artist called
  // something like mgk1frl. Only disambiguate when there is a real collision,
  // and do it with a suffix, where the parser will not see it as a name.
  const stem = path.basename(safeName, extension);
  let fileName = safeName;
  for (let attempt = 2; attempt < 500; attempt++) {
    try {
      await fsp.access(path.join(IMPORTS_DIR, fileName));
      fileName = `${stem} (${attempt})${extension}`;
    } catch {
      break;
    }
  }

  await fsp.writeFile(
    path.join(IMPORTS_DIR, fileName),
    Buffer.from(await file.arrayBuffer()),
  );

  const songs = await scanLibrary();
  const created = songs.find((song) => song.file === fileName);

  // Analysis runs in the background; the client polls the song list for bpm.
  void runAnalysisQueue();

  return NextResponse.json({
    songId: created?.id ?? null,
    file: fileName,
  });
}
