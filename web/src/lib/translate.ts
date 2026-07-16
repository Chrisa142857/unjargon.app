import Anthropic from "@anthropic-ai/sdk";
import { asc, eq, isNull } from "drizzle-orm";
import { db, tables } from "@/db";
import { publish } from "@/lib/bus";
import {
  TRANSLATION_MODEL,
  translationSystemPrompt,
  translationTool,
  translationUserPrompt,
  type CalibrationLevel,
} from "@/lib/prompts";

// The translation pipeline: ingest calls scheduleTranslation(sessionId);
// ~2s after the last message lands (streaming agents append in bursts, the
// debounce batches them), the session's untranslated messages are processed
// in order — one LLM call per message.

const DEBOUNCE_MS = 2000;
// Below this, a message can't contain explainable jargon worth a call.
const TRIVIAL_LENGTH = 20;
const CALIBRATION: CalibrationLevel = "new"; // slider comes later; default stop

type TranslationResult = {
  skip: boolean;
  subtitle?: string;
  annotations?: { span: string; sentence_rewrite: string; term_ref?: string }[];
  terms?: { term: string; domain: string; level1: string; salience: number }[];
};

const globalForTranslate = globalThis as unknown as {
  __unjargonTimers?: Map<number, ReturnType<typeof setTimeout>>;
  __unjargonRunning?: Set<number>;
};
const timers = (globalForTranslate.__unjargonTimers ??= new Map());
const running = (globalForTranslate.__unjargonRunning ??= new Set());

export function scheduleTranslation(sessionId: number) {
  const existing = timers.get(sessionId);
  if (existing) clearTimeout(existing);
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId);
      drainSession(sessionId).catch((err) =>
        console.error(`[translate] session ${sessionId} drain failed:`, err),
      );
    }, DEBOUNCE_MS),
  );
}

async function drainSession(sessionId: number) {
  if (running.has(sessionId)) {
    scheduleTranslation(sessionId); // busy — come back after this drain
    return;
  }
  running.add(sessionId);
  try {
    for (;;) {
      const pending = await db
        .select()
        .from(tables.messages)
        .where(isNull(tables.messages.translatedAt))
        .orderBy(asc(tables.messages.id));
      const mine = pending.filter((m) => m.sessionId === sessionId);
      if (mine.length === 0) return;
      for (const msg of mine) {
        await translateMessage(msg);
      }
    }
  } finally {
    running.delete(sessionId);
  }
}

async function translateMessage(msg: typeof tables.messages.$inferSelect) {
  let result: TranslationResult;
  if (msg.text.trim().length < TRIVIAL_LENGTH) {
    result = { skip: true };
  } else {
    try {
      result = await callTranslator(msg);
    } catch (err) {
      console.error(`[translate] message ${msg.id} failed, passing through:`, err);
      result = { skip: true };
    }
  }
  await storeResult(msg, sanitize(result, msg.text));
}

// Defensive post-processing: the model is prompted with the trust rules, but
// the caps and "spans must exist in the text" are enforced here too.
function sanitize(result: TranslationResult, text: string): TranslationResult {
  if (result.skip || !result.subtitle?.trim()) return { skip: true };
  const annotations = (result.annotations ?? [])
    .filter(
      (a) =>
        a &&
        typeof a.span === "string" &&
        a.span.trim() !== "" &&
        typeof a.sentence_rewrite === "string" &&
        text.includes(a.span),
    )
    .slice(0, 12);
  const terms = (result.terms ?? [])
    .filter(
      (t) =>
        t &&
        typeof t.term === "string" &&
        t.term.trim() !== "" &&
        typeof t.level1 === "string",
    )
    .slice(0, 6) // cap ~6 new terms/message
    .map((t) => ({
      ...t,
      domain: t.domain?.trim() || "General",
      salience: Math.min(1, Math.max(0, Number(t.salience) || 0.5)),
    }));
  return { skip: false, subtitle: result.subtitle.trim(), annotations, terms };
}

async function callTranslator(
  msg: typeof tables.messages.$inferSelect,
): Promise<TranslationResult> {
  if (process.env.UNJARGON_FAKE_TRANSLATOR === "1") {
    return fakeTranslate(msg.text);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY not set (set it, or UNJARGON_FAKE_TRANSLATOR=1 for offline dev)",
    );
  }

  const [session] = await db
    .select()
    .from(tables.sessions)
    .where(eq(tables.sessions.id, msg.sessionId));
  const projectName = session?.cwd?.split("/").filter(Boolean).pop() ?? null;

  // Known terms for dedupe (single-user MVP: the whole glossary, capped).
  const known = await db
    .select({ term: tables.terms.term })
    .from(tables.terms)
    .limit(80);

  const client = new Anthropic();
  const resp = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 1500,
    system: translationSystemPrompt(CALIBRATION),
    messages: [
      {
        role: "user",
        content: translationUserPrompt({
          text: msg.text,
          projectName,
          knownTerms: known.map((k) => k.term),
        }),
      },
    ],
    tools: [translationTool],
    tool_choice: { type: "tool", name: "emit_translation" },
  });
  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("no tool_use block in response");
  }
  return block.input as TranslationResult;
}

async function storeResult(
  msg: typeof tables.messages.$inferSelect,
  result: TranslationResult,
) {
  const now = new Date();
  const subtitle = result.skip ? null : (result.subtitle ?? null);

  await db
    .update(tables.messages)
    .set({ subtitle, translatedAt: now })
    .where(eq(tables.messages.id, msg.id));

  const storedAnnotations: TranslationEventAnnotations = [];
  const newTerms: TranslationEventTerms = [];

  if (!result.skip) {
    // Upsert terms (first-seen wins), record sightings.
    const termIdByKey = new Map<string, number>();
    for (const t of result.terms ?? []) {
      const key = t.term.trim().toLowerCase();
      const inserted = await db
        .insert(tables.terms)
        .values({
          key,
          term: t.term.trim(),
          domain: t.domain,
          l1: t.level1,
          salience: t.salience,
        })
        .onConflictDoNothing({ target: tables.terms.key })
        .returning();
      let row = inserted[0];
      const isNew = !!row;
      if (!row) {
        [row] = await db
          .select()
          .from(tables.terms)
          .where(eq(tables.terms.key, key));
      }
      if (!row) continue;
      termIdByKey.set(key, row.id);
      if (isNew) {
        newTerms.push({
          id: row.id,
          term: row.term,
          domain: row.domain,
          l1: row.l1,
          salience: row.salience,
        });
      }
      await db
        .insert(tables.termSightings)
        .values({ termId: row.id, messageId: msg.id });
    }

    for (const a of result.annotations ?? []) {
      let termId: number | null = null;
      const refKey = a.term_ref?.trim().toLowerCase();
      if (refKey) {
        termId = termIdByKey.get(refKey) ?? null;
        if (termId === null) {
          const [existing] = await db
            .select({ id: tables.terms.id })
            .from(tables.terms)
            .where(eq(tables.terms.key, refKey));
          termId = existing?.id ?? null;
        }
      }
      const [row] = await db
        .insert(tables.annotations)
        .values({
          messageId: msg.id,
          span: a.span,
          sentenceRewrite: a.sentence_rewrite,
          termId,
        })
        .returning();
      storedAnnotations.push({
        id: row.id,
        span: row.span,
        sentenceRewrite: row.sentenceRewrite,
        termId: row.termId,
      });
    }
  }

  publish({
    type: "translation",
    messageId: msg.id,
    sessionId: msg.sessionId,
    subtitle,
    annotations: storedAnnotations,
    newTerms,
  });
}

type TranslationEventAnnotations = {
  id: number;
  span: string;
  sentenceRewrite: string;
  termId: number | null;
}[];
type TranslationEventTerms = {
  id: number;
  term: string;
  domain: string;
  l1: string;
  salience: number | null;
}[];

// ---------------------------------------------------------------------------
// Offline fake translator (UNJARGON_FAKE_TRANSLATOR=1).
//
// Deterministic, no network: canned translations for the recorded fixture and
// a naive fallback for anything else. Exists so the full pipeline (debounce →
// store → SSE → UI) can be developed, tested, and demoed with zero API
// dependency. Every use is logged loudly — this must never silently stand in
// for the real model.

const FAKE_FIXTURE: {
  match: string;
  result: TranslationResult;
}[] = [
  {
    match: "I'll check your simulation code",
    result: {
      skip: false,
      subtitle:
        "Looking through your simulation code for the part that advances time step by step — that's the usual suspect when runs are slow or crash with NaNs.",
      annotations: [
        {
          span: "integrator",
          sentence_rewrite:
            "The piece of code that advances the simulation through time is the likely culprit.",
          term_ref: "integrator",
        },
        {
          span: "NaN",
          sentence_rewrite:
            "NaN (\"not a number\") is what shows up when a calculation breaks down completely.",
          term_ref: "NaN",
        },
      ],
      terms: [
        {
          term: "integrator",
          domain: "Numerical Methods",
          level1:
            "The piece of code that advances a simulation through time, step by step.",
          salience: 0.8,
        },
        {
          term: "NaN",
          domain: "Programming",
          level1:
            "\"Not a number\" — the value a calculation produces when it has broken down (e.g. divided by zero).",
          salience: 0.6,
        },
      ],
    },
  },
  {
    match: "The ODE system is stiff",
    result: {
      skip: false,
      subtitle:
        "Your system mixes very fast and very slow changes (\"stiff\"), which makes the current solver unstable — that's where the NaN blowups come from. It's switching to a solver that stays stable with big time steps (BDF via scipy.integrate.solve_ivp), then re-running the regression tests to confirm nothing changes numerically.",
      annotations: [
        {
          span: "stiff",
          sentence_rewrite:
            "Your equations mix very fast and very slow changes, which breaks simple step-by-step solvers.",
          term_ref: "stiff ODE",
        },
        {
          span: "Jacobian eigenvalues span ~6 orders of magnitude",
          sentence_rewrite:
            "The fastest process in your model is about a million times faster than the slowest.",
          term_ref: "Jacobian",
        },
        {
          span: "RK4",
          sentence_rewrite:
            "The current solver (RK4) must take impractically tiny steps to stay accurate here.",
          term_ref: "RK4",
        },
        {
          span: "BDF",
          sentence_rewrite:
            "BDF is a solver built for exactly this fast-plus-slow situation.",
          term_ref: "BDF",
        },
        {
          span: "scipy.integrate.solve_ivp",
          sentence_rewrite:
            "It will use a standard, well-tested scientific library function instead of hand-written code.",
          term_ref: "scipy.solve_ivp",
        },
        {
          span: "regression tests",
          sentence_rewrite:
            "Afterwards it re-runs your existing checks to confirm the results don't change.",
          term_ref: "regression tests",
        },
      ],
      terms: [
        {
          term: "stiff ODE",
          domain: "Numerical Methods",
          level1:
            "An equation system mixing very fast and very slow changes — simple solvers must crawl or they blow up.",
          salience: 0.9,
        },
        {
          term: "RK4",
          domain: "Numerical Methods",
          level1:
            "A classic simulation stepper: accurate on gentle problems, unstable on stiff ones unless steps are tiny.",
          salience: 0.7,
        },
        {
          term: "BDF",
          domain: "Numerical Methods",
          level1:
            "A solver family designed for stiff systems — stays stable even with large time steps.",
          salience: 0.8,
        },
        {
          term: "Jacobian",
          domain: "Numerical Methods",
          level1:
            "A table of how strongly each variable pushes on every other — its spread tells you how stiff the system is.",
          salience: 0.5,
        },
        {
          term: "scipy.solve_ivp",
          domain: "Scientific Python",
          level1:
            "The standard Python library function for solving differential equations over time.",
          salience: 0.5,
        },
        {
          term: "regression tests",
          domain: "Testing",
          level1:
            "Automated checks that previously-working behavior still works after a change.",
          salience: 0.6,
        },
      ],
    },
  },
  {
    match: "OK, running the tests now",
    result: { skip: true },
  },
  {
    match: "all 12 regression tests pass",
    result: {
      skip: false,
      subtitle:
        "Done — all 12 regression tests pass and the benchmark now finishes in 3.1s vs 127.4s, about 40× faster. The NaN blowups should be gone because the new solver stays stable on stiff systems. Note: test_energy_conservation was already marked as expected-to-fail before this change and was left that way.",
      annotations: [
        {
          span: "A-stable",
          sentence_rewrite:
            "The new solver is guaranteed not to blow up no matter how big the time step gets.",
          term_ref: "A-stable",
        },
        {
          span: "xfail",
          sentence_rewrite:
            "That test was already marked \"expected to fail\" before this change — the agent didn't hide it.",
          term_ref: "xfail",
        },
        {
          span: "requirements.txt",
          sentence_rewrite:
            "The project's list of required libraries was updated to demand a newer scipy.",
          term_ref: "requirements.txt",
        },
      ],
      terms: [
        {
          term: "A-stable",
          domain: "Numerical Methods",
          level1:
            "A guarantee that a solver won't blow up regardless of step size.",
          salience: 0.6,
        },
        {
          term: "xfail",
          domain: "Testing",
          level1:
            "A test marked \"expected to fail\" — it's known-broken and doesn't count against the suite.",
          salience: 0.5,
        },
        {
          term: "requirements.txt",
          domain: "Scientific Python",
          level1: "The file listing which libraries (and versions) a Python project needs.",
          salience: 0.3,
        },
      ],
    },
  },
];

function fakeTranslate(text: string): TranslationResult {
  console.warn("[translate] UNJARGON_FAKE_TRANSLATOR=1 — using offline fake, NOT the real model");
  for (const f of FAKE_FIXTURE) {
    if (text.includes(f.match)) return f.result;
  }
  const sentences = text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return { skip: false, subtitle: sentences, annotations: [], terms: [] };
}
