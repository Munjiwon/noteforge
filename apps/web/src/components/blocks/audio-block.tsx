"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";

type RecState = "idle" | "recording" | "uploading";

export const AudioBlock = createReactBlockSpec(
  {
    type: "audio",
    propSchema: {
      url: { default: "" },
      name: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const url = (block.props.url as string) ?? "";
      const name = (block.props.name as string) ?? "";
      const [state, setState] = useState<RecState>("idle");
      const [elapsed, setElapsed] = useState(0);
      const recRef = useRef<MediaRecorder | null>(null);
      const chunksRef = useRef<BlobPart[]>([]);
      const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
      const fileRef = useRef<HTMLInputElement>(null);

      useEffect(
        () => () => {
          if (timerRef.current) clearInterval(timerRef.current);
          recRef.current?.stream.getTracks().forEach((t) => t.stop());
        },
        [],
      );

      async function setAudio(blob: Blob, filename: string) {
        setState("uploading");
        try {
          const fd = new FormData();
          fd.append("file", blob, filename);
          const res = await fetch("/api/upload", { method: "POST", body: fd });
          if (!res.ok) throw new Error(await res.text());
          const data = (await res.json()) as { url: string; name: string };
          editor.updateBlock(block, {
            props: {
              ...(block.props as Record<string, unknown>),
              url: data.url,
              name: data.name,
            },
          } as never);
        } catch (e) {
          console.warn("audio upload failed", e);
          alert("Upload failed: " + (e as Error).message);
        } finally {
          setState("idle");
        }
      }

      async function startRecording() {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const rec = new MediaRecorder(stream);
          recRef.current = rec;
          chunksRef.current = [];
          rec.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
          };
          rec.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            if (timerRef.current) clearInterval(timerRef.current);
            const blob = new Blob(chunksRef.current, { type: "audio/webm" });
            await setAudio(blob, `voice-${Date.now()}.webm`);
          };
          rec.start();
          setState("recording");
          setElapsed(0);
          timerRef.current = setInterval(
            () => setElapsed((s) => s + 1),
            1000,
          );
        } catch (e) {
          alert("Microphone access denied: " + (e as Error).message);
          setState("idle");
        }
      }

      function stopRecording() {
        recRef.current?.stop();
      }

      if (url) {
        return (
          <div className="w-full border border-gray-200 rounded-md p-3 my-1 flex items-center gap-3 bg-gray-50">
            <span className="text-xl">🎵</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-600 truncate mb-1">
                {name || "Audio clip"}
              </div>
              <audio controls src={url} className="w-full max-w-md" />
            </div>
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                editor.updateBlock(block, {
                  props: {
                    ...(block.props as Record<string, unknown>),
                    url: "",
                    name: "",
                  },
                } as never);
              }}
              className="text-xs text-gray-500 hover:text-red-600 px-2"
            >
              Replace
            </button>
          </div>
        );
      }

      return (
        <div className="w-full border border-gray-200 rounded-md p-3 my-1 bg-gray-50">
          <div className="text-[10px] uppercase text-gray-500 mb-2">Audio</div>
          {state === "recording" ? (
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-sm text-red-600">
                <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                Recording · {formatTime(elapsed)}
              </span>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  stopRecording();
                }}
                className="text-xs px-3 py-1 rounded bg-gray-900 text-white hover:opacity-90"
              >
                Stop
              </button>
            </div>
          ) : state === "uploading" ? (
            <div className="text-sm text-gray-500">Uploading…</div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  startRecording();
                }}
                className="text-xs px-3 py-1 rounded bg-gray-900 text-white hover:opacity-90 inline-flex items-center gap-1"
              >
                🎤 Record
              </button>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  fileRef.current?.click();
                }}
                className="text-xs px-3 py-1 rounded border border-gray-200 hover:bg-black/5"
              >
                Upload file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) await setAudio(f, f.name);
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </div>
      );
    },
  },
);

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
