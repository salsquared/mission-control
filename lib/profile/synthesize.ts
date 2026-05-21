/**
 * Master-resume synthesis pass.
 *
 * Takes the existing profile snapshot + every per-file extracted tree from one
 * import session and asks Gemini Flash to produce a single, canonical
 * `ExtractedProfile`. This consolidated tree is what gets fed into the
 * deterministic merge. The output IS the user's "master template" — what the
 * profile dash shows and what per-job tailoring (`lib/resumes/rewrite.ts`)
 * pulls from.
 *
 * Why a second LLM pass instead of merging more aggressively in code:
 *   - Per-file extraction is verbatim-preserving (LITE model). It happily emits
 *     "Iris" as a work role in one file and as a project in another because
 *     each file is processed in isolation.
 *   - Reconciling that across files needs judgment: which classification is
 *     right? Which wording wins when two files describe the same accomplishment
 *     differently? That's what a higher-quality model gets us.
 *
 * Uses MODEL_FLASH because the output is the canonical resume the user sees +
 * the substrate every tailored variant rewrites from. Extraction stays on
 * MODEL_LITE (cheap, mechanical). One Flash call per import is the cost.
 */
import { z } from "zod";
import { chatJSON, MODEL_FLASH } from "@/lib/ai/gemini";
import type { ExtractedProfile } from "@/lib/profile/import-llm";
import type { ExistingProfileForMerge } from "@/lib/profile/merge";

const HeaderSchema = z.object({
    headline: z.string().nullable(),
    summary: z.string().nullable(),
    location: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    links: z.array(z.object({ label: z.string(), url: z.string() })).nullable(),
});

const WorkRoleSchema = z.object({
    company: z.string(),
    title: z.string(),
    location: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    bullets: z.array(z.string()),
});

const ProjectSchema = z.object({
    name: z.string(),
    description: z.string().nullable(),
    repoUrl: z.string().nullable(),
    liveUrl: z.string().nullable(),
    bullets: z.array(z.string()),
});

const EducationSchema = z.object({
    institution: z.string(),
    degree: z.string().nullable(),
    field: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    bullets: z.array(z.string()),
});

const SynthesizedSchema = z.object({
    header: HeaderSchema,
    workRoles: z.array(WorkRoleSchema),
    projects: z.array(ProjectSchema),
    education: z.array(EducationSchema),
});

const SYSTEM_PROMPT = [
    "You are a resume curator. You combine multiple resume drafts and an existing profile into ONE canonical master resume — the version the candidate will use as the source-of-truth for all future job applications.",
    "",
    "Inputs you receive:",
    "  EXISTING — the user's current profile (entities they already have). Do not duplicate these in your output unless you are merging new bullets into them.",
    "  DRAFTS  — per-file extractions from one or more uploaded resumes. These were produced by a cheaper model and may misclassify entries.",
    "",
    "Hard rules — never violate:",
    "1. NEVER invent facts. You cannot add bullets, titles, dates, companies, projects, education, or links that are not present in the inputs.",
    "2. Preserve the candidate's specific accomplishments and metrics verbatim. When two drafts describe the same accomplishment with different wording, pick the wording from ONE draft as-is — do not paraphrase or merge wording.",
    "3. Dates: ISO 8601. When drafts disagree on a date for the same entity, prefer the widest span (earliest start, latest end / 'Present' = null endDate).",
    "",
    "What to curate:",
    "4. CROSS-DRAFT DEDUP. If the same entity appears across drafts (same employer + similar role, or same project / student org / school), emit it once. Merge its bullets (drop near-duplicates — exact text, trivial whitespace/case variants, or the same accomplishment in clearly different wording).",
    "5. CROSS-CATEGORY RESOLUTION (this is the most common per-file mistake). If one draft lists an entity as a work role and another lists it as a project, decide using the entity itself:",
    "   • PROJECT wins when the entity is:",
    "       - a named student / collegiate engineering team (Space Enterprise at Berkeley / SEB, FSAE, Robotics Team, Solar Car, hackathon team, IEEE/ACM chapter)",
    "       - a named app / platform / library / open-source repo the candidate built (e.g. 'Iris (Earth Observation Platform)', 'mysubs.live', 'Argot', 'Gitlet')",
    "       - a self-started venture where the candidate is Creator / Founder / Lead Developer / Maintainer with no parent employer",
    "       - bullets mention crowdfunding, hackathon wins, 'personal project', 'open-sourced', unpaid extracurricular language",
    "   • WORK ROLE wins for paid employment, formal internships / co-ops / fellowships, freelance / contract engagements at a named client, and service-industry jobs.",
    "   • For project entities, use the entity name as `name` (e.g. 'Iris', not 'Creator & Lead Developer | Iris'). The candidate's role within the project can become the first bullet or go in `description`.",
    "6. EXISTING entities. If a draft entity matches one already on EXISTING, emit the SAME normalized identity (same company+title for roles, same name for projects, same institution+degree+field for education) and include any new bullets the draft contributes that aren't already on the existing entity. Do not re-emit existing bullets verbatim — those will be deduped downstream.",
    "7. ORDERING. Emit work roles reverse-chronologically (most recent first, ongoing entries at the top). Emit education the same way. Projects: most-recent / ongoing first if you can tell, else any stable order.",
    "8. HEADER. Use the EXISTING header values when present (never overwrite). For empty header fields, pull from the drafts only if the value is present verbatim there. Merge `links` as a union (dedup by URL).",
    "9. SKIP NOISE. Course assignments without a project name, generic skills lines that aren't bullets, section headers, page numbers — leave them out.",
    "",
    "Output strictly the JSON shape requested — no commentary, no markdown fences.",
].join("\n");

// Cap on the serialized input we send the synthesizer. Each draft is already
// structured JSON (compact), so 80k chars covers ~8 maximal resumes plus the
// existing profile. Larger imports get truncated tail-first.
const MAX_SYNTHESIS_INPUT_CHARS = 80_000;

function summarizeExisting(existing: ExistingProfileForMerge): string {
    // We only need identity + bullet text — the merge step has the real rows.
    // Dates are summarized to a year-range so the model can match without
    // anchoring on exact timestamps.
    const yr = (d: Date | null) => d ? d.toISOString().slice(0, 7) : null;
    return JSON.stringify({
        header: {
            headline: existing.headline,
            summary: existing.summary,
            location: existing.location,
            email: existing.email,
            phone: existing.phone,
            links: existing.links ?? [],
        },
        workRoles: existing.workRoles.map(w => ({
            company: w.company,
            title: w.title,
            location: w.location,
            startDate: yr(w.startDate),
            endDate: yr(w.endDate),
            bullets: w.bullets.map(b => b.text),
        })),
        projects: existing.projects.map(p => ({
            name: p.name,
            description: p.description,
            repoUrl: p.repoUrl,
            liveUrl: p.liveUrl,
            bullets: p.bullets.map(b => b.text),
        })),
        education: existing.education.map(e => ({
            institution: e.institution,
            degree: e.degree,
            field: e.field,
            startDate: yr(e.startDate),
            endDate: yr(e.endDate),
            bullets: e.bullets.map(b => b.text),
        })),
    }, null, 2);
}

function summarizeDrafts(drafts: { filename: string; tree: ExtractedProfile }[]): string {
    return JSON.stringify(
        drafts.map(d => ({ filename: d.filename, tree: d.tree })),
        null,
        2,
    );
}

function truncateIfTooLong(s: string): string {
    if (s.length <= MAX_SYNTHESIS_INPUT_CHARS) return s;
    return s.slice(0, MAX_SYNTHESIS_INPUT_CHARS) + "\n\n[…truncated — original input was longer]";
}

export async function synthesizeMasterResume(
    existing: ExistingProfileForMerge,
    drafts: { filename: string; tree: ExtractedProfile }[],
): Promise<ExtractedProfile> {
    const existingJson = summarizeExisting(existing);
    const draftsJson = summarizeDrafts(drafts);
    const body = [
        "EXISTING profile (do not duplicate; merge into these where applicable):",
        "```json",
        existingJson,
        "```",
        "",
        `DRAFTS — ${drafts.length} per-file extraction(s):`,
        "```json",
        draftsJson,
        "```",
        "",
        "Return JSON with this exact shape:",
        "{",
        "  \"header\": { \"headline\": string|null, \"summary\": string|null, \"location\": string|null, \"email\": string|null, \"phone\": string|null, \"links\": Array<{label,url}>|null },",
        "  \"workRoles\": Array<{ \"company\": string, \"title\": string, \"location\": string|null, \"startDate\": string|null, \"endDate\": string|null, \"bullets\": string[] }>,",
        "  \"projects\": Array<{ \"name\": string, \"description\": string|null, \"repoUrl\": string|null, \"liveUrl\": string|null, \"bullets\": string[] }>,",
        "  \"education\": Array<{ \"institution\": string, \"degree\": string|null, \"field\": string|null, \"startDate\": string|null, \"endDate\": string|null, \"bullets\": string[] }>",
        "}",
    ].join("\n");

    return chatJSON({
        system: SYSTEM_PROMPT,
        user: truncateIfTooLong(body),
        schema: SynthesizedSchema,
        model: MODEL_FLASH,
        // Slightly above 0 so the model can pick between competing wordings
        // without going off-script. Still deterministic enough that the same
        // input usually yields the same master.
        temperature: 0.15,
        // Nested bullet arrays across many roles + projects + education can
        // legitimately need a wide window — same rationale as the extractor.
        maxOutputTokens: 32_768,
    });
}
