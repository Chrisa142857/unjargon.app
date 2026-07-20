"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, apiBase, apiBaseIsBuiltIn, bounceToApiOrigin, setApiBase } from "@/lib/api";
import type { ClientStreamEvent } from "@/lib/bus";
import AccountMenu from "@/app/account-menu";

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
  kind: string; // "term" | "initial"
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
  detected: boolean;
  annotations: LiveAnnotation[];
};

type ImportProgress = {
  messages: number;
  detected: number;
  ratePerHour: number; // detections finished in the last hour
  sessions: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  lastImportedAt: string | null;
};

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/Chrisa142857/unjargon.app/main/install.sh | sh -s -- --server https://unjargon.onrender.com";

// Every domain gets a stable color identity — chips are the product surface,
// so they carry the visual weight. Class strings are complete literals so
// Tailwind's scanner picks them up.
type DomainColor = {
  accent: string; // colored text (term on tile, header)
  caption: string; // dimmer colored caption
  tile: string; // unlearned tile surface
  tileActive: string; // selected tile
  dot: string;
  bar: string; // card accent bar
};

const DOMAIN_PALETTE: DomainColor[] = [
  {
    accent: "text-amber-100",
    caption: "text-amber-200/70",
    tile: "border-amber-200/20 bg-gradient-to-br from-amber-300/[0.14] via-amber-300/[0.04] to-transparent hover:border-amber-200/40",
    tileActive: "border-amber-200/60 bg-gradient-to-br from-amber-300/25 via-amber-300/10 to-transparent shadow-[0_0_30px_rgba(252,211,77,0.15)]",
    dot: "bg-amber-300",
    bar: "bg-amber-300/70",
  },
  {
    accent: "text-sky-100",
    caption: "text-sky-200/70",
    tile: "border-sky-200/20 bg-gradient-to-br from-sky-300/[0.14] via-sky-300/[0.04] to-transparent hover:border-sky-200/40",
    tileActive: "border-sky-200/60 bg-gradient-to-br from-sky-300/25 via-sky-300/10 to-transparent shadow-[0_0_30px_rgba(125,211,252,0.15)]",
    dot: "bg-sky-300",
    bar: "bg-sky-300/70",
  },
  {
    accent: "text-emerald-100",
    caption: "text-emerald-200/70",
    tile: "border-emerald-200/20 bg-gradient-to-br from-emerald-300/[0.14] via-emerald-300/[0.04] to-transparent hover:border-emerald-200/40",
    tileActive: "border-emerald-200/60 bg-gradient-to-br from-emerald-300/25 via-emerald-300/10 to-transparent shadow-[0_0_30px_rgba(110,231,183,0.15)]",
    dot: "bg-emerald-300",
    bar: "bg-emerald-300/70",
  },
  {
    accent: "text-violet-100",
    caption: "text-violet-200/70",
    tile: "border-violet-200/20 bg-gradient-to-br from-violet-300/[0.14] via-violet-300/[0.04] to-transparent hover:border-violet-200/40",
    tileActive: "border-violet-200/60 bg-gradient-to-br from-violet-300/25 via-violet-300/10 to-transparent shadow-[0_0_30px_rgba(196,181,253,0.15)]",
    dot: "bg-violet-300",
    bar: "bg-violet-300/70",
  },
  {
    accent: "text-rose-100",
    caption: "text-rose-200/70",
    tile: "border-rose-200/20 bg-gradient-to-br from-rose-300/[0.14] via-rose-300/[0.04] to-transparent hover:border-rose-200/40",
    tileActive: "border-rose-200/60 bg-gradient-to-br from-rose-300/25 via-rose-300/10 to-transparent shadow-[0_0_30px_rgba(253,164,175,0.15)]",
    dot: "bg-rose-300",
    bar: "bg-rose-300/70",
  },
  {
    accent: "text-cyan-100",
    caption: "text-cyan-200/70",
    tile: "border-cyan-200/20 bg-gradient-to-br from-cyan-300/[0.14] via-cyan-300/[0.04] to-transparent hover:border-cyan-200/40",
    tileActive: "border-cyan-200/60 bg-gradient-to-br from-cyan-300/25 via-cyan-300/10 to-transparent shadow-[0_0_30px_rgba(103,232,249,0.15)]",
    dot: "bg-cyan-300",
    bar: "bg-cyan-300/70",
  },
  {
    accent: "text-lime-100",
    caption: "text-lime-200/70",
    tile: "border-lime-200/20 bg-gradient-to-br from-lime-300/[0.14] via-lime-300/[0.04] to-transparent hover:border-lime-200/40",
    tileActive: "border-lime-200/60 bg-gradient-to-br from-lime-300/25 via-lime-300/10 to-transparent shadow-[0_0_30px_rgba(190,242,100,0.15)]",
    dot: "bg-lime-300",
    bar: "bg-lime-300/70",
  },
  {
    accent: "text-orange-100",
    caption: "text-orange-200/70",
    tile: "border-orange-200/20 bg-gradient-to-br from-orange-300/[0.14] via-orange-300/[0.04] to-transparent hover:border-orange-200/40",
    tileActive: "border-orange-200/60 bg-gradient-to-br from-orange-300/25 via-orange-300/10 to-transparent shadow-[0_0_30px_rgba(253,186,116,0.15)]",
    dot: "bg-orange-300",
    bar: "bg-orange-300/70",
  },
];

function domainColor(domain: string): DomainColor {
  let h = 0;
  for (let i = 0; i < domain.length; i++) {
    h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  }
  return DOMAIN_PALETTE[h % DOMAIN_PALETTE.length];
}

function timeOf(ts: string) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "today" / "yesterday" / "Tue, Jul 15" — day buckets for the time-sorted wall.
function dayLabelOf(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

// Compact axis label: "today" / "yest" / "Jul 13".
function shortDay(day: string): string {
  if (day === "today") return "today";
  if (day === "yesterday") return "yest";
  const parts = day.split(", ");
  return parts.length > 1 ? parts.slice(1).join(" ") : day;
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

function InstallCollectorCallout() {
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

  async function createPairingCode() {
    setPairingError(null);
    const res = await fetch(api("/api/devices/pair"), { method: "POST" });
    if (!res.ok) return setPairingError("Could not create a pairing code. Please try again.");
    setPairingCode((await res.json()).code);
  }

  return (
    <div className="mx-auto mt-20 max-w-2xl rounded-xl border border-amber-200/20 bg-amber-300/[0.06] px-6 py-7 text-center shadow-[0_0_45px_rgba(252,211,77,0.06)]">
      <p className="text-base font-medium text-amber-100">Connect an AI agent</p>
      <p className="mt-2 text-sm text-neutral-400">
        Run this on the macOS or Linux machine where Claude Code or Codex works.
        First create a pairing code below; the installer securely prompts for it.
      </p>
      <code className="mt-5 block overflow-x-auto rounded-lg border border-white/[0.08] bg-neutral-950 px-4 py-3 text-left text-xs text-neutral-200">
        {INSTALL_COMMAND}
      </code>
      <button onClick={createPairingCode} className="mt-4 rounded-md bg-amber-200 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-100">
        {pairingCode ? "Make a new pairing code" : "Create pairing code"}
      </button>
      {pairingCode && <p className="mt-3 text-sm text-amber-100">Pairing code: <code className="select-all font-semibold">{pairingCode}</code> <span className="text-neutral-400">(expires in 10 minutes)</span></p>}
      {pairingError && <p className="mt-3 text-sm text-rose-300">{pairingError}</p>}
    </div>
  );
}

// Rough remaining-work label from the measured completion rate; never claims
// more precision than an hourly count supports.
function etaLabel(pendingHours: number): string {
  if (pendingHours < 1) return `~${Math.max(5, Math.round((pendingHours * 60) / 5) * 5)} min`;
  if (pendingHours < 48) return `~${Math.round(pendingHours)} h`;
  return `~${Math.round(pendingHours / 24)} days`;
}

function ImportProgressCard({ progress }: { progress: ImportProgress }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const pending = Math.max(0, progress.messages - progress.detected);
  const receiving =
    progress.lastImportedAt !== null &&
    now - Date.parse(progress.lastImportedAt) < 60_000;
  if (progress.messages === 0 || (pending === 0 && !receiving)) return null;

  const pct = Math.floor((progress.detected / progress.messages) * 100);
  // ETA from the measured completion rate — never from upload recency.
  const eta =
    pending > 0 && progress.ratePerHour > 0
      ? etaLabel(pending / progress.ratePerHour)
      : null;
  const range = progress.firstMessageAt && progress.lastMessageAt
    ? `${dayLabelOf(progress.firstMessageAt)} → ${dayLabelOf(progress.lastMessageAt)}`
    : null;
  let status: string;
  if (pending === 0) {
    status = "All caught up — receiving new updates now.";
  } else if (eta) {
    status = `${eta} until jargon detection finishes, at the current pace.`;
  } else {
    status = "Finding jargon in your history — raw messages are already browsable.";
  }

  return (
    <section aria-live="polite" className="mb-6 rounded-xl border border-sky-200/20 bg-sky-300/[0.06] p-5 text-left shadow-[0_0_45px_rgba(125,211,252,0.05)]">
      <div className="flex items-center gap-2 text-sm font-medium text-sky-100">
        <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-300/60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-300" /></span>
        {pending > 0 ? "Finding jargon in your history" : "Importing agent history"}
        {pending > 0 && <span className="ml-auto text-xs font-normal text-sky-200/80">{progress.detected.toLocaleString()} / {progress.messages.toLocaleString()}</span>}
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-sky-100/10">
        {pending > 0
          ? <div className="h-full rounded-full bg-sky-300 transition-[width] duration-700" style={{ width: `${Math.max(2, pct)}%` }} />
          : <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-300" />}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-neutral-300">
        <span><strong className="text-white">{progress.messages.toLocaleString()}</strong> updates received</span>
        <span><strong className="text-white">{progress.detected.toLocaleString()}</strong> checked</span>
        <span><strong className="text-white">{progress.sessions.toLocaleString()}</strong> sessions found</span>
        {range && <span>{range}</span>}
      </div>
      <p className="mt-3 text-xs text-neutral-500">{status}</p>
    </section>
  );
}

// /live, chips first. The primary surface is the term board: picked
// domain terms and acronyms grouped by domain, bright until opened —
// what the agent's work is teaching you, not what the agent said. A slim
// strip shows the latest agent activity; the raw stream is secondary.
// Data comes from GET /api/bootstrap + the SSE stream, all client-side, so
// the static GitHub Pages build works against a remote API.
export default function LiveStream() {
  const [view, setView] = useState<"board" | "stream">("board");
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [terms, setTerms] = useState<LiveTerm[]>([]);
  const [freshTermIds, setFreshTermIds] = useState<Set<number>>(new Set());
  const knownTermIds = useRef<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [calibration, setCalibration] = useState<Calibration>("new");
  const [progress, setProgress] = useState<ImportProgress>({ messages: 0, detected: 0, ratePerHour: 0, sessions: 0, firstMessageAt: null, lastMessageAt: null, lastImportedAt: null });

  useEffect(() => {
    if (bounceToApiOrigin("/live")) return; // static build → the app runs on the backend
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(api("/api/bootstrap"));
        if (res.status === 401) {
          window.location.assign(api("/api/auth/google"));
          return;
        }
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
        for (const term of data.terms) knownTermIds.current.add(term.id);
        setTerms((live) => {
          const seen = new Set<number>(data.terms.map((t: LiveTerm) => t.id));
          return [...data.terms, ...live.filter((t) => !seen.has(t.id))];
        });
        setCalibration(data.calibration);
        setProgress(data.progress);
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

  async function changeCalibration(level: Calibration) {
    setCalibration(level);
    await fetch(api("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calibration: level }),
    }).catch(() => {});
  }

  // Cache lazily fetched L2/L3 so a term opens instantly the next time.
  function cacheExpansion(termId: number, l2: string | null, l3: string | null) {
    setTerms((prev) =>
      prev.map((t) =>
        t.id === termId ? { ...t, l2: l2 ?? t.l2, l3: l3 ?? t.l3 } : t,
      ),
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
  // Bootstrap supplies a one-hour rate, but a fresh import starts at zero.
  // Keep a tiny local sample so its ETA appears as soon as SSE makes progress.
  const liveDetection = useRef({ startedAt: 0, count: 0 });

  useEffect(() => {
    const es = new EventSource(api("/api/stream"));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const event: ClientStreamEvent = JSON.parse(e.data);
      if (event.type === "message") {
        const m: LiveMessage = {
          ...event.message,
          detected: false,
          annotations: [],
        };
        setMessages((prev) =>
          prev.some((p) => p.id === m.id) ? prev : [...prev, m],
        );
        setProgress((p) => ({
          ...p,
          messages: p.messages + 1,
          lastMessageAt: m.ts,
          lastImportedAt: new Date().toISOString(),
        }));
      } else if (event.type === "detection") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  detected: true,
                  annotations: event.annotations,
                }
              : m,
          ),
        );
        // The server publishes exactly one detection event per message. The
        // first-import rate begins at zero, so measure this live sample too.
        const tick = Date.now();
        if (liveDetection.current.count === 0) liveDetection.current.startedAt = tick;
        liveDetection.current.count += 1;
        const ratePerHour = Math.round(
          (liveDetection.current.count * 3_600_000) /
            Math.max(5_000, tick - liveDetection.current.startedAt),
        );
        setProgress((p) => ({ ...p, detected: p.detected + 1, ratePerHour }));
        const now = new Date().toISOString();
        const freshTerms = event.newTerms.filter((t) => !knownTermIds.current.has(t.id));
        if (freshTerms.length > 0) {
          for (const term of freshTerms) knownTermIds.current.add(term.id);
          setTerms((prev) => {
            const seen = new Set(prev.map((t) => t.id));
            const fresh = freshTerms
              .filter((t) => !seen.has(t.id))
              .map((t) => ({
                id: t.id,
                term: t.term,
                domain: t.domain,
                kind: t.kind,
                l1: t.l1,
                l2: null,
                l3: null,
                salience: t.salience,
                learnedAt: null,
                lastSeenAt: now,
              }));
            return [...prev, ...fresh];
          });
          setFreshTermIds((prev) => {
            const next = new Set(prev);
            for (const t of freshTerms) next.add(t.id);
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
    <main className="relative flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      {/* ambient glow — depth without noise */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(55%_45%_at_12%_-5%,rgba(252,211,77,0.06),transparent),radial-gradient(45%_40%_at_105%_105%,rgba(125,211,252,0.05),transparent)]"
      />
      <header className="relative z-10 flex items-center gap-2 border-b border-white/[0.06] bg-neutral-950/80 px-4 py-3 text-sm backdrop-blur">
        <span className="relative flex h-2.5 w-2.5">
          {connected && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
          )}
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-400" : "bg-neutral-600"}`}
            title={connected ? "live" : "disconnected"}
          />
        </span>
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
          <AccountMenu />
          <select
            value={calibration}
            onChange={(e) => changeCalibration(e.target.value as Calibration)}
            title="in-session explanation style"
            aria-label="in-session explanation style"
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
          <div className="relative z-10 flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto max-w-2xl">
              <ImportProgressCard progress={progress} />
              {terms.length === 0 && (
                <div className="text-center text-neutral-500">
                  {!loaded ? (
                    "loading…"
                  ) : loadError ? (
                    <>
                      <p>couldn&apos;t reach the unjargon API — {loadError}</p>
                      <BackendPrompt />
                    </>
                  ) : messages.length === 0 ? (
                    <InstallCollectorCallout />
                  ) : (
                    <>
                      No terms yet — unjargon is checking your history for
                      technical language.
                      <code className="mt-2 block text-sm text-neutral-400">
                        unjargond replay fixtures/session.jsonl
                      </code>
                    </>
                  )}
                </div>
              )}
              <ChipBoard
                terms={terms}
                freshTermIds={freshTermIds}
                onExpanded={cacheExpansion}
                onLearned={markLearned}
              />
            </div>
          </div>
          <div className="relative z-10">
            <LatestStrip message={latest} onOpenStream={() => setView("stream")} />
          </div>
        </>
      ) : (
        <>
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="relative z-10 flex-1 overflow-y-auto px-4 py-6"
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-7">
              <ImportProgressCard progress={progress} />
              {messages.length === 0 && (
                <div className="mt-24 text-center text-neutral-500">
                  {!loaded ? (
                    "loading…"
                  ) : loadError ? (
                    <>couldn&apos;t reach the unjargon API — {loadError}</>
                  ) : (
                    <InstallCollectorCallout />
                  )}
                </div>
              )}
              {messages.map((m) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    termsById={termsById}
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

const MAX_CHIPS = 4;

function MessageRow({
  message: m,
  termsById,
  onTermExpanded,
  onTermLearned,
}: {
  message: LiveMessage;
  termsById: Map<number, LiveTerm>;
  onTermExpanded: (termId: number, l2: string | null, l3: string | null) => void;
  onTermLearned: (termId: number) => void;
}) {
  const [activeTermId, setActiveTermId] = useState<number | null>(null);

  // The picked terms for this message, most salient first.
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
                  ? `${domainColor(t.domain).tileActive} ${domainColor(t.domain).accent}`
                  : t.learnedAt
                    ? "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                    : `${domainColor(t.domain).tile} ${domainColor(t.domain).accent}`
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
        <AnnotatedOriginal
          text={m.text}
          annotations={m.annotations}
          termsById={termsById}
          onOpenTerm={setActiveTermId}
          bare
        />
        {!m.detected && <p className="mt-1 text-xs text-neutral-600">checking for jargon…</p>}
        {termLayer}
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
  onExpanded: (termId: number, l2: string | null, l3: string | null) => void;
  onLearned: (termId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [grounding, setGrounding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // On a no-key server the work is queued for the user's own collector; the
  // card polls while any layer is pending so the text appears when delivered.
  const [pending, setPending] = useState({ concept: false, grounding: false });

  async function refresh() {
    try {
      const res = await fetch(api(`/api/terms/${term.id}/expand`));
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `expand failed (${res.status})`);
      setPending(data.pending ?? { concept: false, grounding: false });
      onExpanded(term.id, data.l2, data.l3);
    } catch (err) {
      setError(String(err));
    }
  }

  // Poll through a ref so the interval survives parent re-renders (SSE churn)
  // without depending on this render's expand identity.
  const pollRef = useRef<() => void>(() => {});
  useEffect(() => {
    pollRef.current = () => {
      refresh();
    };
  });
  useEffect(() => {
    if (!open || (!pending.concept && !pending.grounding)) return;
    const timer = window.setInterval(() => pollRef.current(), 5000);
    return () => window.clearInterval(timer);
  }, [open, pending.concept, pending.grounding]);

  async function requestExplanation(action: "concept" | "grounding") {
    try {
      const res = await fetch(api(`/api/terms/${term.id}/expand`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `expand failed (${res.status})`);
      setPending(data.pending ?? { concept: false, grounding: false });
      onExpanded(term.id, data.l2, data.l3);
    } catch (err) {
      setError(String(err));
    }
  }

  // Opening a card only reveals detector output. AI is always an explicit
  // button press below, never a side effect of reading a term.
  async function toggleLong() {
    const next = !open;
    setOpen(next);
    setError(null);
    if (next) onLearned(term.id);
  }

  async function loadConcept() {
    if (loading) return;
    setLoading(true);
    setError(null);
    await requestExplanation("concept");
    setLoading(false);
  }

  async function loadGrounding() {
    if (grounding) return;
    setGrounding(true);
    setError(null);
    await requestExplanation("grounding");
    setGrounding(false);
  }

  const c = domainColor(term.domain);
  return (
    <div className="mt-2 flex overflow-hidden rounded-xl border border-white/10 bg-neutral-900/80 backdrop-blur">
      <div className={`w-1 shrink-0 ${c.bar}`} />
      <div className="min-w-0 flex-1">
        {/* collapsed: the detected term + detector note */}
        <button onClick={toggleLong} className="w-full px-3.5 py-3 text-left">
          <p className="text-sm leading-relaxed">
            <span className={`font-semibold ${c.accent}`}>{term.term}</span>
            <span className={`ml-2 text-xs ${c.caption}`}>{term.domain}</span>
          </p>
          <p className="mt-0.5 text-sm leading-relaxed text-neutral-300">
            {term.l1}
          </p>
          {!open && <p className="mt-1 text-xs text-neutral-500">more ▸</p>}
        </button>
        {/* opened: detector result, then explicitly requested AI layers */}
        {open && (
          <div className="border-t border-white/[0.06] px-3.5 py-3 text-sm leading-relaxed">
            {error && <p className="text-red-400/90">couldn&apos;t load — {error}</p>}
            {loading ? (
              <div className="animate-pulse space-y-2" aria-label="loading">
                <div className="h-3 w-full rounded bg-neutral-800" />
                <div className="h-3 w-5/6 rounded bg-neutral-800" />
              </div>
            ) : term.l2 ? (
              <p className="text-neutral-200">{term.l2}</p>
            ) : pending.concept ? (
              <p className="animate-pulse text-neutral-500">queued — a connected collector is explaining this…</p>
            ) : !error ? (
              <button
                onClick={loadConcept}
                className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100"
                title="asks your configured AI for a generic explanation — costs one AI call"
              >
                explain what this means · 1 AI call
              </button>
            ) : null}
            {term.l3 ? (
              <div className="mt-3 border-t border-white/[0.06] pt-2">
                <p className="text-[10px] uppercase tracking-widest text-neutral-500">in your sessions</p>
                <p className="mt-1 text-neutral-100">{term.l3}</p>
              </div>
            ) : grounding ? (
              <div className="mt-3 animate-pulse space-y-2" aria-label="loading in-context">
                <div className="h-3 w-full rounded bg-neutral-800" />
                <div className="h-3 w-4/6 rounded bg-neutral-800" />
              </div>
            ) : pending.grounding ? (
              <p className="mt-3 animate-pulse text-xs text-neutral-500">queued — a connected collector will explain this in your context…</p>
            ) : (
              <button
                onClick={loadGrounding}
                className="mt-3 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100"
                title="reads this term's message from your stream and explains it in your context — costs one AI call"
              >
                explain in my sessions · 1 AI call
              </button>
            )}
            <button
              onClick={onClose}
              className="mt-2 block text-xs text-neutral-500 hover:text-neutral-300"
            >
              close ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// The agent's verbatim text with jargon spans highlighted; tapping a
// highlight opens the detected term (the full explanation is opt-in).
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
  bare?: boolean; // no box/label, body-size text
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

// The primary surface: the term wall. Newest unlearned terms lead as hero
// tiles carrying their detector note; the rest are compact tiles; learned
// terms recede to small pills at the end. AI explanation is always opt-in.
function ChipBoard({
  terms,
  freshTermIds,
  onExpanded,
  onLearned,
}: {
  terms: LiveTerm[];
  freshTermIds: Set<number>;
  onExpanded: (termId: number, l2: string | null, l3: string | null) => void;
  onLearned: (termId: number) => void;
}) {
  const [activeTermId, setActiveTermId] = useState<number | null>(null);
  const [sort, setSort] = useState<"time" | "domain">("time");
  const [kindFilter, setKindFilter] = useState<"all" | "term" | "initial">("all");

  const byTime = useMemo(
    () =>
      [...terms]
        .filter((t) => kindFilter === "all" || t.kind === kindFilter)
        .sort(
          (a, b) =>
            b.lastSeenAt.localeCompare(a.lastSeenAt) ||
            (b.salience ?? 0) - (a.salience ?? 0),
        ),
    [terms, kindFilter],
  );

  const groups = useMemo(() => {
    const byDomain = new Map<string, LiveTerm[]>();
    for (const t of byTime) {
      byDomain.set(t.domain, [...(byDomain.get(t.domain) ?? []), t]);
    }
    const out = [...byDomain.entries()].map(([domain, list]) => ({
      domain,
      list,
      newest: list[0].lastSeenAt,
    }));
    out.sort((a, b) => b.newest.localeCompare(a.newest));
    return out;
  }, [byTime]);

  const active =
    activeTermId !== null
      ? (terms.find((t) => t.id === activeTermId) ?? null)
      : null;
  const learnedCount = terms.filter((t) => t.learnedAt).length;

  // Time-sorted rows with day-divider flags, precomputed so render stays pure.
  const timeRows = useMemo(() => {
    const unlearned = byTime.filter((t) => !t.learnedAt);
    return unlearned.map((t, i) => {
      const day = dayLabelOf(t.lastSeenAt);
      const divider =
        i === 0 || day !== dayLabelOf(unlearned[i - 1].lastSeenAt);
      return { t, day, divider };
    });
  }, [byTime]);

  // The time axis: one entry per day on the wall; tapping jumps to that
  // day's divider, and the section currently in view is highlighted.
  const days = useMemo(
    () => timeRows.filter((r) => r.divider).map((r) => r.day),
    [timeRows],
  );
  const dividerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // During a tap-to-jump smooth scroll, intermediate dividers cross the
  // observer band; ignore them so the tapped day keeps the highlight.
  const suppressObserverUntil = useRef(0);
  const [currentDay, setCurrentDay] = useState<string | null>(null);

  useEffect(() => {
    if (sort !== "time" || days.length < 2) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (Date.now() < suppressObserverUntil.current) return;
        for (const e of entries) {
          if (e.isIntersecting) {
            setCurrentDay((e.target as HTMLElement).dataset.day ?? null);
          }
        }
      },
      // A divider counts as "current" while it sits in the top quarter.
      { rootMargin: "0px 0px -75% 0px" },
    );
    dividerRefs.current.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sort, days]);

  const card = (t: LiveTerm) => (
    <div className="col-span-2">
      <InlineTermCard
        key={t.id}
        term={t}
        onClose={() => setActiveTermId(null)}
        onExpanded={onExpanded}
        onLearned={onLearned}
      />
    </div>
  );

  const tile = (t: LiveTerm, hero: boolean) => {
    const c = domainColor(t.domain);
    const isActive = activeTermId === t.id;
    const fresh = freshTermIds.has(t.id) && !t.learnedAt;
    return (
      <button
        key={t.id}
        onClick={() => setActiveTermId((cur) => (cur === t.id ? null : t.id))}
        className={`rounded-2xl border p-4 text-left transition-all duration-150 hover:-translate-y-0.5 active:translate-y-0 ${
          hero ? "col-span-2" : "col-span-1"
        } ${fresh ? "animate-[chip-in_0.35s_ease-out]" : ""} ${
          isActive ? c.tileActive : c.tile
        }`}
      >
        <p
          className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] ${c.caption}`}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${c.dot}`} />
          <span className="truncate">{t.domain}</span>
          <span className="ml-auto shrink-0 font-mono normal-case tracking-normal text-neutral-500">
            {timeOf(t.lastSeenAt)}
          </span>
          {fresh && (
            <span className={`inline-block h-2 w-2 shrink-0 animate-pulse rounded-full ${c.dot}`} />
          )}
        </p>
        <p
          className={`mt-1.5 font-semibold tracking-tight ${c.accent} ${hero ? "text-2xl" : "text-lg"}`}
        >
          {t.term}
        </p>
        {hero && (
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-neutral-400">
            {t.l1}
          </p>
        )}
      </button>
    );
  };

  const learnedPill = (t: LiveTerm) => (
    <button
      key={t.id}
      title={`${t.domain} · learned`}
      onClick={() => setActiveTermId((cur) => (cur === t.id ? null : t.id))}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        activeTermId === t.id
          ? "border-neutral-500 bg-neutral-800 text-neutral-200"
          : "border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
      }`}
    >
      {t.term}
    </button>
  );

  const KIND_LABELS: ["all" | "term" | "initial", string][] = [
    ["all", "all"],
    ["term", "terms"],
    ["initial", "initials"],
  ];

  const kindBar = (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      {KIND_LABELS.map(([k, label]) => {
        const n =
          k === "all"
            ? terms.length
            : terms.filter((t) => t.kind === k).length;
        return (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            disabled={n === 0}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
              kindFilter === k
                ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                : "border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
            }`}
          >
            {label}
            <span className="ml-1 text-neutral-600">{n}</span>
          </button>
        );
      })}
    </div>
  );

  const header = (
    <div className="mb-5 flex items-end justify-between gap-3">
      <div>
        <p className="text-sm text-neutral-400">
          <span className="font-semibold text-neutral-100">
            {terms.length - learnedCount}
          </span>{" "}
          to learn · {learnedCount} learned
        </p>
        <div className="mt-1.5 h-1 w-36 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-300/80 to-emerald-300/80 transition-all duration-500"
            style={{
              width: `${terms.length ? Math.round((learnedCount / terms.length) * 100) : 0}%`,
            }}
          />
        </div>
      </div>
      <span className="flex shrink-0 overflow-hidden rounded-md border border-neutral-800 text-xs">
        {(["time", "domain"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className={`px-2 py-1 transition-colors ${sort === s ? "bg-neutral-800 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"}`}
          >
            {s === "time" ? "newest" : "by domain"}
          </button>
        ))}
      </span>
    </div>
  );

  if (terms.length === 0) return null;

  if (sort === "time") {
    const learned = byTime.filter((t) => t.learnedAt);
    const showAxis = days.length > 1;
    return (
      <div className={showAxis ? "pr-9" : ""}>
        {showAxis && (
          <nav
            aria-label="jump to a day"
            className="fixed right-1.5 top-1/2 z-20 flex max-h-[70vh] -translate-y-1/2 flex-col items-stretch gap-0.5 overflow-y-auto rounded-xl border border-white/[0.06] bg-neutral-900/80 px-1 py-1.5 backdrop-blur"
          >
            {days.map((d) => (
              <button
                key={d}
                onClick={() => {
                  // Optimistic: the bottom-most day may not reach the top
                  // band, so the observer alone would never highlight it.
                  suppressObserverUntil.current = Date.now() + 1000;
                  setCurrentDay(d);
                  dividerRefs.current
                    .get(d)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={`rounded-md px-1.5 py-1 text-right text-[9px] uppercase leading-tight tracking-wide transition-colors ${
                  currentDay === d
                    ? "bg-neutral-800 font-semibold text-amber-200"
                    : "text-neutral-500 hover:text-neutral-200"
                }`}
              >
                {shortDay(d)}
              </button>
            ))}
          </nav>
        )}
        {header}
        {kindBar}
        {timeRows.length === 0 && (
          <p className="py-10 text-center text-sm text-neutral-500">
            no {kindFilter === "all" ? "terms" : `${kindFilter}s`} yet.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {timeRows.map(({ t, day, divider }, i) => (
            <Fragment key={t.id}>
              {divider && (
                <div
                  data-day={day}
                  ref={(el) => {
                    if (el) dividerRefs.current.set(day, el);
                    else dividerRefs.current.delete(day);
                  }}
                  className="col-span-2 mt-1 flex scroll-mt-2 items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500 first:mt-0"
                >
                  {day}
                  <span className="h-px flex-1 bg-white/5" />
                </div>
              )}
              {tile(t, i < 2)}
              {active?.id === t.id && card(t)}
            </Fragment>
          ))}
        </div>
        {learned.length > 0 && (
          <div className="mt-8">
            <h3 className="mb-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-600">
              learned
            </h3>
            <div className="flex flex-wrap gap-2">{learned.map(learnedPill)}</div>
            {active?.learnedAt && (
              <InlineTermCard
                key={active.id}
                term={active}
                onClose={() => setActiveTermId(null)}
                onExpanded={onExpanded}
                onLearned={onLearned}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {header}
      {kindBar}
      <div className="flex flex-col gap-8">
        {groups.map(({ domain, list }) => {
          const c = domainColor(domain);
          return (
            <section key={domain}>
              <h2
                className={`mb-2.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] ${c.caption}`}
              >
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${c.dot}`} />
                {domain}
              </h2>
              <div className="grid grid-cols-2 gap-3">
                {list
                  .filter((t) => !t.learnedAt)
                  .map((t) => (
                    <Fragment key={t.id}>
                      {tile(t, false)}
                      {active?.id === t.id && card(t)}
                    </Fragment>
                  ))}
              </div>
              {list.some((t) => t.learnedAt) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {list.filter((t) => t.learnedAt).map(learnedPill)}
                </div>
              )}
              {active?.learnedAt && active.domain === domain && (
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
      <span className="min-w-0 truncate text-sm text-neutral-400">{m.text}</span>
      <span className="ml-auto shrink-0 text-xs text-neutral-500">
        stream ▸
      </span>
    </button>
  );
}

// Static deployments (GitHub Pages) may not have a backend baked in at build
// time — let the user point this browser at their unjargon server (e.g. a
// Hugging Face Space) without rebuilding.
function BackendPrompt() {
  const [url, setUrl] = useState(apiBase());
  if (apiBaseIsBuiltIn()) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setApiBase(url);
      }}
      className="mx-auto mt-6 flex max-w-md items-center gap-2"
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://your-space.hf.space"
        className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
      />
      <button
        type="submit"
        className="shrink-0 rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-sm text-amber-100 hover:bg-amber-300/20"
      >
        connect
      </button>
    </form>
  );
}
