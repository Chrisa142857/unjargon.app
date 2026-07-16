import { claimDigestWork, serverCanLLM } from "@/lib/digest";

export const dynamic = "force-dynamic";

// Digest work queue for collectors in local-translate mode (the default,
// no-server-key deployment): a collector claims one pending digest chunk,
// runs the prompt with the user's own AI CLI, and posts the summary back to
// /api/work/digest/:id. Collector-authenticated with the ingest token.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return Response.json({ error: "invalid device token" }, { status: 401 });
  }
  if (serverCanLLM()) {
    // The server generates its own digests; don't spend the user's AI calls.
    return new Response(null, { status: 204 });
  }
  const work = await claimDigestWork();
  if (!work) return new Response(null, { status: 204 });
  return Response.json(work);
}
