import assert from "node:assert/strict";
import {
  googleDefinitionUrl,
  wikipediaReference,
  wikipediaSearchUrl,
} from "../src/lib/reference.ts";

const seen: string[] = [];
const mockFetch: typeof fetch = async (input) => {
  const url = String(input);
  seen.push(url);
  if (url.includes("search/page")) {
    return new Response(JSON.stringify({ pages: [{ key: "Backward_differentiation_formula", title: "Backward differentiation formula" }, { key: "BDF_(disambiguation)", title: "BDF", description: "disambiguation page" }] }));
  }
  return new Response(JSON.stringify({
    type: "disambiguation",
    title: "BDF",
    description: "disambiguation page",
  }));
};

const reference = await wikipediaReference("BDF", mockFetch);
assert.equal(reference?.title, "BDF");
assert.equal(reference?.extract, null);
assert.equal(reference?.ambiguous, true);
assert.equal(reference?.candidates.length, 2, "search alternatives remain available for ambiguous terms");
assert.equal(seen.length, 2, "search then summary only");

const unrelatedOnly: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("search/page")) {
    return new Response(JSON.stringify({ pages: [{ key: "Golden_Gate_Cloning", title: "Golden Gate Cloning" }] }));
  }
  throw new Error("an unrelated result must not be fetched as a summary");
};
const missing = await wikipediaReference("MSBI", unrelatedOnly);
assert.equal(missing?.extract, null, "MSBI must not inherit Golden Gate Cloning's explanation");
assert.equal(missing?.articleUrl, null);
assert.match(googleDefinitionUrl("BDF"), /q=BDF\+definition/);
assert.match(wikipediaSearchUrl("BDF"), /search=BDF/);
console.log("zero-AI reference check passed");
