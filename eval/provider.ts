/**
 * Promptfoo custom provider — dispatches per-callsite to the real `chatJSON`-
 * wrapped functions in `lib/`. See `docs/implementation.md` §LLM observability
 * (LOP-8) for the design.
 *
 * Each fixture under `eval/fixtures/<callsite>/` is a JSON file shaped like:
 *   { "input": <whatever the callsite function expects> }
 *
 * Promptfoo passes the fixture's `vars` object as `context.vars`; this
 * provider reads `context.vars.callsite` (the slug, matches the `name:` field
 * in `chatJSON`) and `context.vars.input` (the function args) and dispatches.
 *
 * **Real Gemini tokens get burned on every call** — run via `npm run test:prompts`,
 * not in pre-push. Default count: 9 callsites × 2-3 fixtures × 1-2 assertions
 * ≈ 30 Gemini calls per full run, ~$0.01-0.05 on MODEL_LITE.
 */

import { parsePosting } from "@/lib/resumes/posting";
import { rewriteBullets } from "@/lib/resumes/rewrite";
import { extractProfileFromText } from "@/lib/profile/import-llm";
import { synthesizeMasterResume } from "@/lib/profile/synthesize";
import { suggestCompanies } from "@/lib/discovery/suggest";
import { classifyEmploymentTypes } from "@/lib/ai/classify-employment-type";
import { parseApplicationEmail } from "@/lib/email-parser";
import {
    buildBulletAssistPrompt,
    callBulletAssist,
} from "@/lib/profile/bullet-assist";
import {
    renderBulletsBlock,
    renderKeywordsBlock,
    type FlatBullet,
} from "@/lib/profile/auto-tag";
import {
    applyTagSuggestPostFilter,
    renderTagState,
    renderRemovedTags,
    renderVocabulary,
} from "@/lib/profile/bullet-tag-suggest";
import { chatJSON, MODEL_LITE } from "@/lib/ai/gemini";
import { loadPrompt } from "@/lib/ai/prompts";
import { z } from "zod";

// Promptfoo provider response shape — see https://www.promptfoo.dev/docs/providers/custom-api/
interface ProviderResponse {
    output?: unknown;
    error?: string;
    tokenUsage?: { total?: number; prompt?: number; completion?: number };
    metadata?: Record<string, unknown>;
}

interface CallContext {
    vars: Record<string, unknown> & { callsite?: string; input?: unknown };
}

type CallsiteHandler = (input: unknown) => Promise<unknown>;

const HANDLERS: Record<string, CallsiteHandler> = {
    "posting-parse": async (input) => {
        return await parsePosting(input as Parameters<typeof parsePosting>[0]);
    },

    "resume-rewrite": async (input) => {
        const args = input as { selections: Parameters<typeof rewriteBullets>[0]; posting: Parameters<typeof rewriteBullets>[1]; readmeCtx?: Parameters<typeof rewriteBullets>[2] };
        return await rewriteBullets(args.selections, args.posting, args.readmeCtx);
    },

    "profile-import": async (input) => {
        const args = input as { text: string; filename: string };
        return await extractProfileFromText(args.text, args.filename);
    },

    "profile-synthesize": async (input) => {
        // YAML fixtures send dates as ISO strings (YAML has no native Date type)
        // and bullets as `{text}` partials — marshal them into the full lib
        // shapes here so the test surface stays human-friendly. summarizeExisting
        // touches `startDate.toISOString()` and `bullet.text` only; ids are
        // required by the TS interface but unused at runtime, so a sentinel is
        // fine.
        const args = input as { existing: Record<string, unknown>; drafts: Parameters<typeof synthesizeMasterResume>[1] };
        const toDate = (v: unknown): Date | null => {
            if (v === null || v === undefined) return null;
            if (v instanceof Date) return v;
            if (typeof v === "string") return new Date(v);
            return null;
        };
        const padBullet = (b: unknown, idx: number) => {
            const o = (typeof b === "object" && b !== null ? b : { text: String(b) }) as Record<string, unknown>;
            return {
                id: typeof o.id === "string" ? o.id : `blt-fixture-${idx}`,
                text: typeof o.text === "string" ? o.text : "",
                tags: Array.isArray(o.tags) ? o.tags as string[] : [],
                autoTags: Array.isArray(o.autoTags) ? o.autoTags as string[] : [],
                removedTags: Array.isArray(o.removedTags) ? o.removedTags as string[] : [],
                pinnedTags: Array.isArray(o.pinnedTags) ? o.pinnedTags as string[] : [],
                locked: o.locked === true,
                excluded: o.excluded === true,
            };
        };
        const ex = args.existing;
        const existing: Parameters<typeof synthesizeMasterResume>[0] = {
            headline: (ex.headline ?? null) as string | null,
            summary: (ex.summary ?? null) as string | null,
            location: (ex.location ?? null) as string | null,
            email: (ex.email ?? null) as string | null,
            phone: (ex.phone ?? null) as string | null,
            links: (ex.links ?? null) as { label: string; url: string }[] | null,
            workRoles: ((ex.workRoles ?? []) as Record<string, unknown>[]).map((w, i) => ({
                id: (w.id as string) ?? `wr-fixture-${i}`,
                company: w.company as string,
                title: w.title as string,
                location: (w.location ?? null) as string | null,
                startDate: toDate(w.startDate),
                endDate: toDate(w.endDate),
                bullets: ((w.bullets ?? []) as unknown[]).map(padBullet),
            })),
            projects: ((ex.projects ?? []) as Record<string, unknown>[]).map((p, i) => ({
                id: (p.id as string) ?? `pr-fixture-${i}`,
                name: p.name as string,
                description: (p.description ?? null) as string | null,
                repoUrl: (p.repoUrl ?? null) as string | null,
                liveUrl: (p.liveUrl ?? null) as string | null,
                bullets: ((p.bullets ?? []) as unknown[]).map(padBullet),
            })),
            education: ((ex.education ?? []) as Record<string, unknown>[]).map((e, i) => ({
                id: (e.id as string) ?? `ed-fixture-${i}`,
                institution: e.institution as string,
                degree: (e.degree ?? null) as string | null,
                field: (e.field ?? null) as string | null,
                startDate: toDate(e.startDate),
                endDate: toDate(e.endDate),
                bullets: ((e.bullets ?? []) as unknown[]).map(padBullet),
            })),
        };
        return await synthesizeMasterResume(existing, args.drafts);
    },

    "discovery-suggest": async (input) => {
        return await suggestCompanies(input as Parameters<typeof suggestCompanies>[0]);
    },

    "employment-type-classifier": async (input) => {
        const args = input as { items: Parameters<typeof classifyEmploymentTypes>[0] };
        const result = await classifyEmploymentTypes(args.items);
        // Map → plain object for JSON serialization
        return Object.fromEntries(result);
    },

    "email-parser": async (input) => {
        const args = input as { emailContent: string; subject: string; from?: string; sentAt?: string };
        const sentAt = args.sentAt ? new Date(args.sentAt) : undefined;
        return await parseApplicationEmail(args.emailContent, args.subject, args.from, sentAt);
    },

    "bullet-assist-fill": async (input) => {
        const builderInput = input as Parameters<typeof buildBulletAssistPrompt>[0];
        const prompt = await buildBulletAssistPrompt({ ...builderInput, mode: "fill" });
        return await callBulletAssist({
            mode: "fill",
            prompt,
            parentKind: builderInput.parent.kind,
            parentId: builderInput.parent.id,
        });
    },

    "bullet-assist-rewrite": async (input) => {
        const builderInput = input as Parameters<typeof buildBulletAssistPrompt>[0];
        const prompt = await buildBulletAssistPrompt({ ...builderInput, mode: "rewrite" });
        const currentBullet = builderInput.currentBullet;
        if (!currentBullet) {
            throw new Error("bullet-assist-rewrite fixture must include currentBullet");
        }
        return await callBulletAssist({
            mode: "rewrite",
            prompt,
            currentBullet: {
                id: "blt_eval_fixture",
                text: currentBullet.text,
                tags: currentBullet.tags,
                autoTags: [],
                removedTags: [],
                pinnedTags: [],
                locked: false,
                excluded: false,
            },
            parentKind: builderInput.parent.kind,
            parentId: builderInput.parent.id,
        });
    },

    // M8.5.2 — eval-only dispatcher. Mirrors `autoTagBullets` minus the Prisma
    // load/persist (fixtures hand-feed the bullet list directly so the suite
    // stays profile-agnostic). Bypasses `mergeAutoTagProposals` too — the
    // assertion in the YAML grades the RAW model output, which is what
    // we actually want a Promptfoo run to defend.
    "bullet-auto-tag": async (input) => {
        const args = input as {
            keywords: string[];
            bullets: Array<{ id: string; text: string; tags?: string[]; removedTags?: string[] }>;
        };
        const flat: FlatBullet[] = args.bullets.map(b => ({
            parentKind: "work-role" as const,
            parentId: "wr_eval_fixture",
            bullet: {
                id: b.id,
                text: b.text,
                tags: b.tags ?? [],
                autoTags: [],
                removedTags: b.removedTags ?? [],
                pinnedTags: [],
                locked: false,
                excluded: false,
            },
        }));

        const prompt = await loadPrompt("bullet-auto-tag", {
            keywords: renderKeywordsBlock(args.keywords),
            bullets: renderBulletsBlock(flat),
        });

        const schema = z.object({
            proposals: z.array(z.object({
                bulletId: z.string().min(1),
                addedTags: z.array(z.string()),
            })),
        });

        return await chatJSON({
            name: "bullet-auto-tag",
            system: prompt.system,
            user: prompt.user,
            schema,
            model: MODEL_LITE,
            temperature: 0.1,
            maxOutputTokens: 2048,
        });
        // mergeAutoTagProposals is intentionally NOT applied here — the
        // fixture assertions grade what the model actually returned. The
        // merge function is exercised by the hermetic
        // `auto-tag-merge-smoke.ts` instead, which can hold the model
        // constant via canned proposals.
    },

    // M7.7.3 — per-bullet AI tag generator (story S7.10 + S7.11).
    // Bypasses the live DB load in `suggestTagsForBullet`; the fixture supplies
    // pre-categorized tag state + vocabulary directly so the suite is
    // profile-agnostic. POST-FILTER IS APPLIED so the contract invariants
    // (pin preservation, blocklist filter, 7-cap) get exercised end-to-end.
    "bullet-tag-suggest": async (input) => {
        const args = input as {
            spine: string;
            bulletText: string;
            pinnedTags?: string[];
            autoTags?: string[];
            userTags?: string[];
            removedTags?: string[];
            vocabulary?: string[];
        };
        const pinnedTags = args.pinnedTags ?? [];
        const autoTags = args.autoTags ?? [];
        const userTags = args.userTags ?? [];
        const removedTags = args.removedTags ?? [];
        const vocabulary = args.vocabulary ?? [];

        // Re-use the pure render helpers from the lib so the prompt block
        // format stays in lockstep with production.
        const fakeBullet = {
            id: "blt_eval_fixture",
            text: args.bulletText,
            tags: [...pinnedTags, ...autoTags, ...userTags],
            autoTags,
            removedTags,
            pinnedTags,
            locked: false,
            excluded: false,
        };

        const prompt = await loadPrompt("bullet-tag-suggest", {
            spine: args.spine,
            bulletText: args.bulletText,
            tagState: renderTagState(fakeBullet),
            removedTags: renderRemovedTags(fakeBullet),
            vocabulary: renderVocabulary(vocabulary),
        });

        const schema = z.object({
            tags: z.array(z.string().min(1).max(60)).max(20),
            reason: z.string().max(500).optional(),
        });

        const response = await chatJSON({
            name: "bullet-tag-suggest",
            system: prompt.system,
            user: prompt.user,
            schema,
            model: MODEL_LITE,
            temperature: 0.3,
            maxOutputTokens: 1024,
        });

        const tags = applyTagSuggestPostFilter(response.tags, pinnedTags, removedTags);
        return { tags, reason: response.reason };
    },
};

class MissionControlProvider {
    id(): string {
        return "mc-chatjson";
    }

    async callApi(_prompt: string, context: CallContext): Promise<ProviderResponse> {
        const callsite = context.vars?.callsite;
        const input = context.vars?.input;

        if (typeof callsite !== "string") {
            return { error: "fixture missing `callsite` var" };
        }
        const handler = HANDLERS[callsite];
        if (!handler) {
            return { error: `unknown callsite "${callsite}" — add to HANDLERS in eval/provider.ts` };
        }

        try {
            const result = await handler(input);
            return { output: JSON.stringify(result) };
        } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
        }
    }
}

export default MissionControlProvider;
