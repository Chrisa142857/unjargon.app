// Where the API lives. Resolution order:
// 1. NEXT_PUBLIC_API_BASE baked in at build time (the GitHub Pages workflow
//    passes the UNJARGON_API_BASE repo variable when it's set);
// 2. a runtime value saved in the browser (settable from the /live error
//    state), so a static deployment can be pointed at a backend — or moved
//    to a new one — without rebuilding;
// 3. "" → same origin (the full-stack server / HF Space serving its own UI).
const BUILT_IN = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

const STORAGE_KEY = "unjargon_api_base";

export function apiBase(): string {
  if (BUILT_IN) return BUILT_IN;
  if (typeof window !== "undefined") {
    try {
      return (window.localStorage.getItem(STORAGE_KEY) ?? "").replace(
        /\/+$/,
        "",
      );
    } catch {
      return "";
    }
  }
  return "";
}

// Save a backend URL in this browser and reload. Empty clears it.
export function setApiBase(url: string): void {
  try {
    const clean = url.trim().replace(/\/+$/, "");
    if (clean) window.localStorage.setItem(STORAGE_KEY, clean);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode) — same-origin fallback still works
  }
  window.location.reload();
}

export function apiBaseIsBuiltIn(): boolean {
  return BUILT_IN !== "";
}

export function api(path: string): string {
  return `${apiBase()}${path}`;
}
