"use client";

import { useRef, useState } from "react";

type State =
  | { kind: "idle" }
  | { kind: "uploading"; name: string }
  | { kind: "done"; name: string }
  | { kind: "error"; message: string };

export function ImportPanel({ onImported }: { onImported: () => void }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setState({ kind: "uploading", name: file.name });

    const form = new FormData();
    form.append("file", file);

    try {
      const response = await fetch("/api/import", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `upload failed (${response.status})`);

      setState({ kind: "done", name: file.name });
      onImported();
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="panel import-panel">
      <div>
        <strong>Import your own track</strong>
        <p className="muted" style={{ fontSize: 14, margin: "6px 0 0", lineHeight: 1.6 }}>
          It gets analysed for tempo and key, re-rendered into whichever style
          you pick, and transcribed for lyrics. Everything stays on this machine.
        </p>
      </div>

      <div className="import-actions">
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg,.opus"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          className="btn"
          disabled={state.kind === "uploading"}
          onClick={() => inputRef.current?.click()}
        >
          {state.kind === "uploading" ? (
            <>
              <span className="spinner" /> Uploading
            </>
          ) : (
            "Choose a file"
          )}
        </button>

        {state.kind === "done" ? (
          <span className="pill good">Added {state.name}</span>
        ) : null}
        {state.kind === "error" ? (
          <span className="pill bad">{state.message}</span>
        ) : null}
      </div>
    </div>
  );
}
