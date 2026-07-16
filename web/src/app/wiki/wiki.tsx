"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

export type WikiTerm = {
  id: number;
  term: string;
  domain: string;
  l1: string;
  l2: string | null;
  l3: string | null;
  salience: number | null;
  sightings: number;
  sessions: number;
  devices: number;
};

export default function Wiki() {
  const [terms, setTerms] = useState<WikiTerm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(api("/api/wiki"));
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
            t.l1.toLowerCase().includes(q) ||
            t.domain.toLowerCase().includes(q),
        )
      : terms;
    const byDomain = new Map<string, WikiTerm[]>();
    for (const t of filtered) {
      byDomain.set(t.domain, [...(byDomain.get(t.domain) ?? []), t]);
    }
    return [...byDomain.entries()];
  }, [terms, query]);

  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/95 px-4 py-3">
        <Link
          href="/live"
          className="text-sm text-neutral-400 hover:text-neutral-100"
        >
          ← live
        </Link>
        <span className="font-semibold tracking-tight">unjargon wiki</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search terms…"
          className="ml-auto w-40 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-500 sm:w-64"
        />
      </header>

      <div className="mx-auto max-w-2xl px-4 py-6">
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
              {list.map((t) => (
                <TermRow
                  key={t.id}
                  term={t}
                  onExpanded={(l2, l3) =>
                    setTerms((prev) =>
                      prev.map((x) => (x.id === t.id ? { ...x, l2, l3 } : x)),
                    )
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function TermRow({
  term: t,
  onExpanded,
}: {
  term: WikiTerm;
  onExpanded: (l2: string, l3: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (!t.l2 || !t.l3) && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(api(`/api/terms/${t.id}/expand`), {
          method: "POST",
        });
        if (!res.ok) throw new Error(`expand failed (${res.status})`);
        const data = await res.json();
        onExpanded(data.l2, data.l3);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50">
      <button
        onClick={toggle}
        className="flex w-full items-baseline gap-3 px-3 py-2.5 text-left"
      >
        <span className="font-medium">{t.term}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-400">
          {t.l1}
        </span>
        <span className="shrink-0 text-xs text-neutral-600">
          {t.sightings > 0
            ? `${t.sightings}× · ${t.sessions} session${t.sessions === 1 ? "" : "s"} · ${t.devices} machine${t.devices === 1 ? "" : "s"}`
            : "unseen"}
        </span>
      </button>
      {open && (
        <div className="border-t border-neutral-800 px-3 py-3 text-sm leading-relaxed">
          <p className="text-neutral-200">{t.l1}</p>
          <Layer title="What it is" body={t.l2} loading={loading} error={error} />
          <Layer
            title="In your sessions"
            body={t.l3}
            loading={loading}
            error={error}
          />
        </div>
      )}
    </div>
  );
}

function Layer({
  title,
  body,
  loading,
  error,
}: {
  title: string;
  body: string | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="mt-3">
      <h3 className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
        {title}
      </h3>
      {body ? (
        <p className="text-neutral-300">{body}</p>
      ) : error ? (
        <p className="text-red-400/90">couldn&apos;t load — {error}</p>
      ) : loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-3 w-full rounded bg-neutral-800" />
          <div className="h-3 w-4/6 rounded bg-neutral-800" />
        </div>
      ) : (
        <p className="text-neutral-600">tap to load</p>
      )}
    </div>
  );
}
