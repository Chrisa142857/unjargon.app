"use client";

import { useEffect, useRef, useState } from "react";

export type LiveMessage = {
  id: number;
  sessionId: number;
  device: string;
  tool: string;
  cwd: string | null;
  ts: string;
  text: string;
  subtitle: string | null;
};

function timeOf(ts: string) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function projectOf(cwd: string | null) {
  if (!cwd) return null;
  return cwd.split("/").filter(Boolean).pop() ?? null;
}

// The Unjargon Stream. Walking-skeleton version: renders raw agent text;
// step 3 swaps the body for subtitles with ▸ expansion.
export default function LiveStream({ initial }: { initial: LiveMessage[] }) {
  const [messages, setMessages] = useState<LiveMessage[]>(initial);
  const [connected, setConnected] = useState(false);
  const [pinned, setPinned] = useState(true); // auto-scroll pinned to newest
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type !== "message") return;
      setMessages((prev) =>
        prev.some((m) => m.id === event.message.id)
          ? prev
          : [...prev, event.message],
      );
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pinned]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  const latest = messages[messages.length - 1];

  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3 text-sm">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-400" : "bg-neutral-600"}`}
          title={connected ? "live" : "disconnected"}
        />
        <span className="font-semibold tracking-tight">unjargon</span>
        {latest && (
          <span className="truncate text-neutral-400">
            {latest.device} · {latest.tool}
            {projectOf(latest.cwd) ? ` — ${projectOf(latest.cwd)}` : ""}
          </span>
        )}
      </header>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 py-6"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {messages.length === 0 && (
            <p className="mt-24 text-center text-neutral-500">
              Waiting for agent messages… start a collector:
              <code className="mt-2 block text-sm text-neutral-400">
                unjargond replay fixtures/session.jsonl
              </code>
            </p>
          )}
          {messages.map((m) => (
            <article key={m.id} className="flex gap-4">
              <time className="mt-0.5 shrink-0 font-mono text-xs text-neutral-500">
                {timeOf(m.ts)}
              </time>
              <p className="whitespace-pre-wrap text-lg leading-relaxed">
                {m.subtitle ?? m.text}
              </p>
            </article>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </main>
  );
}
