import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export type DetectedTerm = {
  term: string;
  kind: "term" | "initial";
  confidence: number;
};

const MAX_TERMS = 6;
const COMMON_IN_BBC = 1_000;

const STOP_WORDS = new Set([
  "about", "after", "already", "also", "around", "before", "because",
  "between", "could", "different", "does", "done", "each", "enough",
  "every", "first", "found", "from", "getting", "going", "have", "into",
  "just", "like", "might", "more", "most", "much", "never", "nothing",
  "other", "over", "rather", "really", "same", "should", "some", "than",
  "that", "their", "there", "these", "they", "this", "those", "through",
  "using", "very", "via", "when", "which", "while", "with", "would", "your",
  "analysis", "change", "changes", "check", "code", "data", "effect",
  "error", "file", "files", "fix", "history", "issue", "message", "model",
  "network", "number", "output", "project", "result", "results", "run",
  "session", "system", "tests", "time", "update", "version", "work",
]);

// Common English words that become technical only in a specialist context.
// Require another detector signal in the same message, so ordinary prose does
// not produce chips for them.
const CONTEXTUAL_TERMS = new Set([
  "asymptotic", "biased", "convergent", "divergent", "explicit", "implicit",
  "regularized", "stability", "stable", "stiff", "transient", "underpowered",
  "unstable", "variance",
]);

// A small set of capitalized technical names that general-news frequency
// misses. Names outside this list stay conservative to avoid person-name chips.
const TECHNICAL_PROPER_NOUNS = new Set([
  "bayesian", "euler", "fourier", "gaussian", "hessian", "jacobian",
  "lagrangian", "markov", "newtonian",
]);

const COMMANDS = [
  "bash", "brew", "bun", "cargo", "cd", "claude", "codex", "curl", "docker",
  "git", "go", "java", "kubectl", "make", "node", "npm", "npx", "pip",
  "pnpm", "python", "python3", "rg", "sh", "systemctl", "uv", "yarn",
].join("|");

let frequency: Map<string, number> | undefined;

function frequencies() {
  if (frequency) return frequency;
  const rows = gunzipSync(
    readFileSync(join(process.cwd(), "data", "dejargonizer-bbc.csv.gz")),
  ).toString("utf8").trim().split("\n");
  frequency = new Map();
  for (const row of rows) {
    const comma = row.lastIndexOf(",");
    const word = row.slice(0, comma).toLowerCase();
    const count = Number(row.slice(comma + 1));
    if (word && Number.isFinite(count)) {
      frequency.set(word, count);
    }
  }
  return frequency;
}

function proseOnly(text: string) {
  // Remove things that look like artifacts before tokenizing: paths, URLs,
  // flags, identifiers, modules, filenames, function calls, and shell lines.
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/(?:~?\/|\.\.?\/)(?:[A-Za-z0-9@._-]+\/)+[A-Za-z0-9@._-]+/g, " ")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g, " ")
    .replace(/\b[A-Za-z0-9_-]+\.(?:c|cc|cpp|csv|go|h|html|java|js|json|md|py|rs|sh|toml|ts|tsx|txt|ya?ml)\b/gi, " ")
    .replace(/--?[A-Za-z][A-Za-z0-9-]*/g, " ")
    .replace(/\b(?:[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g, " ")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/g, " ")
    .replace(new RegExp(`\\b(?:${COMMANDS})\\b(?:\\s+(?:--?[\\w-]+|[A-Za-z0-9_./=:-]+)){0,4}`, "gi"), " ");
}

function isAcronym(token: string) {
  return /^[A-Z]{2,}\d*$/.test(token) || /^[A-Z][a-z]+[A-Z]\d*$/.test(token);
}

function isTechnicalInitial(token: string) {
  // De-Jargonizer's BBC data rejects ordinary uppercase English (for example,
  // "OK"); rarity alone is not enough to create a glossary meaning.
  return token.length >= 3 && isAcronym(token) &&
    (frequencies().get(token.toLowerCase()) ?? 0) < COMMON_IN_BBC;
}

export function detectJargon(text: string): DetectedTerm[] {
  const candidates = new Map<string, DetectedTerm & { index: number }>();
  const tokens = proseOnly(text).match(/[A-Za-z][A-Za-z0-9-]*/g) ?? [];
  const add = (term: string, kind: DetectedTerm["kind"], confidence: number, index: number) => {
    const key = term.toLowerCase();
    const previous = candidates.get(key);
    if (!previous || confidence > previous.confidence) {
      candidates.set(key, { term, kind, confidence, index });
    }
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (TECHNICAL_PROPER_NOUNS.has(lower)) {
      add(token, "term", 0.8, index);
    } else if (isTechnicalInitial(token) && !STOP_WORDS.has(lower)) {
      add(token, "initial", 0.95, index);
    }
  }

  const hasTechnicalSignal = candidates.size > 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (hasTechnicalSignal && CONTEXTUAL_TERMS.has(lower)) {
      add(token, "term", 0.6, index);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.confidence - a.confidence || a.index - b.index)
    .slice(0, MAX_TERMS)
    .map(({ term, kind, confidence }) => ({ term, kind, confidence }));
}

// Existing detector rows stay in D1 through upgrades. Reapply the current
// precision rule when rendering them instead of showing legacy rare-word chips.
export function isHighConfidenceTerm(term: string, salience: number | null) {
  if (salience === 0.6) return true; // contextual term, validated in its message
  const key = term.toLowerCase();
  return detectJargon(term).some((detected) => detected.term.toLowerCase() === key);
}
