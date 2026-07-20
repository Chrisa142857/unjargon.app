import { deviceForRequest } from "@/lib/auth";
import { serverCanLLM } from "@/lib/llm";
import { claimExpansionWork } from "@/lib/expand";

export const dynamic = "force-dynamic";

// Expansion work queue for collectors (no-key servers): a user asked for a
// term's deeper explanation; their own collector claims the prompt, runs it
// within the local AI budget, and posts the text to /api/work/expand/:id.
export async function GET(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) return Response.json({ error: "invalid device token" }, { status: 401 });
  if (serverCanLLM()) return new Response(null, { status: 204 });
  const work = await claimExpansionWork(device.userId!);
  if (!work) return new Response(null, { status: 204 });
  return Response.json(work);
}
