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
import { loadPrompt } from "@/lib/ai/prompts";
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

export async function synthesizeMasterResume(
    existing: ExistingProfileForMerge,
    drafts: { filename: string; tree: ExtractedProfile }[],
): Promise<ExtractedProfile> {
    const existingJson = summarizeExisting(existing);
    let draftsJson = summarizeDrafts(drafts);

    // Defensive: the only var that can blow MAX_SYNTHESIS_INPUT_CHARS at
    // scale is draftsJson (existingJson is the user's current profile,
    // bounded by what they've already curated). Truncate it first if the
    // combined inputs would exceed the cap. The template's static prose +
    // existingJson + draftCount overhead is ~ a few KB; reserve 4 KB.
    const budget = MAX_SYNTHESIS_INPUT_CHARS - existingJson.length - 4_096;
    if (draftsJson.length > budget && budget > 0) {
        draftsJson = draftsJson.slice(0, budget) + "\n\n[…truncated — original input was longer]";
    }

    const prompt = await loadPrompt("profile-synthesize", {
        existingJson,
        draftCount: String(drafts.length),
        draftsJson,
    });

    return chatJSON({
        name: "profile-synthesize",
        system: prompt.system,
        user: prompt.user,
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
