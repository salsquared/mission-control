/**
 * Posting-tailored resume tagline. Sibling to `lib/profile/tagline-draft.ts`,
 * but grounded on BOTH the user's profile AND the parsed posting — so the
 * subtitle rendered under the resume's H1 reflects what the user is pitching
 * for THIS job, not their default profile pitch.
 *
 * Concrete example the user gave for why this exists: their profile.tagline
 * reads as a software-engineer pitch, but they sometimes apply to security-
 * guard openings. In that case the resume's subtitle should read something
 * like "Applied Math student at CSULB looking for work" — anchored on the
 * profile's evidence (education, work history) but framed for the posting.
 *
 * Invariants (system prompt + post-filter, mirroring tagline-draft):
 *   1. No fabrication — every claim must be evidenced by the profile.
 *   2. One sentence — collapse newlines, hard cap at 200 chars.
 *   3. Plain text — strip wrapping quotes, ensure trailing period.
 *   4. No first-person pronouns / possessives ("I", "my", "me").
 *
 * Caller posture: best-effort. Resume gen swallows AIErrors and falls back
 * to `profile.tagline` if this caller throws — failing to tailor the
 * tagline should never block the resume from generating.
 */

import { z } from "zod";
import { chatJSON, MODEL_LITE } from "@/lib/ai/gemini";
import { loadPrompt, loadPromptFromDisk, type PromptVars } from "@/lib/ai/prompts";
import { buildProfileSummary } from "@/lib/profile/tagline-draft";
import { postFilterTagline } from "@/lib/profile/tagline-draft";
import type { ParsedPosting } from "@/lib/resumes/posting";
import type { findOrCreateProfile } from "@/lib/repositories/profile";

// Hydrated shape (Date columns) is what tagline-draft's helper takes; the
// resumes route passes the JSON-roundtripped ProfileWire shape (Date → string)
// after the auto-tag re-hydration. buildProfileSummary only reads spine text +
// bullet text + scratchpad text — none of which are Date-typed — so the cast
// is runtime-safe.
type HydratedProfile = Awaited<ReturnType<typeof findOrCreateProfile>>;
type ProfileLike = HydratedProfile | (object & { headline?: string | null });

const TAILOR_MAX_OUTPUT_TOKENS = 256;
const TAILOR_TEMPERATURE = 0.4;

const ResponseSchema = z.object({
    tagline: z.string().min(1).max(500),
});

export interface TailorTaglineInput {
    profile: ProfileLike;
    posting: ParsedPosting;
}

export interface TailorTaglineResult {
    tagline: string;
    durationMs: number;
}

/**
 * Build the {{var}} substitutions for the resume-tagline prompt. Pure — the
 * hermetic smoke calls this directly to assert prompt-render shape without
 * touching Gemini.
 */
export function buildResumeTaglineVars(input: TailorTaglineInput): PromptVars {
    const { profile, posting } = input;
    return {
        postingTitle: posting.title ?? "(unknown)",
        postingCompany: posting.company ?? "(unknown)",
        postingSeniority: posting.seniority ?? "(unknown)",
        postingKeywordsBlock: posting.keywords.length > 0
            ? posting.keywords.map(k => `  - ${k}`).join("\n")
            : "  (none extracted)",
        profileSummary: buildProfileSummary(profile as HydratedProfile),
    };
}

/**
 * Render the user prompt verbatim through the disk snapshot — back-compat
 * shape for hermetic smokes that want to assert on the assembled text
 * without hitting Lunary or Gemini.
 */
export function buildResumeTaglineUserPrompt(input: TailorTaglineInput): string {
    return loadPromptFromDisk("resume-tagline", buildResumeTaglineVars(input)).user;
}

/**
 * Generate a posting-tailored tagline. Pure read — does NOT persist; caller
 * (the resumes POST route) writes the result to `GeneratedResume.tagline`.
 * Throws on Gemini errors; the route wraps + falls back to profile.tagline.
 */
export async function tailorResumeTagline(input: TailorTaglineInput): Promise<TailorTaglineResult> {
    const start = Date.now();

    const prompt = await loadPrompt("resume-tagline", buildResumeTaglineVars(input));

    const response = await chatJSON({
        name: "resume-tagline",
        system: prompt.system,
        user: prompt.user,
        schema: ResponseSchema,
        model: prompt.model ?? MODEL_LITE,
        maxOutputTokens: prompt.maxOutputTokens ?? TAILOR_MAX_OUTPUT_TOKENS,
        temperature: prompt.temperature ?? TAILOR_TEMPERATURE,
    });

    const tagline = postFilterTagline(response.tagline);
    const durationMs = Date.now() - start;

    console.info(
        `[LLM] resume-tagline → ${tagline.length} chars in ${durationMs}ms (posting=${input.posting.company ?? "?"} / ${input.posting.title ?? "?"})`,
    );

    return { tagline, durationMs };
}
