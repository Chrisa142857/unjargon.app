import type { NextConfig } from "next";

// Two build targets:
// - default: full-stack server (output: standalone) — runs UI + API + SSE in
//   one Node process; this is what the Hugging Face Space container runs.
// - BUILD_TARGET=pages: static export of the UI only for GitHub Pages; the
//   API routes are moved aside by scripts/build-pages.sh and the client
//   talks to the Space via NEXT_PUBLIC_API_BASE (CORS below).
const isPages = process.env.BUILD_TARGET === "pages";

const nextConfig: NextConfig = {
  output: isPages ? "export" : "standalone",
  basePath: isPages ? (process.env.NEXT_PUBLIC_BASE_PATH ?? "") : "",
  trailingSlash: isPages,
  // Compression buffers streamed responses — it would break SSE.
  compress: false,
  ...(isPages
    ? {}
    : {
        async headers() {
          return [
            {
              // CORS so the GitHub Pages frontend (different origin) can call
              // the API and subscribe to SSE. No cookies are used; /api/ingest
              // is bearer-token guarded.
              source: "/api/:path*",
              headers: [
                { key: "Access-Control-Allow-Origin", value: "*" },
                {
                  key: "Access-Control-Allow-Methods",
                  value: "GET, POST, OPTIONS",
                },
                {
                  key: "Access-Control-Allow-Headers",
                  value: "Content-Type, Authorization",
                },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
