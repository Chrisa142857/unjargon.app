"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type LiveAnnotation = {
  id: number;
  span: string;
  sentenceRewrite: string;
  termId: number | null;
};

export type LiveTerm = {
  id: number;
  term: string;
  domain: string;
  l1: string;
  salience: number | null;
};

export type LiveMessage = {
  id: number;
  sessionId: number;
  device: string;
  tool: string;
  cwd: string | null;
  ts: string;
  text: string;
  subtitle: string | null;
  translated: boolean; // false → translation in flight (typing indicator)
  annotations: LiveAnnotation[];
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

// The Unjargon Stream: subtitles by default, ▸ expands the annotated
// original, highlighted spans tap to a sentence-level rewrite.
export default function LiveStream({
  initialMessages,
  initialTerms,
}: {
  initialMessages: LiveMessage[];
  initialTerms: LiveTerm[];
}) {
  const [messages, setMessages] = useState<LiveMessage[]>(initialMessages);
  const [terms, setTerms] = useState<LiveTerm[]>(initialTerms);
  const [connected, setConnected] = useState(false);
  const [pinned, setPinned] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "message") {
        const m: LiveMessage = {
          ...event.message,
          translated: false,
          annotations: [],
        };
        setMessages((prev) =>
          prev.some((p) => p.id === m.id) ? prev : [...prev, m],
        );
      } else if (event.type === "translation") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  subtitle: event.subtitle,
                  translated: true,
                  annotations: event.annotations,
                }
              : m,
          ),
        );
        if (event.newTerms.length > 0) {
          setTerms((prev) => {
            const seen = new Set(prev.map((t) => t.id));
            return [...prev, ...event.newTerms.filter((t: LiveTerm) => !seen.has(t.id))];
          });
        }
      }
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

  const termsById = useMemo(
    () => new Map(terms.map((t) => [t.id, t])),
    [terms],
  );
  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of terms) counts.set(t.domain, (counts.get(t.domain) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [terms]);

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
        <div className="mx-auto flex max-w-2xl flex-col gap-7">
          {messages.length === 0 && (
            <p className="mt-24 text-center text-neutral-500">
              Waiting for agent messages… start a collector:
              <code className="mt-2 block text-sm text-neutral-400">
                unjargond replay fixtures/session.jsonl
              </code>
            </p>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} termsById={termsById} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {domains.length > 0 && (
        <footer className="flex items-center gap-2 overflow-x-auto border-t border-neutral-800 px-4 py-2 text-xs text-neutral-400">
          {domains.map(([domain, count]) => (
            <span
              key={domain}
              className="whitespace-nowrap rounded-full border border-neutral-700 px-2.5 py-1"
            >
              {domain} · {count}
            </span>
          ))}
          <span className="ml-auto whitespace-nowrap pl-2 text-neutral-500">
            {terms.length} terms
          </span>
        </footer>
      )}
    </main>
  );
}

function MessageRow({
  message: m,
  termsById,
}: {
  message: LiveMessage;
  termsById: Map<number, LiveTerm>;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSubtitle = m.subtitle !== null;

  return (
    <article className="flex gap-4">
      <time className="mt-1 shrink-0 font-mono text-xs text-neutral-500">
        {timeOf(m.ts)}
      </time>
      <div className="min-w-0 flex-1">
        {!m.translated ? (
          // Translation in flight: raw text dimmed + typing indicator.
          <div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-500">
              {m.text}
            </p>
            <TypingDots />
          </div>
        ) : !hasSubtitle ? (
          // Trivial message: passthrough, untranslated by design.
          <p className="whitespace-pre-wrap text-lg leading-relaxed text-neutral-300">
            {m.text}
          </p>
        ) : (
          <div>
            <p className="whitespace-pre-wrap text-lg leading-relaxed">
              {m.subtitle}
              <button
                onClick={() => setExpanded((v) => !v)}
                className="ml-2 inline-block align-baseline text-neutral-500 transition-colors hover:text-neutral-200"
                title={expanded ? "hide original" : "show original"}
              >
                {expanded ? "▾" : "▸"}
              </button>
            </p>
            {expanded && (
              <AnnotatedOriginal
                text={m.text}
                annotations={m.annotations}
                termsById={termsById}
              />
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function TypingDots() {
  return (
    <span className="mt-1 inline-flex gap-1" aria-label="translating">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:300ms]" />
    </span>
  );
}

// The agent's verbatim text with jargon spans highlighted; tapping a
// highlight shows the plain-language rewrite of that sentence (the full
// L1/L2/L3 term card is the next layer down, step 4).
function AnnotatedOriginal({
  text,
  annotations,
  termsById,
}: {
  text: string;
  annotations: LiveAnnotation[];
  termsById: Map<number, LiveTerm>;
}) {
  const [activeId, setActiveId] = useState<number | null>(null);

  const segments = useMemo(() => {
    // Locate each span's first occurrence; drop overlaps.
    const located = annotations
      .map((a) => ({ a, start: text.indexOf(a.span) }))
      .filter((x) => x.start >= 0)
      .sort((x, y) => x.start - y.start);
    const out: ({ kind: "text"; value: string } | { kind: "ann"; value: string; a: LiveAnnotation })[] = [];
    let pos = 0;
    for (const { a, start } of located) {
      if (start < pos) continue;
      if (start > pos) out.push({ kind: "text", value: text.slice(pos, start) });
      out.push({ kind: "ann", value: a.span, a });
      pos = start + a.span.length;
    }
    if (pos < text.length) out.push({ kind: "text", value: text.slice(pos) });
    return out;
  }, [text, annotations]);

  const active = annotations.find((a) => a.id === activeId) ?? null;
  const activeTerm = active?.termId ? termsById.get(active.termId) : null;

  return (
    <div className="mt-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <p className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
        original
      </p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">
        {segments.map((s, i) =>
          s.kind === "text" ? (
            <span key={i}>{s.value}</span>
          ) : (
            <button
              key={i}
              onClick={() =>
                setActiveId((cur) => (cur === s.a.id ? null : s.a.id))
              }
              className={`rounded px-0.5 font-medium transition-colors ${
                activeId === s.a.id
                  ? "bg-amber-300/30 text-amber-100"
                  : "bg-amber-300/10 text-amber-200/90 hover:bg-amber-300/20"
              }`}
            >
              {s.value}
            </button>
          ),
        )}
      </p>
      {active && (
        <div className="mt-2 rounded-md border border-amber-300/20 bg-amber-300/5 p-2.5 text-sm leading-relaxed text-amber-50/90">
          {active.sentenceRewrite}
          {activeTerm && (
            <p className="mt-1.5 text-xs text-neutral-400">
              <span className="font-semibold text-neutral-300">
                {activeTerm.term}
              </span>{" "}
              — {activeTerm.l1}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
