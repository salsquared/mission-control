import { z } from "zod";
import { chatJSON } from "@/lib/ai/gemini";
import { loadPrompt } from "@/lib/ai/prompts";

// Story S7.14 follow-up (2026-05-26): `summary` dropped from Profile —
// importer no longer asks the LLM to extract one.
const HeaderSchema = z.object({
    headline: z.string().nullable(),
    location: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    links: z.array(z.object({ label: z.string(), url: z.string() })).nullable(),
});

const WorkRoleExtractSchema = z.object({
    company: z.string(),
    title: z.string(),
    location: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    bullets: z.array(z.string()),
});

const ProjectExtractSchema = z.object({
    name: z.string(),
    description: z.string().nullable(),
    repoUrl: z.string().nullable(),
    liveUrl: z.string().nullable(),
    bullets: z.array(z.string()),
});

const EducationExtractSchema = z.object({
    institution: z.string(),
    degree: z.string().nullable(),
    field: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    bullets: z.array(z.string()),
});

const ExtractedProfileSchema = z.object({
    header: HeaderSchema,
    workRoles: z.array(WorkRoleExtractSchema),
    projects: z.array(ProjectExtractSchema),
    education: z.array(EducationExtractSchema),
});

export type ExtractedProfile = z.infer<typeof ExtractedProfileSchema>;
export type ExtractedWorkRole = z.infer<typeof WorkRoleExtractSchema>;
export type ExtractedProject = z.infer<typeof ProjectExtractSchema>;
export type ExtractedEducation = z.infer<typeof EducationExtractSchema>;

// Largest chunk of resume text we'll send to Gemini in one call. Real resumes
// max out around 10-20k chars; OCR'd PDFs occasionally balloon to 100k+ with
// boilerplate. Cap protects free-tier token budget and avoids 400s on the
// 8MB-PDF case the original extractor accepts.
const MAX_IMPORT_TEXT_CHARS = 60_000;

export async function extractProfileFromText(text: string, filename: string): Promise<ExtractedProfile> {
    const resumeText = text.length > MAX_IMPORT_TEXT_CHARS
        ? text.slice(0, MAX_IMPORT_TEXT_CHARS) + "\n\n[…truncated — original was longer]"
        : text;
    const prompt = await loadPrompt("profile-import", { filename, resumeText });
    return chatJSON({
        name: "profile-import",
        system: prompt.system,
        user: prompt.user,
        schema: ExtractedProfileSchema,
        temperature: 0.1,
        // Inherits MODEL_LITE default — resume parsing is structured
        // extraction with no judgment calls; flash-lite is sufficient.
        // 32k output budget retained because nested bullet arrays across
        // many roles + projects + education can legitimately need it.
        // See docs/llm-calls.html.
        maxOutputTokens: 32_768,
    });
}
