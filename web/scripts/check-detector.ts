import assert from "node:assert/strict";
import { corpusFor, detectJargon } from "../src/lib/detect.ts";

// Six representative Build Week messages: jargon, acronyms, ordinary prose,
// and artifacts that must not become glossary chips.
const messages = [
  "I'll check the integrator for NaN blowups.",
  "The ODE system is stiff, so RK4 diverges. Switch to BDF via scipy.integrate.solve_ivp.",
  "Run python analysis/bootstrap.py --strict && scipy.integrate.solve_ivp(...)",
  "Compute bootstrap CI and a two-proportion z-test to quantify sampling noise.",
  "The Jacobian eigenvalues indicate an asymptotic convergence issue.",
  "Use git checkout --force and run npm test in src/lib/foo.ts.",
];
const corpus = corpusFor(messages);
const found = messages.map((text) => new Set(detectJargon(text, corpus).map((term) => term.term)));

for (const term of ["NaN", "ODE", "RK4", "BDF", "stiff", "bootstrap", "Jacobian"]) {
  assert(found.some((terms) => terms.has(term)), `expected ${term}`);
}
for (const artifact of ["scipy", "integrate", "solve", "python", "bootstrap.py", "git", "npm", "foo"]) {
  assert(found.every((terms) => !terms.has(artifact)), `artifact leaked: ${artifact}`);
}
console.log("detector check passed for six representative messages");
