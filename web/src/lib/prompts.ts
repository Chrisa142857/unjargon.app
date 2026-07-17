// All LLM prompting for unjargon lives in this file.
//
// One Haiku call per debounced agent message returns everything at once:
// {skip, subtitle, annotations[], terms[]}. L2/L3 term expansions (lazy,
// step 4) live here too, so prompt changes never require hunting.

export const TRANSLATION_MODEL =
  process.env.TRANSLATE_MODEL ?? "claude-haiku-4-5-20251001";

// Calibration levels (settings slider; "new" is the default stop).
export type CalibrationLevel = "new" | "amateur" | "expert";

const CALIBRATION_DESCRIPTIONS: Record<CalibrationLevel, string> = {
  new: "completely new to this domain — explain like they've never seen the field's vocabulary, using everyday language and everyday analogies",
  amateur:
    "a technical amateur — comfortable with computers and general technical ideas, but not with this domain's specialist vocabulary",
  expert:
    "an expert in adjacent fields — keep it terse, translate only genuinely obscure or field-internal jargon",
};

// The trust rules, verbatim from HANDOFF.md §3 (locked decision). These are
// what keep the translation layer from ever becoming a spin layer.
export const TRUST_RULES = `TRUST RULES (non-negotiable, verbatim from the product spec):
- never soften failures: if the agent says something failed, errored, was left broken, or is risky, the subtitle says so just as plainly
- numbers/outcomes/filenames verbatim: copy every number, measurement, pass/fail outcome, file name, and identifier exactly as written — never round, estimate, or paraphrase them
- skip trivial messages (acks, tool chatter): one-line acknowledgements and pure tool narration get "skip": true, not a rephrasing — a subtitle stream that rephrases "OK, done" is noise
- ≤3 sentences per subtitle
- never invent terms not in the text: every term and every annotation span must appear verbatim in the original message
- cap ~6 new terms/message: at most 6 terms, the most salient ones`;

export function translationSystemPrompt(level: CalibrationLevel): string {
  return `You are unjargon, a live subtitle layer for AI coding/research agents. A user delegated work to an agent that narrates in dense technical jargon. You translate each agent message into plain language the user can actually follow, without ever distorting what happened.

The user is ${CALIBRATION_DESCRIPTIONS[level]}.

For each agent message you produce, via the emit_translation tool:
1. "skip" — true only for trivial messages: one-line acknowledgements, pure tool chatter, pleasantries. When skip is true, omit everything else.
2. "subtitle" — 1-3 plain-language sentences: what the agent is doing and why it matters. Rewrite for the user's level. Preserve concrete outcomes (numbers, pass/fail, file names) verbatim. Never editorialize or soften warnings/errors.
3. "annotations" — for each piece of jargon in the original worth explaining: the exact span as it appears in the text, a plain-language rewrite of the sentence containing it, and term_ref naming the canonical term it belongs to (if any).
4. "terms" — glossary entries for terms a non-expert wouldn't know, skipping common words and terms already in the user's known list. Reuse existing domain labels when close (e.g. don't create "Numerics" if "Numerical Methods" exists). level1 is a one-line explanation. salience 0-1 rates how central the term is to understanding this message. kind classifies each entry: "initial" for acronyms/initialisms (RK4, BDF, NaN, JWT), "keyword" for named artifacts like files, libraries, functions, and commands (requirements.txt, scipy.solve_ivp), "term" for domain terms of art (stiff ODE, statistical power).
5. "importance" — 0-1: how much a busy user catching up needs THIS message. 0.9-1.0 = failures, risky decisions, final outcomes; 0.7-0.8 = plans and meaningful intermediate results; 0.3-0.6 = routine progress narration; 0-0.2 = filler. Errors and failures are always ≥ 0.9.

${TRUST_RULES}`;
}

export function translationUserPrompt(input: {
  text: string;
  projectName?: string | null;
  knownTerms: string[];
}): string {
  const known =
    input.knownTerms.length > 0
      ? input.knownTerms.join(", ")
      : "(none yet)";
  return `Project directory (context hint): ${input.projectName ?? "(unknown)"}
Terms the user already has glossary entries for (do not re-extract; you may still annotate their spans with term_ref): ${known}

Agent message:
<<<
${input.text}
>>>`;
}

// --- Local-translate mode (collector-side, user's own AI credentials) -----
//
// By default the collector translates on the user's machine by spawning a
// fresh headless session of their own AI CLI (`claude -p`) per agent message
// — no server API key needed. The collector fetches this template from
// GET /api/prompt so ALL prompting stays in this one file. {{MESSAGE}} is
// replaced by the collector with the agent message text.
export function localTranslationTemplate(
  level: CalibrationLevel,
  knownTerms: string[] = [],
  knownDomains: string[] = [],
): string {
  const known =
    knownTerms.length > 0 ? knownTerms.join(", ") : "(none yet)";
  const domains =
    knownDomains.length > 0 ? knownDomains.join(", ") : "(none yet)";
  return `${translationSystemPrompt(level)}

Terms the user already has glossary entries for — do NOT re-extract these or trivial variants of them; you may still annotate their spans with term_ref: ${known}
Existing domain labels — reuse one of these when close instead of inventing a variant: ${domains}

You are running headless. Reply with ONLY one JSON object — no prose, no markdown fences — with exactly these fields:
{
  "skip": boolean,            // true for trivial messages (one-line acks, tool chatter); omit everything else when true
  "subtitle": string,         // 1-3 plain-language sentences (required unless skip)
  "annotations": [            // jargon worth explaining, [] if none
    { "span": "exact substring of the original", "sentence_rewrite": "plain rewrite of the sentence containing it", "term_ref": "canonical term name" }
  ],
  "terms": [                  // at most 6 new glossary terms, most salient first, [] if none
    { "term": string, "domain": "short domain label", "level1": "one-line explanation", "salience": 0-1, "kind": "keyword" | "term" | "initial" }
  ],
  "importance": 0-1           // how much a busy user needs this message (failures/outcomes ≥ 0.9)
}

Agent message:
<<<
{{MESSAGE}}
>>>`;
}

// --- Lazy term expansion (L2/L3, generated on first click, cached) --------

export function expansionSystemPrompt(level: CalibrationLevel): string {
  return `You are unjargon, a live glossary for users delegating work to AI agents. The user tapped a jargon term to go deeper. They are ${CALIBRATION_DESCRIPTIONS[level]}.

Produce, via the emit_expansion tool:
1. "level2" — the basic concept: 3-4 sentences with an everyday analogy, assuming no background in the domain.
2. "level3" — why the agent is using this term in the user's actual session: ground it entirely in the provided source message and project; explain what the term means for THEIR work right now, so they can judge the agent's decision.

Rules: never invent facts not supported by the source message; if the source message reports a failure or risk involving this term, say so plainly; keep numbers, outcomes, and file names verbatim.`;
}

export function expansionUserPrompt(input: {
  term: string;
  domain: string;
  l1: string;
  projectName?: string | null;
  snippet: string;
}): string {
  return `Term: ${input.term}
Domain: ${input.domain}
Existing one-liner (L1): ${input.l1}
Project directory (context hint): ${input.projectName ?? "(unknown)"}

Source agent message the term appeared in:
<<<
${input.snippet}
>>>`;
}

export const expansionTool = {
  name: "emit_expansion",
  description: "Emit the two deeper explanation layers for one glossary term.",
  input_schema: {
    type: "object" as const,
    properties: {
      level2: {
        type: "string",
        description:
          "Basic concept: 3-4 sentences with an analogy, no assumed background",
      },
      level3: {
        type: "string",
        description:
          "Why the agent is using it in this session, grounded in the source message",
      },
    },
    required: ["level2", "level3"],
  },
};

// Forced tool use gives us schema-validated strict JSON output.
export const translationTool = {
  name: "emit_translation",
  description:
    "Emit the translation of one agent message: subtitle, inline annotations, and new glossary terms.",
  input_schema: {
    type: "object" as const,
    properties: {
      skip: {
        type: "boolean",
        description:
          "true for trivial messages (one-line acks, pure tool chatter) that should pass through untranslated",
      },
      subtitle: {
        type: "string",
        description:
          "1-3 plain-language sentences. Required unless skip is true.",
      },
      annotations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            span: {
              type: "string",
              description:
                "Exact substring of the original message to highlight",
            },
            sentence_rewrite: {
              type: "string",
              description:
                "Plain-language rewrite of the sentence the span appears in",
            },
            term_ref: {
              type: "string",
              description:
                "Canonical term this span belongs to (matches a terms[].term entry or an already-known term), if any",
            },
          },
          required: ["span", "sentence_rewrite"],
        },
      },
      terms: {
        type: "array",
        description: "At most 6 new glossary terms, most salient first",
        items: {
          type: "object",
          properties: {
            term: { type: "string" },
            domain: {
              type: "string",
              description:
                "Short domain label, reusing existing session domains when close",
            },
            level1: {
              type: "string",
              description: "One-line explanation a non-expert can follow",
            },
            salience: { type: "number", description: "0-1" },
            kind: {
              type: "string",
              enum: ["keyword", "term", "initial"],
              description:
                "initial = acronym/initialism; keyword = named artifact (file/library/function/command); term = domain term of art",
            },
          },
          required: ["term", "domain", "level1", "salience", "kind"],
        },
      },
      importance: {
        type: "number",
        description:
          "0-1: how much a busy user catching up needs this message. Failures, risky decisions, and final outcomes ≥ 0.9; plans/meaningful results 0.7-0.8; routine narration 0.3-0.6; filler ≤ 0.2.",
      },
    },
    required: ["skip"],
  },
};

// --- Session digests (collapse hours/days of stream into rollup cards) ----
//
// Digests summarize a contiguous run of already-translated messages using
// their SUBTITLES (already compressed), so a whole afternoon rolls up in one
// small call. Same trust rules: a digest is a collapse, never a spin layer.

export function digestSystemPrompt(): string {
  return `You are unjargon, a live subtitle layer for AI agents. The user was away while their agent worked; you are writing the rollup card that stands in for a stretch of the message stream.

Write a digest of the agent activity below in 2-4 plain-language sentences: what the agent set out to do, what actually happened, and where things stand now.

Rules (non-negotiable):
- never soften failures: if anything failed, errored, or was left broken or unresolved, the digest MUST say so plainly — an unresolved failure belongs in the FIRST sentence
- copy numbers, outcomes, and file names verbatim
- describe outcomes, not process: "swapped RK4 for BDF, 12 tests pass, 40× faster" beats a play-by-play
- plain language for a non-expert; do not introduce jargon the lines below don't already explain`;
}

export function digestUserPrompt(input: {
  projectName?: string | null;
  lines: string[]; // "[HH:MM] subtitle-or-text" entries, oldest first
}): string {
  return `Project directory (context hint): ${input.projectName ?? "(unknown)"}

Agent activity, oldest first:
${input.lines.join("\n")}`;
}

export const digestTool = {
  name: "emit_digest",
  description: "Emit the rollup digest for one stretch of agent activity.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description: "2-4 plain-language sentences; failures first, outcomes verbatim",
      },
    },
    required: ["summary"],
  },
};

// Headless variant for collectors doing digest work with the user's own AI
// CLI (served via GET /api/work/digest — prompting stays in this file).
export function localDigestPrompt(input: {
  projectName?: string | null;
  lines: string[];
}): string {
  return `${digestSystemPrompt()}

You are running headless. Reply with ONLY one JSON object, no prose, no markdown fences:
{ "summary": "2-4 plain-language sentences" }

${digestUserPrompt(input)}`;
}
