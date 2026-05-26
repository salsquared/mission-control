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

export function buildRewriteVars(
    selections: BulletSelection[],
    posting: ParsedPosting,
): PromptVars {
    const inputBullets = selections.map(s => ({
        id: s.bulletId,
        originalText: s.originalText,
        matchedTags: s.matchedTags,
        matchedKeywords: s.matchedKeywords,
        sourceLabel: s.sourceLabel,
        locked: s.locked,
    }));

    return {
        postingTitle: posting.title ?? "(unknown)",
        postingCompany: posting.company ?? "(unknown)",
        postingSeniority: posting.seniority ?? "(unknown)",
        postingKeywordsBlock: posting.keywords.map(k => `  - ${k}`).join("\n"),
        bulletsJson: JSON.stringify(inputBullets, null, 2),
    };
}

export function buildRewriteUserPrompt(
    selections: BulletSelection[],
    posting: ParsedPosting,
): string {
    return loadPromptFromDisk("resume-rewrite", buildRewriteVars(selections, posting)).user;
}

export async function rewriteBullets(
    selections: BulletSelection[],
    posting: ParsedPosting,
): Promise<RewrittenBullet[]> {
    if (selections.length === 0) return [];

    // Bullets with no matchedTags AND no matchedKeywords have no posting-
    // keyword lever for the LLM to fold in or swap (rules 6 / 6a are no-ops),
    // so a rewrite would be pure stylistic polish at best and risks a low-
    // value cross-domain edit at worst. Pass them through verbatim and skip
    // the tokens. Still emitted in the final output (in original selection
    // order) so the renderer + trace UI see every selected bullet.
    const forLLM = selections.filter(s => s.matchedTags.length > 0 || s.matchedKeywords.length > 0);

    if (forLLM.length === 0) {
        return selections.map(s => ({
            id: s.bulletId,
            rewrittenText: s.originalText,
            matchedKeywords: [],
        }));
    }

    const prompt = await loadPrompt("resume-rewrite", buildRewriteVars(forLLM, posting));

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

    const llmInputIds = new Set(forLLM.map(s => s.bulletId));
    const seen = new Set<string>();
    for (const b of response.bullets) {
        if (!llmInputIds.has(b.id)) {
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
        // Passthrough by design (no posting-keyword match) — not an LLM
        // omission; no warning.
        if (s.matchedTags.length === 0 && s.matchedKeywords.length === 0) {
            return {
                id: s.bulletId,
                rewrittenText: s.originalText,
                matchedKeywords: [],
            };
        }
        console.warn(`[resume/rewrite] Gemini omitted bullet ${s.bulletId}; falling back to original text.`);
        return {
            id: s.bulletId,
            rewrittenText: s.originalText,
            matchedKeywords: s.matchedKeywords,
        };
    });
}
