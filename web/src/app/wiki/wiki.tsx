"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, bounceToApiOrigin } from "@/lib/api";
import AccountMenu from "@/app/account-menu";
import { AiCallConfirmButton } from "@/app/ai-confirm";
import { TermReference } from "@/app/term-reference";

export type WikiTerm = {
  id: number;
  term: string;
  domain: string;
  kind: string;
  l3: string | null;
  salience: number | null;
  sightings: number;
  sessions: number;
  devices: number;
};

function selectedTermId() {
  const value = new URLSearchParams(window.location.search).get("term");
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function Wiki() {
  const [terms, setTerms] = useState<WikiTerm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeTermId, setActiveTermId] = useState<number | null>(null);

  useEffect(() => {
    const syncLocation = () => setActiveTermId(selectedTermId());
    syncLocation();
    window.addEventListener("popstate", syncLocation);
    return () => window.removeEventListener("popstate", syncLocation);
  }, []);

  useEffect(() => {
    if (bounceToApiOrigin(`/wiki${window.location.search}`)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(api("/api/wiki"));
        if (res.status === 401) {
          window.location.assign(api("/api/auth/google"));
          return;
        }
        if (!res.ok) throw new Error(`wiki fetch failed (${res.status})`);
        const data = await res.json();
        if (!cancelled) setTerms(data.terms);
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

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? terms.filter(
          (t) =>
            t.term.toLowerCase().includes(q) ||
            t.domain.toLowerCase().includes(q),
        )
      : terms;
    const byDomain = new Map<string, WikiTerm[]>();
    for (const term of filtered) {
      byDomain.set(term.domain, [...(byDomain.get(term.domain) ?? []), term]);
    }
    return [...byDomain.entries()];
  }, [terms, query]);

  const active = activeTermId === null
    ? null
    : terms.find((term) => term.id === activeTermId) ?? null;

  function openTerm(id: number) {
    window.history.pushState({}, "", `${window.location.pathname}?term=${id}`);
    setActiveTermId(id);
  }

  function closeTerm() {
    window.history.pushState({}, "", window.location.pathname);
    setActiveTermId(null);
  }

  function cacheExplanation(termId: number, l3: string | null) {
    setTerms((current) => current.map((term) =>
      term.id === termId ? { ...term, l3: l3 ?? term.l3 } : term,
    ));
  }

  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/95 px-4 py-3">
        <Link href="/live" className="text-sm text-neutral-400 hover:text-neutral-100">
          ← live
        </Link>
        <span className="font-semibold tracking-tight">unjargon wiki</span>
        <AccountMenu />
        {!active && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search terms…"
            className="w-40 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-500 sm:w-64"
          />
        )}
      </header>

      <div className="mx-auto max-w-2xl px-4 py-6">
        {active ? (
          <TermPage term={active} onBack={closeTerm} onExpanded={cacheExplanation} />
        ) : activeTermId !== null && loaded ? (
          <>
            <button onClick={closeTerm} className="text-sm text-neutral-400 hover:text-neutral-100">
              ← all terms
            </button>
            <p className="mt-6 text-neutral-500">That term is not in your glossary.</p>
          </>
        ) : (
          <>
            <p className="mb-6 text-sm text-neutral-500">
              {terms.length} terms your agents taught you, across every machine.
            </p>
            {grouped.length === 0 && (
              <p className="text-neutral-500">
                {!loaded
                  ? "loading…"
                  : loadError
                    ? `couldn't reach the unjargon API — ${loadError}`
                    : "nothing matches."}
              </p>
            )}
            {grouped.map(([domain, list]) => (
              <section key={domain} className="mb-8">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
                  {domain} · {list.length}
                </h2>
                <div className="flex flex-col gap-2">
                  {list.map((term) => (
                    <TermRow key={term.id} term={term} onOpen={() => openTerm(term.id)} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </main>
  );
}

function TermRow({ term, onOpen }: { term: WikiTerm; onOpen: () => void }) {
  const aiExplained = Boolean(term.l3);
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-baseline gap-3 rounded-lg border px-3 py-2.5 text-left hover:border-neutral-700 ${aiExplained ? "border-violet-300/45 bg-violet-300/[0.08]" : "border-neutral-800 bg-neutral-900/50"}`}
    >
      <span className="font-medium">{term.term}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-400">{term.domain}</span>
      {aiExplained && <span className="shrink-0 rounded-full border border-violet-300/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200">AI explained</span>}
      <span className="shrink-0 text-xs text-neutral-600">
        {term.sightings}× · {term.sessions} session{term.sessions === 1 ? "" : "s"}
      </span>
    </button>
  );
}

function TermPage({
  term,
  onBack,
  onExpanded,
}: {
  term: WikiTerm;
  onBack: () => void;
  onExpanded: (termId: number, l3: string | null) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestExplanation() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(api(`/api/terms/${term.id}/expand`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "grounding", confirmed: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `expand failed (${res.status})`);
      setPending(data.pending?.grounding === true);
      onExpanded(term.id, data.l3);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!pending || term.l3) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(api(`/api/terms/${term.id}/expand`));
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `expand failed (${res.status})`);
        setPending(data.pending?.grounding === true);
        onExpanded(term.id, data.l3);
      } catch (err) {
        setError(String(err));
        setPending(false);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [onExpanded, pending, term.id, term.l3]);

  return (
    <article>
      <button onClick={onBack} className="text-sm text-neutral-400 hover:text-neutral-100">
        ← all terms
      </button>
      <p className="mt-6 text-xs font-medium uppercase tracking-widest text-neutral-500">{term.domain}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{term.term}</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Seen in {term.sightings} message{term.sightings === 1 ? "" : "s"}, {term.sessions} session{term.sessions === 1 ? "" : "s"}, and {term.devices} machine{term.devices === 1 ? "" : "s"}.
      </p>
      <div className="mt-6">
        <TermReference id={term.id} term={term.term} />
      </div>
      <section className="mt-5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
        <p className="text-[10px] font-medium uppercase tracking-widest text-neutral-500">In your sessions · optional AI</p>
        {term.l3 ? (
          <p className="mt-2 text-sm leading-relaxed text-neutral-100">{term.l3}</p>
        ) : loading ? (
          <div className="mt-3 animate-pulse space-y-2" aria-label="starting in-session explanation">
            <div className="h-3 w-full rounded bg-neutral-800" />
            <div className="h-3 w-4/6 rounded bg-neutral-800" />
          </div>
        ) : pending ? (
          <p className="mt-3 animate-pulse text-sm text-neutral-500">queued — a connected collector will explain this in your context…</p>
        ) : (
          <AiCallConfirmButton
            term={term.term}
            source="latest"
            onConfirm={requestExplanation}
            className="mt-3 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:text-white"
          />
        )}
        {error && <p className="mt-3 text-sm text-red-400/90">couldn&apos;t load — {error}</p>}
      </section>
    </article>
  );
}
