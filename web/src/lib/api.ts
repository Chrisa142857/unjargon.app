// Where the API lives. Same origin ("") for the full-stack deployment; the
// GitHub Pages build bakes in the Hugging Face Space URL via
// NEXT_PUBLIC_API_BASE at export time.
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(
  /\/+$/,
  "",
);

export function api(path: string): string {
  return `${API_BASE}${path}`;
}
