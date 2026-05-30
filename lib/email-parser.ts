import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import lunary from "lunary";
import { z } from "zod";
import { acquireGeminiSlot } from "@/lib/ai/rate-limit";
import { loadPrompt } from "@/lib/ai/prompts";
import { cacheKey, llmCached } from "@/lib/ai/llm-cache";

// Single source of truth for the model id. Kept in sync with `MODEL_LITE` in
// lib/ai/gemini.ts; there's no shared symbol because the Vercel AI SDK wraps
// the model name into a provider call inline. Bumping the model means
// editing this line + MODEL_LITE — the [FIXTURE] log, the Lunary trace
// `extra.model`, and the actual SDK call all read from here so the trace
// can never disagree with what really ran.
const MODEL_ID = "gemini-3.1-flash-lite";

// LOP-5: this callsite bypasses `chatJSON` (uses Vercel AI SDK directly) so
// LOP-3's wrapModel can't reach it. Track manually instead. Same gate as
// gemini.ts so dev / CI runs without the key are a no-op.
//
// Read at call time, NOT module-init — matches lib/ai/prompts.ts:lunaryEnabled.
// Module-init read would freeze the choice on first import, so an ad-hoc tsx
// script that imports email-parser before its env loader runs would silently
// lose all traces even after the key was populated.
function lunaryEnabled(): boolean {
    return Boolean(process.env.LUNARY_PUBLIC_KEY);
}

// Defensive wrapper — a Lunary failure must never disrupt email ingest.
function safeTrack(event: "start" | "end" | "error", data: Record<string, unknown>): void {
    if (!lunaryEnabled()) return;
    try {
        // trackEvent's `Partial<RunEvent>` has an index signature, so the
        // top-level `name` from this object lands as the run name.
        lunary.trackEvent("llm", event, data);
    } catch (e) {
        console.warn(`[LUNARY] email-parser ${event} track failed:`, e);
    }
}

// `@ai-sdk/google` defaults to reading `GOOGLE_GENERATIVE_AI_API_KEY`. The rest
// of the codebase (lib/ai/gemini.ts) uses `GOOGLE_GENERATIVE_AI_KEY` and falls
// back to GOOGLE_GEN_AI_KEY / GEMINI_API_KEY / GOOGLE_API_KEY. Without this
// shim the email classifier would silently throw on every relevant message —
// "skipped" counts in the backfill toast hid the real failure.
function resolveGeminiKey(): string | undefined {
    return process.env.GOOGLE_GENERATIVE_AI_API_KEY
        || process.env.GOOGLE_GENERATIVE_AI_KEY
        || process.env.GOOGLE_GEN_AI_KEY
        || process.env.GEMINI_API_KEY
        || process.env.GOOGLE_API_KEY;
}

let cachedProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;
function getProvider() {
    if (cachedProvider) return cachedProvider;
    const apiKey = resolveGeminiKey();
    if (!apiKey) {
        throw new Error(
            "No Google GenAI key found. Set GOOGLE_GENERATIVE_AI_KEY (preferred) or one of "
            + "GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_GEN_AI_KEY / GEMINI_API_KEY / GOOGLE_API_KEY "
            + "in .env. Get a free key at https://aistudio.google.com/apikey.",
        );
    }
    cachedProvider = createGoogleGenerativeAI({ apiKey });
    return cachedProvider;
}

/**
 * Output of the LLM email classifier.
 *
 * `isApplicationRelated` is the relevance gate — when false, callers should
 * skip the upsert. The keyword pre-filter (lib/applications/relevance.ts) is
 * intentionally generous to avoid false negatives, so the classifier needs to
 * be the final say on whether an email actually represents an application
 * event.
 */
export const applicationSchema = z.object({
  isApplicationRelated: z.boolean().describe(
    "True if and only if this email is about an actual application the user submitted (job, internship, or college/university). False for newsletters, recruiter cold outreach with no prior application, marketing, job board digests, or generic 'we're hiring' announcements."
  ),
  confidence: z.enum(["low", "medium", "high"]).describe(
    "How confident you are in the classification. Use 'low' if the email is ambiguous or you had to guess heavily."
  ),
  kind: z.enum(["job", "internship", "college", "other"]).describe(
    "What type of application. 'college' covers undergraduate/graduate admissions, university programs, and bootcamps with an admissions process. 'internship' for explicitly internship/co-op roles. 'job' for full-time, part-time, or contract employment. 'other' for anything that's still application-related but doesn't fit (scholarships, fellowships, grants, residencies, etc.)."
  ),
  company: z.string().describe(
    "The name of the company, university, or institution. Strip suffixes like 'LLC', 'Inc.', 'Corp.', 'Recruiting', 'Careers', 'Office of Admissions'. " +
    "For colleges/universities, ALWAYS use the FULL OFFICIAL name without abbreviation and without internal commas — examples: 'Massachusetts Institute of Technology' (NOT 'MIT', NOT 'MIT Office of Admissions'); " +
    "'California State University Long Beach' (NOT 'CSULB', NOT 'Cal State Long Beach', NOT 'California State University, Long Beach'); " +
    "'University of California Berkeley' (NOT 'UC Berkeley', NOT 'Cal'). " +
    "Be deterministic — every email from the same school MUST produce the exact same string."
  ),
  role: z.string().optional().describe(
    "Job title, program name, or role applied for. For colleges, use the program/major (e.g. 'Computer Science BS'). Leave empty if truly not mentioned."
  ),
  status: z
    .enum([
      "APPLIED",
      "UPDATED",
      "ASSESSMENT",
      "INTERVIEW_REQUESTED",
      "INTERVIEW",
      "OFFER",
      "REJECTED",
    ])
    .describe(
      "Closest match for current status. APPLIED = confirmation of submission. UPDATED = generic status update / 'still under review' / additional info requested. ASSESSMENT = take-home / coding test / portfolio request / college supplemental materials request. INTERVIEW_REQUESTED = asked to schedule. INTERVIEW = scheduled or completed. OFFER = job offer OR college admission OR waitlist-with-action OR scholarship offer. REJECTED = denial OR college reject/deferred-as-rejection."
    ),
  nextSteps: z.string().optional().describe(
    "One-sentence summary of what the applicant needs to do next, e.g. 'Reply with availability for a 30-min call' or 'Submit official transcripts by Mar 1'. Omit if no action is required."
  ),
  extractedDates: z
    .array(
      z.object({
        rawText: z
          .string()
          .describe("Original wording from the email, including timezone if given."),
        kind: z
          .enum(["INTERVIEW", "ASSESSMENT", "DEADLINE", "DECISION", "OTHER"])
          .describe(
            "What this date represents. INTERVIEW = scheduled call/meeting. ASSESSMENT = take-home or coding test deadline. DEADLINE = action deadline (transcripts, materials). DECISION = the day they say they'll decide. OTHER = anything else."
          ),
        startsAt: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp if a specific datetime is given. Convert relative phrasing using the email's send date as the anchor. Omit if only a vague date is mentioned."
          ),
        endsAt: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp for end if a duration or end-time is given."),
      })
    )
    .optional()
    .describe(
      "Distinct deadlines, interview times, or decision dates mentioned. Use the email's own header date to resolve relative references like 'Tuesday at 3pm'."
    ),
});

export type ParsedApplicationEmail = z.infer<typeof applicationSchema>;

export async function parseApplicationEmail(
  emailContent: string,
  subject: string,
  from?: string,
  sentAt?: Date
): Promise<ParsedApplicationEmail> {
  // Trim long bodies — application emails put the signal up top (greeting,
  // status verb, action ask). 3KB captures the meaningful portion; the rest
  // is signature blocks, legal boilerplate, and forwarded threads. Tightened
  // from 6KB on 2026-05-19 alongside the model swap to flash-lite — see
  // docs/llm-calls.html.
  const trimmedBody = emailContent.length > 3000 ? emailContent.slice(0, 3000) + "\n…[truncated]" : emailContent;
  const anchor = (sentAt ?? new Date()).toISOString();

  // email-parser's disk doc has no separate system field — the entire
  // instruction set + interleaved inputs is one user-mode prompt that
  // Vercel AI SDK takes as `prompt: string`. Loaded BEFORE the cache check
  // because the rendered prompt IS the cache key (along with the schema).
  const loaded = await loadPrompt("email-parser", {
    anchor,
    from: from ?? "(unknown)",
    subject,
    body: trimmedBody,
  });
  const prompt = loaded.user;

  // LOP-9: same fixture-capture seam as lib/ai/gemini.ts:chatJSON. This
  // callsite bypasses chatJSON (Vercel AI SDK), so the gate has to live here
  // too. Toggle via `CAPTURE_FIXTURES=1 pm2 restart mission-control-dev --update-env`.
  if (process.env.CAPTURE_FIXTURES === "1") {
    console.info("[FIXTURE]", JSON.stringify({
      name: "email-parser",
      model: MODEL_ID,
      system: undefined,
      user: prompt,
    }));
  }

  // Cross-tier dedup (docs/archive/cross-tier-llm-dedup.html): the same email is
  // delivered to BOTH webhooks by the Gmail push fan-out within ~the same
  // second — this makes exactly one tier call Gemini, the other reuses. The
  // anchor (sentAt) is part of the rendered prompt, so the key is stable
  // across tiers for the same message. Slot acquisition + the SDK call +
  // Lunary tracing all live INSIDE compute(), so a cache hit / follower spends
  // no rate token, makes no API call, and is NOT traced as a model call.
  const key = cacheKey({ model: MODEL_ID, user: prompt, schema: applicationSchema });
  return llmCached({ key, name: "email-parser", model: MODEL_ID }, async () => {
    // PC-6 (RAH-12): block on the token bucket BEFORE the API call. A backfill
    // (or pre-PB-6 redelivery storm) can blow Gemini's free-tier 15/min cap in
    // seconds otherwise.
    await acquireGeminiSlot();

    // LOP-5: trace start. RunId is a fresh cuid-ish — the Gmail msgId isn't in
    // scope here (caller has it), and Lunary just needs uniqueness.
    const runId = `email-parser:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    safeTrack("start", {
      runId,
      name: "email-parser",
      input: [{ role: "user", content: prompt }],
      extra: { model: MODEL_ID, anchor, from, subject },
    });

    try {
      const result = await generateObject({
        // Pinned to Gemini 3.1 Flash-lite (via MODEL_ID) — the highest-volume
        // caller in the app (one call per inbound Gmail message + backfill).
        // Mechanical extraction (relevance gate + a handful of structured
        // fields) doesn't need full Flash. See docs/llm-calls.html.
        model: getProvider()(MODEL_ID),
        schema: applicationSchema,
        prompt,
      });

      safeTrack("end", {
        runId,
        output: { role: "assistant", content: JSON.stringify(result.object) },
        tokensUsage: {
          prompt: result.usage?.inputTokens ?? 0,
          completion: result.usage?.outputTokens ?? 0,
        },
      });

      return result.object;
    } catch (err) {
      safeTrack("error", {
        runId,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });
}
