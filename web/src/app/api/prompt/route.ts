import { db, tables } from "@/db";
import { localTranslationTemplate } from "@/lib/prompts";
import { getCalibration } from "@/lib/settings";

export const dynamic = "force-dynamic";

// The translation prompt template for collectors running local-translate
// mode (user's own AI CLI). Served from here so all prompting stays in
// src/lib/prompts.ts — collectors never hard-code prompts. The current
// glossary and domain labels are baked in for dedupe, so collectors should
// re-fetch frequently (they cache for ~30s).
export async function GET() {
  const terms = await db
    .select({ term: tables.terms.term, domain: tables.terms.domain })
    .from(tables.terms)
    .limit(120);
  const domains = [...new Set(terms.map((t) => t.domain))];
  return Response.json({
    template: localTranslationTemplate(
      await getCalibration(),
      terms.map((t) => t.term),
      domains,
    ),
  });
}
