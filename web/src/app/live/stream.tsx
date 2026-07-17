"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

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
  l2: string | null;
  l3: string | null;
  salience: number | null;
  learnedAt: string | null; // opened at least once → chip dims
  lastSeenAt: string; // latest sighting → board ordering
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
  importance: number | null;
  translated: boolean; // false → translation in flight (typing indicator)
  annotations: LiveAnnotation[];
};

// A rollup card standing in for a collapsed stretch of the stream.
export type LiveDigest = {
  id: number;
  sessionId: number;
  fromMessageId: number;
  toMessageId: number;
  fromTs: string;
  toTs: string;
  messageCount: number;
  summary: string;
};

const HIGHLIGHT_THRESHOLD = 0.7;

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

export type Calibration = "new" | "amateur" | "expert";

const CALIBRATION_LABELS: [Calibration, string][] = [
  ["new", "new to this"],
  ["amateur", "technical amateur"],
  ["expert", "expert"],
];

// /live, chips first. The primary surface is the term board: picked
// keywords/initials/domain terms grouped by domain, bright until opened —
// what the agent's work is teaching you, not what the agent said. A slim
// strip shows the latest agent activity; the full subtitle/original stream
// (with digests and highlights) is the secondary view behind a toggle.
// Data comes from GET /api/bootstrap + the SSE stream, all client-side, so
// the static GitHub Pages build works against a remote API.
export default function LiveStream() {
  const [view, setView] = useState<"board" | "stream">("board");
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [digests, setDigests] = useState<LiveDigest[]>([]);
  const [terms, setTerms] = useState<LiveTerm[]>([]);
  const [freshTermIds, setFreshTermIds] = useState<Set<number>>(new Set());
  const [highlights, setHighlights] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [showOriginals, setShowOriginals] = useState(false);
  const [calibration, setCalibration] = useState<Calibration>("new");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(api("/api/bootstrap"));
        if (!res.ok) throw new Error(`bootstrap failed (${res.status})`);
        const data = await res.json();
        if (cancelled) return;
        // SSE may already have delivered rows; keep whichever arrived first.
        setMessages((live) => {
          const seen = new Set<number>(
            data.messages.map((m: LiveMessage) => m.id),
          );
          return [
            ...data.messages,
            ...live.filter((m: LiveMessage) => !seen.has(m.id)),
          ];
        });
        setTerms((live) => {
          const seen = new Set<number>(data.terms.map((t: LiveTerm) => t.id));
          return [...data.terms, ...live.filter((t) => !seen.has(t.id))];
        });
        setDigests((live) => {
          const seen = new Set<number>(
            data.digests.map((d: LiveDigest) => d.id),
          );
          return [...data.digests, ...live.filter((d) => !seen.has(d.id))];
        });
        setCalibration(data.calibration);
      } catch (err) {
        if (!cancelled) setLoadError(String(err));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Global toggle: ⌘J / ctrl-J flips subtitles ⇄ originals everywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setShowOriginals((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function changeCalibration(level: Calibration) {
    setCalibration(level);
    await fetch(api("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calibration: level }),
    }).catch(() => {});
  }

  // Cache lazily fetched L2/L3 so a term opens instantly the next time.
  function cacheExpansion(termId: number, l2: string, l3: string) {
    setTerms((prev) =>
      prev.map((t) => (t.id === termId ? { ...t, l2, l3 } : t)),
    );
  }

  // Opening a card = the user looked at it: dim the chip, persist server-side.
  function markLearned(termId: number) {
    setTerms((prev) =>
      prev.map((t) =>
        t.id === termId && !t.learnedAt
          ? { ...t, learnedAt: new Date().toISOString() }
          : t,
      ),
    );
    fetch(api(`/api/terms/${termId}/learned`), { method: "POST" }).catch(
      () => {},
    );
  }
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(api("/api/stream"));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "message") {
        const m: LiveMessage = {
          ...event.message,
          importance: null,
          translated: false,
          annotations: [],
        };
        setMessages((prev) =>
          prev.some((p) => p.id === m.id) ? prev : [...prev, m],
        );
      } else if (event.type === "digest") {
        // A stretch of the stream just rolled up: swap those messages for the card.
        const d: LiveDigest = event.digest;
        setDigests((prev) =>
          prev.some((p) => p.id === d.id)
            ? prev
            : [...prev, d].sort((a, b) => a.fromMessageId - b.fromMessageId),
        );
        setMessages((prev) =>
          prev.filter(
            (m) =>
              m.sessionId !== d.sessionId ||
              m.id < d.fromMessageId ||
              m.id > d.toMessageId,
          ),
        );
      } else if (event.type === "translation") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  subtitle: event.subtitle,
                  importance: event.importance,
                  translated: true,
                  annotations: event.annotations,
                }
              : m,
          ),
        );
        const now = new Date().toISOString();
        if (event.newTerms.length > 0) {
          setTerms((prev) => {
            const seen = new Set(prev.map((t) => t.id));
            const fresh = event.newTerms
              .filter((t: LiveTerm) => !seen.has(t.id))
              .map((t: LiveTerm) => ({
                ...t,
                l2: t.l2 ?? null,
                l3: t.l3 ?? null,
                learnedAt: null,
                lastSeenAt: now,
              }));
            return [...prev, ...fresh];
          });
          setFreshTermIds((prev) => {
            const next = new Set(prev);
            for (const t of event.newTerms) next.add(t.id);
            return next;
          });
        }
        // Existing terms sighted again in this message bubble up the board.
        const sighted = new Set<number>(
          (event.annotations ?? [])
            .map((a: LiveAnnotation) => a.termId)
            .filter((x: number | null) => x !== null),
        );
        if (sighted.size > 0) {
          setTerms((prev) =>
            prev.map((t) =>
              sighted.has(t.id) ? { ...t, lastSeenAt: now } : t,
            ),
          );
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
        <span className="ml-auto flex items-center gap-2">
          <span className="flex overflow-hidden rounded-md border border-neutral-700 text-xs">
            <button
              onClick={() => setView("board")}
              className={`px-2 py-1 transition-colors ${view === "board" ? "bg-amber-300/15 text-amber-100" : "text-neutral-400 hover:text-neutral-100"}`}
            >
              terms
            </button>
            <button
              onClick={() => setView("stream")}
              className={`px-2 py-1 transition-colors ${view === "stream" ? "bg-amber-300/15 text-amber-100" : "text-neutral-400 hover:text-neutral-100"}`}
            >
              stream
            </button>
          </span>
          <Link
            href="/wiki"
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100"
          >
            wiki
          </Link>
          {view === "stream" && (
            <>
              <button
                onClick={() => setHighlights((v) => !v)}
                title="only decisions, outcomes, and failures"
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  highlights
                    ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200"
                    : "border-neutral-700 text-neutral-400 hover:text-neutral-100"
                }`}
              >
                ★
              </button>
              <button
                onClick={() => setShowOriginals((v) => !v)}
                title="toggle subtitles ⇄ originals (⌘J)"
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  showOriginals
                    ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                    : "border-neutral-700 text-neutral-400 hover:text-neutral-100"
                }`}
              >
                {showOriginals ? "orig" : "sub"}
              </button>
            </>
          )}
          <select
            value={calibration}
            onChange={(e) => changeCalibration(e.target.value as Calibration)}
            title="explain like I'm…"
            className="rounded-md border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs text-neutral-400"
          >
            {CALIBRATION_LABELS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </span>
      </header>

      {view === "board" ? (
        <>
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto max-w-2xl">
              {terms.length === 0 && (
                <p className="mt-24 text-center text-neutral-500">
                  {!loaded ? (
                    "loading…"
                  ) : loadError ? (
                    <>couldn&apos;t reach the unjargon API — {loadError}</>
                  ) : (
                    <>
                      No terms yet — as your agents work, the jargon they use
                      lands here, already explained.
                      <code className="mt-2 block text-sm text-neutral-400">
                        unjargond replay fixtures/session.jsonl
                      </code>
                    </>
                  )}
                </p>
              )}
              <ChipBoard
                terms={terms}
                freshTermIds={freshTermIds}
                onExpanded={cacheExpansion}
                onLearned={markLearned}
              />
            </div>
          </div>
          <LatestStrip message={latest} onOpenStream={() => setView("stream")} />
        </>
      ) : (
        <>
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto px-4 py-6"
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-7">
              {messages.length === 0 && digests.length === 0 && (
                <p className="mt-24 text-center text-neutral-500">
                  {!loaded ? (
                    "loading…"
                  ) : loadError ? (
                    <>couldn&apos;t reach the unjargon API — {loadError}</>
                  ) : (
                    <>
                      Waiting for agent messages… start a collector:
                      <code className="mt-2 block text-sm text-neutral-400">
                        unjargond replay fixtures/session.jsonl
                      </code>
                    </>
                  )}
                </p>
              )}
              {digests.map((d) => (
                <DigestCard
                  key={`d${d.id}`}
                  digest={d}
                  termsById={termsById}
                  showOriginal={showOriginals}
                  onTermExpanded={cacheExpansion}
                  onTermLearned={markLearned}
                />
              ))}
              {messages
                .filter(
                  (m) =>
                    !highlights ||
                    (m.translated &&
                      m.subtitle !== null &&
                      (m.importance ?? 0) >= HIGHLIGHT_THRESHOLD),
                )
                .map((m) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    termsById={termsById}
                    showOriginal={showOriginals}
                    onTermExpanded={cacheExpansion}
                    onTermLearned={markLearned}
                  />
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
        </>
      )}

    </main>
  );
}

function rangeOf(d: LiveDigest): string {
  const from = new Date(d.fromTs);
  const to = new Date(d.toTs);
  const sameDay = from.toDateString() === to.toDateString();
  const day = (x: Date) =>
    x.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const hm = (x: Date) =>
    x.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? `${day(from)} ${hm(from)} – ${hm(to)}`
    : `${day(from)} ${hm(from)} – ${day(to)} ${hm(to)}`;
}

// A collapsed stretch of the stream: a rollup summary standing in for
// messageCount messages. Expanding fetches and shows the real subtitles —
// a digest is a collapse, never a substitute.
function DigestCard({
  digest: d,
  termsById,
  showOriginal,
  onTermExpanded,
  onTermLearned,
}: {
  digest: LiveDigest;
  termsById: Map<number, LiveTerm>;
  showOriginal: boolean;
  onTermExpanded: (termId: number, l2: string, l3: string) => void;
  onTermLearned: (termId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [inner, setInner] = useState<LiveMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && inner === null) {
      try {
        const res = await fetch(api(`/api/digests/${d.id}/messages`));
        if (!res.ok) throw new Error(`fetch failed (${res.status})`);
        const data = await res.json();
        setInner(data.messages);
      } catch (err) {
        setError(String(err));
      }
    }
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/50">
      <button onClick={toggle} className="w-full px-4 py-3 text-left">
        <p className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
          {rangeOf(d)} · {d.messageCount} updates {expanded ? "▾" : "▸"}
        </p>
        <p className="text-base leading-relaxed text-neutral-200">{d.summary}</p>
      </button>
      {expanded && (
        <div className="flex flex-col gap-6 border-t border-neutral-800 px-4 py-4">
          {error && (
            <p className="text-sm text-red-400/90">couldn&apos;t load — {error}</p>
          )}
          {inner === null && !error && (
            <p className="text-sm text-neutral-500">loading…</p>
          )}
          {inner?.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              termsById={termsById}
              showOriginal={showOriginal}
              onTermExpanded={onTermExpanded}
              onTermLearned={onTermLearned}
            />
          ))}
        </div>
      )}
    </section>
  );
}

const MAX_CHIPS = 4;

function MessageRow({
  message: m,
  termsById,
  showOriginal,
  onTermExpanded,
  onTermLearned,
}: {
  message: LiveMessage;
  termsById: Map<number, LiveTerm>;
  showOriginal: boolean;
  onTermExpanded: (termId: number, l2: string, l3: string) => void;
  onTermLearned: (termId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [activeTermId, setActiveTermId] = useState<number | null>(null);
  const hasSubtitle = m.subtitle !== null;

  // The picked terms for this message: keywords/initials/domain terms the
  // extraction flagged, most salient first.
  const picked = useMemo(() => {
    const ids = [...new Set(m.annotations.map((a) => a.termId))].filter(
      (id): id is number => id !== null,
    );
    return ids
      .map((id) => termsById.get(id))
      .filter((t): t is LiveTerm => !!t)
      .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
      .slice(0, MAX_CHIPS);
  }, [m.annotations, termsById]);

  const activeTerm =
    activeTermId !== null ? (termsById.get(activeTermId) ?? null) : null;

  const termLayer = (
    <>
      {picked.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {picked.map((t) => (
            <button
              key={t.id}
              onClick={() =>
                setActiveTermId((cur) => (cur === t.id ? null : t.id))
              }
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                activeTermId === t.id
                  ? "border-amber-300/50 bg-amber-300/15 text-amber-100"
                  : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
              }`}
            >
              {t.term}
            </button>
          ))}
        </div>
      )}
      {activeTerm && (
        <InlineTermCard
          key={activeTerm.id}
          term={activeTerm}
          messageId={m.id}
          onClose={() => setActiveTermId(null)}
          onExpanded={onTermExpanded}
          onLearned={onTermLearned}
        />
      )}
    </>
  );

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
        ) : showOriginal ? (
          // Global ⌘J mode: the verbatim original, highlights still tappable.
          <div>
            <AnnotatedOriginal
              text={m.text}
              annotations={m.annotations}
              termsById={termsById}
              onOpenTerm={setActiveTermId}
              bare
            />
            {termLayer}
          </div>
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
                onOpenTerm={setActiveTermId}
              />
            )}
            {termLayer}
          </div>
        )}
      </div>
    </article>
  );
}

// The term card, two stages. Collapsed: just the picked term and its
// one-line explanation. Opened: the long in-context explanation (grounded in
// this message), with the general background beneath — lazily generated and
// cached the first time anyone opens it.
function InlineTermCard({
  term,
  messageId,
  onClose,
  onExpanded,
  onLearned,
}: {
  term: LiveTerm;
  messageId?: number; // omitted → L3 grounds in the term's latest sighting
  onClose: () => void;
  onExpanded: (termId: number, l2: string, l3: string) => void;
  onLearned: (termId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLong = !!term.l2 && !!term.l3;

  async function toggleLong() {
    const next = !open;
    setOpen(next);
    setError(null);
    if (next) onLearned(term.id);
    if (next && !hasLong && !loading) {
      setLoading(true);
      try {
        const res = await fetch(api(`/api/terms/${term.id}/expand`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId }),
        });
        if (!res.ok) throw new Error(`expand failed (${res.status})`);
        const data = await res.json();
        onExpanded(term.id, data.l2, data.l3);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-neutral-800 bg-neutral-900/70">
      {/* collapsed: the keyword + the short explanation */}
      <button onClick={toggleLong} className="w-full px-3 py-2.5 text-left">
        <p className="text-sm leading-relaxed">
          <span className="font-semibold">{term.term}</span>
          <span className="ml-2 text-xs text-neutral-500">{term.domain}</span>
        </p>
        <p className="mt-0.5 text-sm leading-relaxed text-neutral-300">
          {term.l1}
        </p>
        {!open && (
          <p className="mt-1 text-xs text-neutral-500">in this context ▸</p>
        )}
      </button>
      {/* opened: the long, in-context explanation */}
      {open && (
        <div className="border-t border-neutral-800 px-3 py-2.5 text-sm leading-relaxed">
          {error ? (
            <p className="text-red-400/90">couldn&apos;t load — {error}</p>
          ) : !hasLong ? (
            <div className="animate-pulse space-y-2" aria-label="loading">
              <div className="h-3 w-full rounded bg-neutral-800" />
              <div className="h-3 w-5/6 rounded bg-neutral-800" />
            </div>
          ) : (
            <>
              <p className="text-neutral-100">{term.l3}</p>
              <p className="mt-2 text-neutral-400">{term.l2}</p>
            </>
          )}
          <button
            onClick={onClose}
            className="mt-2 text-xs text-neutral-500 hover:text-neutral-300"
          >
            close ✕
          </button>
        </div>
      )}
    </div>
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
  onOpenTerm,
  bare = false,
}: {
  text: string;
  annotations: LiveAnnotation[];
  termsById: Map<number, LiveTerm>;
  onOpenTerm: (termId: number) => void;
  bare?: boolean; // ⌘J mode: no box/label, body-size text
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
    <div
      className={
        bare ? "" : "mt-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3"
      }
    >
      {!bare && (
        <p className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
          original
        </p>
      )}
      <p
        className={`whitespace-pre-wrap leading-relaxed text-neutral-300 ${bare ? "text-lg" : "text-sm"}`}
      >
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
            <button
              onClick={() => onOpenTerm(activeTerm.id)}
              className="mt-1 block text-xs text-neutral-400 hover:text-neutral-200"
            >
              {activeTerm.term} ▸
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The primary surface: every picked keyword/initial/domain term, grouped by
// domain, freshest domains first. Bright = not yet opened; dimmed = learned.
// Tap a chip → collapsed card (term + one-liner); open → long in-context
// explanation grounded in the term's latest sighting.
function ChipBoard({
  terms,
  freshTermIds,
  onExpanded,
  onLearned,
}: {
  terms: LiveTerm[];
  freshTermIds: Set<number>;
  onExpanded: (termId: number, l2: string, l3: string) => void;
  onLearned: (termId: number) => void;
}) {
  const [activeTermId, setActiveTermId] = useState<number | null>(null);

  const groups = useMemo(() => {
    const byDomain = new Map<string, LiveTerm[]>();
    for (const t of terms) {
      byDomain.set(t.domain, [...(byDomain.get(t.domain) ?? []), t]);
    }
    const out = [...byDomain.entries()].map(([domain, list]) => {
      list.sort(
        (a, b) =>
          b.lastSeenAt.localeCompare(a.lastSeenAt) ||
          (b.salience ?? 0) - (a.salience ?? 0),
      );
      return { domain, list, newest: list[0].lastSeenAt };
    });
    out.sort((a, b) => b.newest.localeCompare(a.newest));
    return out;
  }, [terms]);

  const active =
    activeTermId !== null
      ? (terms.find((t) => t.id === activeTermId) ?? null)
      : null;

  return (
    <div className="flex flex-col gap-6">
      {groups.map(({ domain, list }) => {
        const fresh = list.filter(
          (t) => freshTermIds.has(t.id) && !t.learnedAt,
        ).length;
        return (
          <section key={domain}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
              {domain}
              {fresh > 0 && (
                <span className="ml-2 rounded-full bg-amber-300/15 px-1.5 py-0.5 font-normal normal-case tracking-normal text-amber-200">
                  {fresh} new
                </span>
              )}
            </h2>
            <div className="flex flex-wrap gap-2">
              {list.map((t) => (
                <button
                  key={t.id}
                  onClick={() =>
                    setActiveTermId((cur) => (cur === t.id ? null : t.id))
                  }
                  className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    activeTermId === t.id
                      ? "border-amber-300/60 bg-amber-300/20 text-amber-100"
                      : t.learnedAt
                        ? "border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
                        : "border-amber-300/30 bg-amber-300/5 text-amber-100/90 hover:bg-amber-300/15"
                  }`}
                >
                  {t.term}
                  {freshTermIds.has(t.id) && !t.learnedAt && (
                    <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-300 align-middle" />
                  )}
                </button>
              ))}
            </div>
            {active && active.domain === domain && (
              <InlineTermCard
                key={active.id}
                term={active}
                onClose={() => setActiveTermId(null)}
                onExpanded={onExpanded}
                onLearned={onLearned}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

// Glanceable agent status — the one place the stream surfaces on the board.
function LatestStrip({
  message: m,
  onOpenStream,
}: {
  message: LiveMessage | undefined;
  onOpenStream: () => void;
}) {
  if (!m) return null;
  return (
    <button
      onClick={onOpenStream}
      className="flex items-center gap-3 border-t border-neutral-800 px-4 py-2.5 text-left hover:bg-neutral-900/60"
      title="open the full stream"
    >
      <time className="shrink-0 font-mono text-xs text-neutral-500">
        {timeOf(m.ts)}
      </time>
      {!m.translated ? (
        <span className="flex min-w-0 items-center gap-2 text-sm text-neutral-500">
          <span className="truncate">{m.text}</span>
          <TypingDots />
        </span>
      ) : (
        <span className="min-w-0 truncate text-sm text-neutral-400">
          {m.subtitle ?? m.text}
        </span>
      )}
      <span className="ml-auto shrink-0 text-xs text-neutral-500">
        stream ▸
      </span>
    </button>
  );
}
