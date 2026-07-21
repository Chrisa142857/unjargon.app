"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  googleDefinitionUrl,
  wikipediaSearchUrl,
  type WikipediaReference,
} from "@/lib/reference";

export function TermReference({
  id,
  term,
  wikiHref,
}: {
  id: number;
  term: string;
  wikiHref?: string;
}) {
  const [reference, setReference] = useState<WikipediaReference | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(api(`/api/terms/${id}/reference`), { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json() as { reference?: WikipediaReference | null };
        setReference(data.reference ?? null);
      } catch {
        // The outbound links remain useful when Wikipedia is unavailable.
      } finally {
        if (!controller.signal.aborted) setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [id]);

  const wikipediaUrl = reference?.articleUrl ?? wikipediaSearchUrl(term);
  return (
    <section className="rounded-lg border border-sky-300/15 bg-sky-300/[0.05] p-3">
      <p className="text-[10px] font-medium uppercase tracking-widest text-sky-200/70">
        Basic reference · zero AI
      </p>
      {!loaded ? (
        <p className="mt-2 animate-pulse text-xs text-neutral-500">looking up public references…</p>
      ) : reference?.extract ? (
        <>
          <p className="mt-2 text-sm leading-relaxed text-neutral-100">{reference.extract}</p>
          <p className="mt-1 text-xs text-neutral-500">Wikipedia: {reference.title}</p>
        </>
      ) : reference?.description ? (
        <p className="mt-2 text-sm leading-relaxed text-neutral-100">
          Wikipedia: {reference.description}
        </p>
      ) : (
        <p className="mt-2 text-xs text-neutral-500">No exact Wikipedia page found for this term. Use the Google search below for the matching field.</p>
      )}
      {reference?.ambiguous && (
        <div className="mt-3">
          <p className="text-xs text-amber-200/80">Wikipedia lists multiple meanings. Choose the matching field:</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {reference.candidates.map((candidate) => (
              <a key={candidate.articleUrl} href={candidate.articleUrl} target="_blank" rel="noopener noreferrer" className="rounded border border-neutral-700 px-2 py-1.5 text-xs text-neutral-200 hover:text-white">
                <span className="font-medium">{candidate.title}</span>{candidate.description && <span className="text-neutral-500"> · {candidate.description}</span>}
              </a>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <a
          href={googleDefinitionUrl(term)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-neutral-700 px-2 py-1 text-neutral-300 hover:text-white"
        >
          Google: {term} definition ↗
        </a>
        <a
          href={wikipediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-neutral-700 px-2 py-1 text-neutral-300 hover:text-white"
        >
          {reference?.articleUrl ? "Open Wikipedia ↗" : "Search Wikipedia ↗"}
        </a>
        {wikiHref && (
          <Link href={wikiHref} className="rounded-md border border-neutral-700 px-2 py-1 text-neutral-300 hover:text-white">
            Open term page →
          </Link>
        )}
      </div>
    </section>
  );
}
