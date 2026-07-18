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

// Sign-in is a SameSite=Lax cookie, so the authenticated app must run on the
// API's own origin — a static (GitHub Pages) build can't fetch it cross-site.
// Pages like /live call this on mount: when the API lives elsewhere, the
// browser is sent to the same page on the backend and this returns true.
export function bounceToApiOrigin(path: string): boolean {
  const base = apiBase();
  if (!base) return false;
  try {
    if (new URL(base, window.location.href).origin === window.location.origin) {
      return false;
    }
  } catch {
    return false;
  }
  window.location.replace(`${base}${path}`);
  return true;
}
