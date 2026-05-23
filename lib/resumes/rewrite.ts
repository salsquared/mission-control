import { z } from "zod";
import { chatJSON, AIError, MODEL_FLASH } from "@/lib/ai/gemini";
import type { BulletSelection } from "@/lib/resumes/select";
import type { ParsedPosting } from "@/lib/resumes/posting";

export interface RewrittenBullet {
    id: string;
    rewrittenText: string;
    matchedKeywords: string[];
}

const RewrittenBulletSchema = z.object({
    id: z.string(),
    rewrittenText: z.string().min(1),
    matchedKeywords: z.array(z.string()),
});

const RewriteResponseSchema = z.object({
    bullets: z.array(RewrittenBulletSchema),
});

const SYSTEM_PROMPT = [
    "You are a resume editor. You rewrite resume bullets so they emphasize what a specific job posting cares about.",
    "",
    "Hard rules — never violate:",
    "1. NEVER invent metrics, numbers, percentages, durations, or specific outcomes that aren't already in the original bullet.",
    "2. NEVER claim experience with technologies, methodologies, or domains that aren't already in the original bullet.",
    "3. Preserve the bullet `id` exactly. Returning a bullet with an id that wasn't in the input is a critical failure.",
    "4. Each rewritten bullet stays ~1 line and ≤ 25 words.",
    "5. Lead with a strong action verb (Built, Shipped, Designed, Led, Reduced, Authored, etc.).",
    "6. When the posting uses different terminology for a concept already in the bullet (e.g. 'distributed systems' vs 'microservices'), prefer the posting's wording.",
    "7. If rewriting would require breaking rules 1–2, return the original text unchanged.",
    "",
    "Return strictly JSON of shape {\"bullets\": [{\"id\", \"rewrittenText\", \"matchedKeywords\"}]} — one entry per input bullet, in the same order. `matchedKeywords` lists which of the posting's keywords the rewrite emphasizes.",
].join("\n");

// Story 46 — README excerpts per project sourceId. Caller-built; the rewriter
// only renders what's handed in. ~2 KB cap per project so the combined prompt
// stays in budget even with 4-5 portfolio projects in one resume.
export interface ProjectReadmeContext {
    readmesBySourceId: Record<string, string>;
}

export const PROJECT_README_PROMPT_LIMIT = 2_048;

// Pure prompt builder, exported so it can be unit-tested without hitting
// Gemini. Mirrors the body that rewriteBullets ships in production — change
// it here and the LLM sees the new shape immediately.
export function buildRewriteUserPrompt(
    selections: BulletSelection[],
    posting: ParsedPosting,
    readmeCtx?: ProjectReadmeContext,
): string {
    const inputBullets = selections.map(s => ({
        id: s.bulletId,
        originalText: s.originalText,
        matchedTags: s.matchedTags,
        matchedKeywords: s.matchedKeywords,
        sourceLabel: s.sourceLabel,
        locked: s.locked,
    }));

    // Group READMEs by sourceId so the prompt doesn't repeat them per bullet
    // when one project has multiple bullets selected.
    const readmeSection: string[] = [];
    if (readmeCtx?.readmesBySourceId) {
        const projectSourceIds = new Set(
            selections.filter(s => s.kind === "project").map(s => s.sourceId),
        );
        for (const sourceId of projectSourceIds) {
            const readme = readmeCtx.readmesBySourceId[sourceId];
            if (!readme) continue;
            const label = selections.find(s => s.sourceId === sourceId)?.sourceLabel ?? sourceId;
            const trimmed = readme.length > PROJECT_README_PROMPT_LIMIT
                ? readme.slice(0, PROJECT_README_PROMPT_LIMIT) + "\n…(truncated)"
                : readme;
            readmeSection.push(`### Project README — ${label}\n${trimmed}`);
        }
    }

    return [
        `Posting title: ${posting.title ?? "(unknown)"}`,
        `Company: ${posting.company ?? "(unknown)"}`,
        `Seniority: ${posting.seniority ?? "(unknown)"}`,
        "",
        "Posting keywords (what the posting emphasizes):",
        posting.keywords.map(k => `  - ${k}`).join("\n"),
        ...(readmeSection.length > 0
            ? [
                "",
                "Project READMEs (use as factual reference for project-source bullets — do NOT invent new claims, only emphasize what the README confirms is true):",
                readmeSection.join("\n\n"),
            ]
            : []),
        "",
        "Bullets to rewrite (preserve every `id` exactly):",
        JSON.stringify(inputBullets, null, 2),
    ].join("\n");
}

export async function rewriteBullets(
    selections: BulletSelection[],
    posting: ParsedPosting,
    readmeCtx?: ProjectReadmeContext,
): Promise<RewrittenBullet[]> {
    if (selections.length === 0) return [];

    const userPrompt = buildRewriteUserPrompt(selections, posting, readmeCtx);

    const response = await chatJSON({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        schema: RewriteResponseSchema,
        temperature: 0.4,
        // Quality-sensitive — this output directly shapes what the user
        // sends to employers. Full Flash, NOT the lite default. See
        // docs/llm-calls.md for the rationale.
        model: MODEL_FLASH,
        // ≤25 bullets × ~50 tokens of rewrittenText + matchedKeywords each
        // ≈ 1.5k. 4k caps a runaway response without clipping legit output.
        maxOutputTokens: 4096,
    });

    const inputIds = new Set(selections.map(s => s.bulletId));
    const seen = new Set<string>();
    for (const b of response.bullets) {
        if (!inputIds.has(b.id)) {
            throw new AIError(
                `Rewrite returned an unknown bullet id ${b.id}; refusing output to avoid mis-targeting.`,
                undefined,
                "validate",
            );
        }
        if (seen.has(b.id)) {
            throw new AIError(`Rewrite returned duplicate bullet id ${b.id}.`, undefined, "validate");
        }
        seen.add(b.id);
    }

    // Fill in any missing ids by falling back to the original text — safer than dropping a bullet.
    const byId = new Map(response.bullets.map(b => [b.id, b]));
    return selections.map(s => {
        const r = byId.get(s.bulletId);
        if (r) return r;
        console.warn(`[resume/rewrite] Gemini omitted bullet ${s.bulletId}; falling back to original text.`);
        return {
            id: s.bulletId,
            rewrittenText: s.originalText,
            matchedKeywords: s.matchedKeywords,
        };
    });
}
