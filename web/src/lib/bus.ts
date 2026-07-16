import { EventEmitter } from "node:events";

// In-process pub/sub connecting /api/ingest (publisher) to /api/stream (SSE
// subscribers). Works because the app runs as a single Node process (dev or
// a single Railway-style service). If we ever deploy to serverless, swap the
// internals for Postgres LISTEN/NOTIFY — the interface stays the same.

export type StreamEvent = {
  type: "message";
  message: {
    id: number;
    sessionId: number;
    device: string;
    tool: string;
    cwd: string | null;
    ts: string;
    text: string;
    subtitle: string | null;
  };
};

const globalForBus = globalThis as unknown as { __unjargonBus?: EventEmitter };

const bus = globalForBus.__unjargonBus ?? new EventEmitter();
bus.setMaxListeners(100); // many browser tabs, phone + laptop
globalForBus.__unjargonBus = bus;

export function publish(event: StreamEvent) {
  bus.emit("event", event);
}

export function subscribe(fn: (event: StreamEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}
