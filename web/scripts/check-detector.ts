import assert from "node:assert/strict";
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
console.log("detector check passed for six representative messages");
