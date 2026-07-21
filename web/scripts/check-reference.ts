import assert from "node:assert/strict";
import {
  googleDefinitionUrl,
  wikipediaReference,
  wikipediaSearchUrl,
  zeroAiTermNote,
} from "../src/lib/reference.ts";

const seen: string[] = [];
const mockFetch: typeof fetch = async (input) => {
  const url = String(input);
  seen.push(url);
  if (url.includes("search/page")) {
    return new Response(JSON.stringify({ pages: [{ key: "Backward_differentiation_formula", title: "Backward differentiation formula" }, { key: "BDF_(disambiguation)", title: "BDF", description: "disambiguation page" }] }));
  }
  return new Response(JSON.stringify({
    title: "Backward differentiation formula",
    description: "family of implicit methods for ordinary differential equations",
    extract: "Backward differentiation formulas are implicit multistep methods for solving ordinary differential equations.",
  }));
};

const reference = await wikipediaReference("BDF", mockFetch);
assert.equal(reference?.title, "Backward differentiation formula");
assert.match(reference?.extract ?? "", /implicit multistep/);
assert.equal(reference?.candidates.length, 2, "search alternatives remain available for ambiguous terms");
assert.equal(seen.length, 2, "search then summary only");
assert.match(googleDefinitionUrl("BDF"), /q=BDF\+definition/);
assert.match(wikipediaSearchUrl("BDF"), /search=BDF/);
assert.match(zeroAiTermNote("initial"), /acronym/);
console.log("zero-AI reference check passed");
