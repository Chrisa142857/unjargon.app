import assert from "node:assert/strict";
import { HISTORY_JARGON_ITEMS, LIVE_JARGON_ITEMS, retainTerm } from "../src/lib/term-budget.ts";
import { detectJargon, isHighConfidenceTerm } from "../src/lib/detect.ts";

// High-confidence chips only: rare vocabulary is an accessibility signal, not
// proof that a word deserves its own glossary meaning.
const messages = [
  "I'll check the integrator for NaN blowups.",
  "The ODE system is stiff, so RK4 diverges. Switch to BDF via scipy.integrate.solve_ivp.",
  "Run python analysis/bootstrap.py --strict && scipy.integrate.solve_ivp(...)",
  "The Jacobian eigenvalues indicate an asymptotic convergence issue.",
  "Use git checkout --force and run npm test in src/lib/foo.ts.",
  "OK, use GitHub and scipy to finish the frontend.",
];
const found = messages.map((text) => new Set(detectJargon(text).map((term) => term.term)));

for (const term of ["NaN", "ODE", "RK4", "BDF", "stiff", "Jacobian"]) {
  assert(found.some((terms) => terms.has(term)), `expected ${term}`);
}
for (const artifact of ["OK", "GitHub", "scipy", "frontend", "integrate", "solve", "python", "bootstrap.py", "git", "npm", "foo"]) {
  assert(found.every((terms) => !terms.has(artifact)), `artifact leaked: ${artifact}`);
}
assert(!isHighConfidenceTerm("OK", 0.95), "legacy OK chip stayed visible");
assert(!isHighConfidenceTerm("GitHub", 0.78), "legacy GitHub chip stayed visible");
assert(isHighConfidenceTerm("stiff", 0.6), "validated contextual chip disappeared");
const budget = { history: new Set<string>(), live: new Set<string>() };
for (let i = 0; i < HISTORY_JARGON_ITEMS; i++) assert(retainTerm(budget, `history-${i}`, true));
assert(!retainTerm(budget, "history-overflow", true), "history exceeded 75 glossary items");
for (let i = 0; i < LIVE_JARGON_ITEMS; i++) assert(retainTerm(budget, `live-${i}`, false));
assert(!retainTerm(budget, "live-overflow", false), "live exceeded its 25-item reserve");
assert(retainTerm(budget, "history-0", false), "existing history terms must remain usable live");
console.log("detector check passed for six representative messages");
