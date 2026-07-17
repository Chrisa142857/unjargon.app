import { claimDigestWork, serverCanLLM } from "@/lib/digest";
import { deviceForRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Digest work queue for collectors in local-translate mode (the default,
// no-server-key deployment): a collector claims one pending digest chunk,
// runs the prompt with the user's own AI CLI, and posts the summary back to
// /api/work/digest/:id. Collector-authenticated with the ingest token.
export async function GET(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) {
    return Response.json({ error: "invalid device token" }, { status: 401 });
  }
  if (serverCanLLM()) {
    // The server generates its own digests; don't spend the user's AI calls.
    return new Response(null, { status: 204 });
  }
  const work = await claimDigestWork(device.userId!);
  if (!work) return new Response(null, { status: 204 });
  return Response.json(work);
}
