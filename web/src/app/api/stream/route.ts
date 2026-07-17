import { subscribe } from "@/lib/bus";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// SSE fan-out of new messages to /live viewers. SSE (not WebSockets) by
// design: simpler and survives proxies.
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      controller.enqueue(encoder.encode(": connected\n\n"));
      const unsubscribe = subscribe((event) => {
        if (event.userId === user.id) {
          const safe = { ...event };
          delete (safe as Partial<typeof event>).userId;
          send(safe);
        }
      });

      // Heartbeat keeps proxies from idling the connection out.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);

      function cleanup() {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
