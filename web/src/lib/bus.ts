import { EventEmitter } from "node:events";

// In-process pub/sub connecting /api/ingest (publisher) to /api/stream (SSE
// subscribers). Works because the app runs as a single Node process. If this
// service is ever scaled horizontally, swap the internals for durable pub/sub.

export type StreamMessage = {
  id: number;
  sessionId: number;
  sessionCreated: boolean;
  device: string;
  tool: string;
  cwd: string | null;
  ts: string;
  text: string;
};

export type StreamAnnotation = {
  id: number;
  span: string;
  sentenceRewrite: string;
  termId: number | null;
};

export type StreamTerm = {
  id: number;
  term: string;
  domain: string;
  kind: string;
  l1: string;
  salience: number | null;
};

export type ClientMessageEvent = {
  type: "message";
  message: StreamMessage;
};

// Result of the zero-AI detector for one message. The message always stays
// verbatim; annotations simply make detected terms tappable.
export type ClientDetectionEvent = {
  type: "detection";
  messageId: number;
  sessionId: number;
  dailyDetectionUsed: number;
  annotations: StreamAnnotation[];
  newTerms: StreamTerm[];
};

export type ClientStreamEvent = ClientMessageEvent | ClientDetectionEvent;
export type MessageEvent = ClientMessageEvent & { userId: number };
export type DetectionEvent = ClientDetectionEvent & { userId: number };
export type StreamEvent = MessageEvent | DetectionEvent;

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
