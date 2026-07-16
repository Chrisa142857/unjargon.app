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
4. "terms" — glossary entries for terms a non-expert wouldn't know, skipping common words and terms already in the user's known list. Reuse existing domain labels when close (e.g. don't create "Numerics" if "Numerical Methods" exists). level1 is a one-line explanation. salience 0-1 rates how central the term is to understanding this message.

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
          },
          required: ["term", "domain", "level1", "salience"],
        },
      },
    },
    required: ["skip"],
  },
};
