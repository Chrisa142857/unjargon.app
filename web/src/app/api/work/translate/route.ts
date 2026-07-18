import { deviceForRequest } from "@/lib/auth";
import { serverCanLLM } from "@/lib/digest";
import {
  claimTranslateWork,
  completeTranslateWork,
  type TranslationResult,
} from "@/lib/translate";

export const dynamic = "force-dynamic";

// Translate-work queue for collectors in local-translate mode (the analogue
// of /api/work/digest): untranslated messages served oldest-first across the
// user's whole history. GET claims a batch; POST delivers the translations.
export async function GET(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) return Response.json({ error: "invalid device token" }, { status: 401 });
  if (serverCanLLM()) {
    // The server translates on ingest; don't spend the user's AI calls.
    return new Response(null, { status: 204 });
  }
  const items = await claimTranslateWork(device.userId!);
  if (items.length === 0) return new Response(null, { status: 204 });
  return Response.json({ items });
}

export async function POST(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) return Response.json({ error: "invalid device token" }, { status: 401 });
  let body: { items?: { id: number; translation: TranslationResult }[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.items)) {
    return Response.json({ error: "missing items" }, { status: 400 });
  }
  const stored = await completeTranslateWork(device.userId!, body.items.slice(0, 50));
  return Response.json({ stored });
}
