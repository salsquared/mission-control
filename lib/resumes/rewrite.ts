import { z } from "zod";
import { chatJSON, AIError, MODEL_FLASH } from "@/lib/ai/gemini";
import { loadPrompt, loadPromptFromDisk, type PromptVars } from "@/lib/ai/prompts";
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

// Story S9.5 — README excerpts per project sourceId. Caller-built; the rewriter
// only renders what's handed in. ~2 KB cap per project so the combined prompt
// stays in budget even with 4-5 portfolio projects in one resume.
export interface ProjectReadmeContext {
    readmesBySourceId: Record<string, string>;
}

export const PROJECT_README_PROMPT_LIMIT = 2_048;

// Pre-template-cutover, this exported function returned the fully-assembled
// user prompt. Post-LOP-6 it computes the {{var}} substitutions and renders
// them through the disk snapshot — so existing hermetic smokes that call
// `buildRewriteUserPrompt` keep observing realistic prompt strings without
// hitting Lunary or Gemini.
export function buildRewriteVars(
    selections: BulletSelection[],
    posting: ParsedPosting,
    readmeCtx?: ProjectReadmeContext,
): PromptVars {
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

    const readmesBlock = readmeSection.length > 0
        ? [
            "Project READMEs (use as factual reference for project-source bullets — do NOT invent new claims, only emphasize what the README confirms is true):",
            readmeSection.join("\n\n"),
        ].join("\n")
        : "";

    return {
        postingTitle: posting.title ?? "(unknown)",
        postingCompany: posting.company ?? "(unknown)",
        postingSeniority: posting.seniority ?? "(unknown)",
        postingKeywordsBlock: posting.keywords.map(k => `  - ${k}`).join("\n"),
        readmesBlock,
        bulletsJson: JSON.stringify(inputBullets, null, 2),
    };
}

// Back-compat for `scripts/tests/hermetic/readme-prompt-smoke.ts` — returns
// the rendered user prompt by routing the vars through the disk snapshot
// (NOT Lunary — keeps the smoke deterministic + offline).
export function buildRewriteUserPrompt(
    selections: BulletSelection[],
    posting: ParsedPosting,
    readmeCtx?: ProjectReadmeContext,
): string {
    return loadPromptFromDisk("resume-rewrite", buildRewriteVars(selections, posting, readmeCtx)).user;
}

export async function rewriteBullets(
    selections: BulletSelection[],
    posting: ParsedPosting,
    readmeCtx?: ProjectReadmeContext,
): Promise<RewrittenBullet[]> {
    if (selections.length === 0) return [];

    const prompt = await loadPrompt("resume-rewrite", buildRewriteVars(selections, posting, readmeCtx));

    const response = await chatJSON({
        name: "resume-rewrite",
        system: prompt.system,
        user: prompt.user,
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
