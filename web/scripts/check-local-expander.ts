import assert from "node:assert/strict";
import { hasLiveLocalExpander } from "../src/lib/local-expander.ts";

const now = Date.parse("2026-07-20T12:00:00Z");
const status = (patch: object = {}) =>
  JSON.stringify({
    budgetLimit: 30,
    budgetUsed: 0,
    updatedAt: new Date(now).toISOString(),
    ...patch,
  });

assert(hasLiveLocalExpander([status()], now), "fresh enabled collector");
assert(!hasLiveLocalExpander([status({ budgetLimit: 0 })], now), "disabled collector");
assert(!hasLiveLocalExpander([status({ updatedAt: new Date(now - 90_001).toISOString() })], now), "stale collector");
assert(!hasLiveLocalExpander([status({ pausedUntil: new Date(now + 1).toISOString() })], now), "paused collector");
assert(hasLiveLocalExpander([status({ budgetLimit: 0 }), status()], now), "one enabled collector is enough");
console.log("local expander status check passed");
