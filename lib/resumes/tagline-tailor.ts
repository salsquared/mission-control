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
import type { ResumeSelection, BulletSelection } from "@/lib/resumes/select";
import type { findOrCreateProfile } from "@/lib/repositories/profile";

// Hydrated shape (Date columns) is what tagline-draft's helper takes; the
// resumes route passes the JSON-roundtripped ProfileWire shape (Date → string)
// after the auto-tag re-hydration. buildProfileSummary only reads spine text +
// bullet text + scratchpad text — none of which are Date-typed — so the cast
// is runtime-safe.
type HydratedProfile = Awaited<ReturnType<typeof findOrCreateProfile>>;
type ProfileLike = HydratedProfile | (object & { headline?: string | null });

// 256 was sized for tagline-only; 1024 gives comfortable headroom for the
// new sectionOrder + entityOrder fields plus the tagline. Each ordering
// entry is ~12–25 tokens; entityOrder per section may list 5–10 IDs at
// ~25 chars each; the JSON wrapper adds another ~50 tokens. Live data
// showed 240-token clip at the 256 cap — 1024 leaves 4× margin.
const TAILOR_MAX_OUTPUT_TOKENS = 1024;
const TAILOR_TEMPERATURE = 0.4;

export type SectionKey =
    | "experience"
    | "projects"
    | "education"
    | "skills"
    | "languages"
    | "interests";

export const DEFAULT_SECTION_ORDER: readonly SectionKey[] = [
    "experience",
    "projects",
    "education",
    "skills",
    "languages",
    "interests",
];

const SectionKeySchema = z.enum([
    "experience",
    "projects",
    "education",
    "skills",
    "languages",
    "interests",
]);

const EntityOrderSchema = z.object({
    experience: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(),
    education: z.array(z.string()).optional(),
}).optional();

const ResponseSchema = z.object({
    tagline: z.string().min(1).max(500),
    sectionOrder: z.array(SectionKeySchema).optional(),
    entityOrder: EntityOrderSchema,
});

export interface TailorTaglineInput {
    profile: ProfileLike;
    posting: ParsedPosting;
    // Optional. When provided, `entityIdsBlock` is built from the SELECTION
    // (only entities that survived the bullet-scorer) with their matched
    // tags + sample bullet text — giving the LLM evidence-grounded info for
    // entity ordering. Without it, the block falls back to name-only entries
    // from the full profile (legacy behavior).
    //
    // Why this matters: the one-page pruner spares
    // `selection.{section}[0]` (= the LLM's #1 pick per section) as
    // unremovable. A name-only block led to "Avionics Engineer, Space
    // Enterprise at Berkeley" out-ranking Iris on a space-themed posting
    // purely because the SEB name has the word "Space" in it. Bullet
    // evidence in the same block as IDs lets the LLM judge on substance.
    selection?: ResumeSelection;
}

export interface TailorTaglineResult {
    tagline: string;
    sectionOrder: SectionKey[];
    entityOrder: {
        experience: string[];
        projects: string[];
        education: string[];
    };
    durationMs: number;
}

interface MinimalProfile {
    workRoles: ReadonlyArray<{ id: string; title?: string | null; company?: string | null }>;
    projects: ReadonlyArray<{ id: string; name?: string | null }>;
    education: ReadonlyArray<{ id: string; degree?: string | null; institution?: string | null }>;
}

// Fallback: name-only entity listing when no selection is supplied (e.g.
// the hermetic smoke that calls buildResumeTaglineVars without the resume-
// gen pipeline running). Lists EVERY entity on the profile, since we don't
// know which were selected.
function buildEntityIdsBlockNameOnly(profile: MinimalProfile): string {
    const parts: string[] = [];
    if (profile.workRoles.length > 0) {
        const lines = profile.workRoles.map(r => {
            const title = r.title?.trim() || "(untitled)";
            const company = r.company?.trim() || "(unknown company)";
            return `- ${r.id}: ${title} @ ${company}`;
        });
        parts.push(["### Experience", ...lines].join("\n"));
    }
    if (profile.projects.length > 0) {
        const lines = profile.projects.map(p => {
            const name = p.name?.trim() || "(unnamed)";
            return `- ${p.id}: ${name}`;
        });
        parts.push(["### Projects", ...lines].join("\n"));
    }
    if (profile.education.length > 0) {
        const lines = profile.education.map(e => {
            const degree = e.degree?.trim() || "Education";
            const inst = e.institution?.trim() || "(unknown institution)";
            return `- ${e.id}: ${degree} @ ${inst}`;
        });
        parts.push(["### Education", ...lines].join("\n"));
    }
    return parts.length > 0 ? parts.join("\n\n") : "(no entities)";
}

// Render one entity's evidence block. Lists matched tags collected across
// all its selected bullets + the aggregate score so the LLM can compare
// entity strength numerically when names are ambiguous. Bullet text itself
// is NOT included here — the full bullets are already in `profileSummary`
// and duplicating them inflated the prompt by ~1.8 KB per call.
function renderEntityEvidence(
    id: string,
    label: string,
    bullets: ReadonlyArray<BulletSelection>,
): string {
    const aggregate = bullets.reduce((acc, b) => acc + (Number.isFinite(b.score) ? Math.max(0, b.score) : 0), 0);
    const tagSet = new Set<string>();
    for (const b of bullets) {
        for (const t of b.matchedTags) tagSet.add(t);
        for (const k of b.matchedKeywords) tagSet.add(k);
    }
    const tagLine = tagSet.size > 0 ? `[matched: ${Array.from(tagSet).join(", ")}; aggregate-score=${aggregate}]` : `[no posting-keyword matches; aggregate-score=0]`;
    return `- ${id}: ${label} ${tagLine}`;
}

// Evidence-rich entity listing built from the resume-gen SELECTION (post-
// scoring, post-scratchpad-synth). Only includes entities that survived
// the selector. Each entry shows the entity ID + label + matched
// tags/keywords + top bullet excerpts. This is what the LLM needs to
// judge ordering by substance, not by name alone.
function buildEntityIdsBlockEvidence(selection: ResumeSelection): string {
    const parts: string[] = [];
    if (selection.workRoles.length > 0) {
        const blocks = selection.workRoles.map(g => {
            const wr = g.entity;
            const label = `${wr.title} @ ${wr.company}`;
            return renderEntityEvidence(wr.id, label, g.bullets);
        });
        parts.push(["### Experience", ...blocks].join("\n"));
    }
    if (selection.projects.length > 0) {
        const blocks = selection.projects.map(g => {
            const label = g.entity.name;
            return renderEntityEvidence(g.entity.id, label, g.bullets);
        });
        parts.push(["### Projects", ...blocks].join("\n"));
    }
    if (selection.education.length > 0) {
        const blocks = selection.education.map(g => {
            const ed = g.entity;
            const label = `${ed.degree ?? "Education"} @ ${ed.institution}`;
            return renderEntityEvidence(ed.id, label, g.bullets);
        });
        parts.push(["### Education", ...blocks].join("\n"));
    }
    return parts.length > 0 ? parts.join("\n\n") : "(no entities)";
}

/**
 * Build the {{var}} substitutions for the resume-tagline prompt. Pure — the
 * hermetic smoke calls this directly to assert prompt-render shape without
 * touching Gemini.
 */
export function buildResumeTaglineVars(input: TailorTaglineInput): PromptVars {
    const { profile, posting, selection } = input;
    return {
        postingTitle: posting.title ?? "(unknown)",
        postingCompany: posting.company ?? "(unknown)",
        postingSeniority: posting.seniority ?? "(unknown)",
        postingKeywordsBlock: posting.keywords.length > 0
            ? posting.keywords.map(k => `  - ${k}`).join("\n")
            : "  (none extracted)",
        profileSummary: buildProfileSummary(profile as HydratedProfile),
        entityIdsBlock: selection
            ? buildEntityIdsBlockEvidence(selection)
            : buildEntityIdsBlockNameOnly(profile as unknown as MinimalProfile),
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
    const sectionOrder = normalizeSectionOrder(response.sectionOrder);
    const entityOrder = normalizeEntityOrder(
        response.entityOrder,
        input.profile as unknown as MinimalProfile,
    );
    const durationMs = Date.now() - start;

    console.info(
        `[LLM] resume-tagline → ${tagline.length} chars / sections=[${sectionOrder.join(",")}] / ordered entities exp=${entityOrder.experience.length} proj=${entityOrder.projects.length} edu=${entityOrder.education.length} in ${durationMs}ms (posting=${input.posting.company ?? "?"} / ${input.posting.title ?? "?"})`,
    );

    return { tagline, sectionOrder, entityOrder, durationMs };
}

// Dedup + dropping unknowns + appending any defaults the model omitted so the
// returned order is always a permutation of the six section keys.
function normalizeSectionOrder(raw: SectionKey[] | undefined): SectionKey[] {
    if (!raw || raw.length === 0) return [...DEFAULT_SECTION_ORDER];
    const seen = new Set<SectionKey>();
    const out: SectionKey[] = [];
    for (const k of raw) {
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(k);
    }
    for (const k of DEFAULT_SECTION_ORDER) {
        if (!seen.has(k)) out.push(k);
    }
    return out;
}

// For each section, drop any ID the model invented (not present on the
// profile) and dedup; preserve the model's order for known IDs. Returns
// arrays (possibly empty) for all three sections so the caller can apply
// uniformly without null checks.
function normalizeEntityOrder(
    raw: { experience?: string[]; projects?: string[]; education?: string[] } | undefined,
    profile: MinimalProfile,
): TailorTaglineResult["entityOrder"] {
    const filterAndDedup = (ids: string[] | undefined, valid: Set<string>): string[] => {
        if (!ids) return [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const id of ids) {
            if (!valid.has(id) || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
        return out;
    };
    return {
        experience: filterAndDedup(raw?.experience, new Set(profile.workRoles.map(r => r.id))),
        projects: filterAndDedup(raw?.projects, new Set(profile.projects.map(p => p.id))),
        education: filterAndDedup(raw?.education, new Set(profile.education.map(e => e.id))),
    };
}
