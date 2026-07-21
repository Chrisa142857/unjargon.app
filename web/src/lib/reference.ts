export type WikipediaReference = {
  title: string;
  description: string | null;
  extract: string | null;
  articleUrl: string;
  ambiguous: boolean;
  candidates: { title: string; description: string | null; articleUrl: string }[];
};

const WIKIPEDIA_USER_AGENT =
  "unjargon.app/1.0 (+https://github.com/Chrisa142857/unjargon.app/issues)";
const WIKIPEDIA_TIMEOUT_MS = 8_000;

export function googleDefinitionUrl(term: string) {
  return `https://www.google.com/search?${new URLSearchParams({ q: `${term} definition` })}`;
}

export function wikipediaSearchUrl(term: string) {
  return `https://en.wikipedia.org/wiki/Special:Search?${new URLSearchParams({ search: term })}`;
}

// Public reference only: this receives a detected term, never transcript text.
export async function wikipediaReference(
  rawTerm: string,
  request: typeof fetch = fetch,
): Promise<WikipediaReference | null> {
  const term = rawTerm.trim().slice(0, 120);
  if (!term) return null;
  const headers = { Accept: "application/json", "User-Agent": WIKIPEDIA_USER_AGENT };
  const requestOptions = () => ({
    headers,
    signal: AbortSignal.timeout(WIKIPEDIA_TIMEOUT_MS),
  });
  try {
    const search = await request(
      `https://en.wikipedia.org/w/rest.php/v1/search/page?${new URLSearchParams({ q: term, limit: "5" })}`,
      requestOptions(),
    );
    if (!search.ok) return null;
    const found = await search.json() as {
      pages?: { key?: string; title?: string; description?: string | null }[];
    };
    const page = found.pages?.[0];
    if (!page?.key) return null;

    const candidates = found.pages?.flatMap((candidate) => candidate.key
      ? [{ title: candidate.title ?? candidate.key, description: candidate.description ?? null, articleUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(candidate.key)}` }]
      : []) ?? [];
    const articleUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`;
    const summary = await request(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`,
      requestOptions(),
    );
    const details = summary.ok
      ? await summary.json() as {
          type?: string;
          title?: string;
          description?: string | null;
          extract?: string | null;
        }
      : {};
    const description = details.description ?? page.description ?? null;
    const ambiguous = details.type === "disambiguation" ||
      description?.toLowerCase().includes("disambiguation") === true;
    return {
      title: details.title ?? page.title ?? term,
      description,
      extract: ambiguous ? null : details.extract?.trim().slice(0, 1200) ?? null,
      articleUrl,
      ambiguous,
      candidates,
    };
  } catch {
    return null;
  }
}
