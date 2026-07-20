import assert from "node:assert/strict";
import { hasLiveLocalExpander } from "../src/lib/local-expander.ts";
import { serverCanLLM } from "../src/lib/llm.ts";

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

const serverAi = {
  key: process.env.ANTHROPIC_API_KEY,
  allow: process.env.UNJARGON_ALLOW_SERVER_AI,
  fake: process.env.UNJARGON_FAKE_TRANSLATOR,
};
delete process.env.ANTHROPIC_API_KEY;
delete process.env.UNJARGON_ALLOW_SERVER_AI;
delete process.env.UNJARGON_FAKE_TRANSLATOR;
assert(!serverCanLLM(), "server AI is off by default");
process.env.ANTHROPIC_API_KEY = "test";
assert(!serverCanLLM(), "a key alone cannot create paid calls");
process.env.UNJARGON_ALLOW_SERVER_AI = "1";
assert(serverCanLLM(), "server AI needs explicit opt-in");
process.env.ANTHROPIC_API_KEY = serverAi.key ?? "";
process.env.UNJARGON_ALLOW_SERVER_AI = serverAi.allow ?? "";
process.env.UNJARGON_FAKE_TRANSLATOR = serverAi.fake ?? "";
console.log("local expander status check passed");
