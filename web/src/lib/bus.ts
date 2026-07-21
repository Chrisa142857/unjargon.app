import { EventEmitter } from "node:events";

// In-process detector events. These never include agent message text.

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

// Result of the zero-AI detector for one message. Raw text is intentionally
// excluded from events; /live renders glossary terms only.
export type ClientDetectionEvent = {
  type: "detection";
  messageId: number;
  sessionId: number;
  dailyDetectionUsed: number;
  annotations: StreamAnnotation[];
  newTerms: StreamTerm[];
};

export type ClientStreamEvent = ClientDetectionEvent;
export type DetectionEvent = ClientDetectionEvent & { userId: number };
export type StreamEvent = DetectionEvent;

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
