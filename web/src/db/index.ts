import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

type QueryMethod = "run" | "all" | "values" | "get";

async function query(sql: string, params: unknown[], method: QueryMethod) {
  const url = process.env.D1_GATEWAY_URL;
  const secret = process.env.D1_GATEWAY_TOKEN;
  if (!url || !secret) {
    throw new Error("D1_GATEWAY_URL and D1_GATEWAY_TOKEN must be set");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params, method }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as { rows?: unknown; error?: string } | null;
  if (!response.ok || !body || !("rows" in body)) {
    throw new Error(`D1 gateway failed (${response.status}): ${body?.error ?? "invalid response"}`);
  }
  return { rows: body.rows as never[] };
}

// Render keeps the Node/SSE process; this tiny proxy reaches D1 through a
// Worker binding, so no Cloudflare account token is present in this service.
export const db = drizzle(query, { schema });
export * as tables from "./schema";
