import { z } from "zod";
import { chatJSON } from "@/lib/ai/gemini";

const HeaderSchema = z.object({
    headline: z.string().nullable(),
    summary: z.string().nullable(),
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

const SYSTEM_PROMPT = [
    "You extract structured profile data from resume text.",
    "",
    "Rules:",
    "1. NEVER invent information. If a field isn't clearly stated in the source, return null (or an empty array for bullets).",
    "2. Preserve original bullet wording. Do not summarize, expand, or rephrase.",
    "3. Dates: return ISO 8601 strings (e.g. '2024-01-15T00:00:00.000Z'). When only a month + year are given (e.g. 'May 2024'), use the first of that month. When only a year is given, use Jan 1 of that year. If the date is 'Present' / 'Current' / ongoing, return null for endDate.",
    "4. Work-role vs project classification — do NOT rely on the section header (resumes vary). Decide per entry, using the entity itself:",
    "   • PROJECT (not a work role) when the entity is a NAMED THING built by the candidate, or a student/collegiate/extracurricular activity:",
    "       - student engineering teams (Space Enterprise at Berkeley / SEB, FSAE, Robotics Team, Solar Car, IEEE chapter, ACM chapter, etc.) — even when listed under 'Experience'",
    "       - open-source repos, side projects, personal projects, capstones, hackathon submissions",
    "       - apps / platforms / libraries with a product-style name (e.g. 'Iris (Earth Observation Platform)', 'mysubs.live', 'Argot') — the entity IS the project, even if formatted as 'Title | Org' with dates",
    "       - self-started ventures where the candidate's title is 'Creator', 'Founder', 'Co-Founder', 'Lead Developer', 'Architect', 'Maintainer' and there is no parent employer paying them",
    "       - signals in bullets: 'led crowdfunding', 'won/placed at hackathon', '4th place at … Hackathon', 'open-sourced', 'personal project', 'side project'",
    "   • WORK ROLE when the entity is an EMPLOYER paying the candidate, or a formal program:",
    "       - paid employment at a company / startup / agency",
    "       - formal internships, co-ops, fellowships, residencies",
    "       - freelance / contract engagements with named clients (DomeIQ, Freckle.tv, etc.)",
    "       - service / hospitality / retail jobs",
    "   • When ambiguous, prefer PROJECT for student-org or self-started named entities; prefer WORK ROLE for anything that reads like compensated employment.",
    "   • Course assignments without a name are NOT projects (and not work roles either) — skip them.",
    "5. For projects, use the project's NAME as the `name` field (e.g. 'Iris', 'Space Enterprise at Berkeley') — not the candidate's role title. Put the role/title-like phrase ('Creator & Lead Developer', 'Avionics Engineer') in the first bullet if it adds context, or in `description` if there's no bullet for it.",
    "6. Education entries are degree programs. Bootcamps, certificate programs, and academic awards each count as separate education entries.",
    "7. Links: extract every distinct URL with a sensible label (e.g. {label: 'GitHub', url: 'https://github.com/foo'}). If the resume uses bare URLs, label them by host or section.",
    "8. Output strictly the JSON shape requested — no commentary, no markdown fences.",
].join("\n");

// Largest chunk of resume text we'll send to Gemini in one call. Real resumes
// max out around 10-20k chars; OCR'd PDFs occasionally balloon to 100k+ with
// boilerplate. Cap protects free-tier token budget and avoids 400s on the
// 8MB-PDF case the original extractor accepts.
const MAX_IMPORT_TEXT_CHARS = 60_000;

function buildUserPrompt(text: string, filename: string): string {
    const truncated = text.length > MAX_IMPORT_TEXT_CHARS
        ? text.slice(0, MAX_IMPORT_TEXT_CHARS) + "\n\n[…truncated — original was longer]"
        : text;
    return [
        `Filename: ${filename}`,
        "",
        "Resume text (extracted from the source file — may have minor OCR-ish artifacts):",
        "---",
        truncated,
        "---",
        "",
        "Return JSON with this exact shape:",
        "{",
        "  \"header\": { \"headline\": string|null, \"summary\": string|null, \"location\": string|null, \"email\": string|null, \"phone\": string|null, \"links\": Array<{label,url}>|null },",
        "  \"workRoles\": Array<{ \"company\": string, \"title\": string, \"location\": string|null, \"startDate\": string|null, \"endDate\": string|null, \"bullets\": string[] }>,",
        "  \"projects\": Array<{ \"name\": string, \"description\": string|null, \"repoUrl\": string|null, \"liveUrl\": string|null, \"bullets\": string[] }>,",
        "  \"education\": Array<{ \"institution\": string, \"degree\": string|null, \"field\": string|null, \"startDate\": string|null, \"endDate\": string|null, \"bullets\": string[] }>",
        "}",
    ].join("\n");
}

export async function extractProfileFromText(text: string, filename: string): Promise<ExtractedProfile> {
    return chatJSON({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(text, filename),
        schema: ExtractedProfileSchema,
        temperature: 0.1,
        // Inherits MODEL_LITE default — resume parsing is structured
        // extraction with no judgment calls; flash-lite is sufficient.
        // 32k output budget retained because nested bullet arrays across
        // many roles + projects + education can legitimately need it.
        // See docs/llm-calls.md.
        maxOutputTokens: 32_768,
    });
}
