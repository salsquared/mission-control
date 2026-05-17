import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

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
    "The name of the company, university, or institution. Strip suffixes like 'LLC', 'Inc.', 'Corp.', 'Recruiting', 'Careers'. For colleges, use the canonical name (e.g. 'Massachusetts Institute of Technology', not 'MIT Office of Admissions')."
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
  // Trim long bodies — Gemini Flash can handle the full thing but most
  // signal is in the first ~4k chars (greetings, status, action items).
  const trimmedBody = emailContent.length > 6000 ? emailContent.slice(0, 6000) + "\n…[truncated]" : emailContent;
  const anchor = (sentAt ?? new Date()).toISOString();

  const result = await generateObject({
    // `gemini-flash-latest` is Google's auto-tracking alias for current stable
    // Flash. Same model lib/ai/gemini.ts pins. `gemini-3.0-flash` (the previous
    // value here) doesn't exist on v1beta and threw on every classify call.
    model: getProvider()("gemini-flash-latest"),
    schema: applicationSchema,
    prompt: `You are classifying an email related to a job, internship, or college/university application.

First, decide whether this email is actually about the user's own application (they submitted something and this is a status update or related message). Marketing, job-board digests, recruiter cold-outreach to someone who never applied, and "we're hiring" company announcements are NOT application-related — set isApplicationRelated=false.

If it IS application-related, extract company/institution, role/program, current status, next steps, and any dates.

For colleges, treat admission/decision/waitlist/deferral language as the corresponding status. Treat supplemental-material requests as ASSESSMENT.

When resolving relative dates like "Tuesday at 3pm" or "next week", use the email's send-date below as the anchor.

Email send-date (anchor): ${anchor}
From: ${from ?? "(unknown)"}
Subject: ${subject}
Body:
${trimmedBody}`,
  });

  return result.object;
}
