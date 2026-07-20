// The only prompt left in unjargon is for an in-session explanation a user
// explicitly confirms. Basic public references never call AI.

export const EXPLANATION_MODEL =
  process.env.TRANSLATE_MODEL ?? "claude-haiku-4-5-20251001";

export type CalibrationLevel = "new" | "amateur" | "expert";

const CALIBRATION_DESCRIPTIONS: Record<CalibrationLevel, string> = {
  new: "completely new to this domain — explain with everyday language and analogies",
  amateur: "a technical amateur — comfortable with general technical ideas, but not this domain's specialist vocabulary",
  expert: "an expert in adjacent fields — keep it terse",
};

export function groundingSystemPrompt(level: CalibrationLevel): string {
  return `You are unjargon, a glossary for users delegating work to AI agents. The user explicitly requested why a detected term matters in their session. They are ${CALIBRATION_DESCRIPTIONS[level]}.

Produce, via the emit_grounding tool, "level3" — why the term is used in the provided source message. Never invent facts; preserve numbers, outcomes, and filenames verbatim.`;
}

export function groundingUserPrompt(input: {
  term: string;
  domain: string;
  l1: string;
  snippet: string;
}): string {
  return `Term: ${input.term}\nDomain: ${input.domain}\nDetector note: ${input.l1}\n\nSource agent message:\n<<<\n${input.snippet}\n>>>`;
}

const HEADLESS_TEXT_RULE = `\n\nYou are running headless with no tools. Reply with ONLY one JSON object — no prose or markdown — of the form {"text": "<the explanation>"}.`;

export function localGroundingPrompt(
  level: CalibrationLevel,
  input: { term: string; domain: string; l1: string; snippet: string },
): string {
  return `${groundingSystemPrompt(level)}\n\n${groundingUserPrompt(input)}${HEADLESS_TEXT_RULE}`;
}

export const groundingTool = {
  name: "emit_grounding",
  description: "Emit the in-your-session explanation layer for one glossary term.",
  input_schema: {
    type: "object" as const,
    properties: { level3: { type: "string" } },
    required: ["level3"],
  },
};
