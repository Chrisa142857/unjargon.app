import { EventEmitter } from "node:events";

// In-process pub/sub connecting /api/ingest (publisher) to /api/stream (SSE
// subscribers). Works because the app runs as a single Node process (dev or
// a single Railway-style service). If we ever deploy to serverless, swap the
// internals for Postgres LISTEN/NOTIFY — the interface stays the same.

export type MessageEvent = {
  userId: number;
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

// Result of the translation pipeline for one message. subtitle null means
// passthrough: the message was trivial (skipped) or translation failed —
// either way the client stops showing "translating" and renders raw text.
export type TranslationEvent = {
  userId: number;
  type: "translation";
  messageId: number;
  sessionId: number;
  subtitle: string | null;
  importance: number | null;
  annotations: {
    id: number;
    span: string;
    sentenceRewrite: string;
    termId: number | null;
  }[];
  newTerms: {
    id: number;
    term: string;
    domain: string;
    l1: string;
    salience: number | null;
  }[];
};

// A rollup card replacing messages [fromMessageId, toMessageId] in the stream.
export type DigestEvent = {
  userId: number;
  type: "digest";
  digest: {
    id: number;
    sessionId: number;
    fromMessageId: number;
    toMessageId: number;
    fromTs: string;
    toTs: string;
    messageCount: number;
    summary: string;
  };
};

export type StreamEvent = MessageEvent | TranslationEvent | DigestEvent;

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
