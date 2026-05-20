/**
 * Topical company discovery — given a topic ("space", "climate tech",
 * "defense"), ask Gemini for candidate company NAMES (no ATS guessing), then
 * deterministically resolve each name against the three public ATS endpoints
 * via lib/discovery/slug-probe.ts:resolveCompanyToBoard. Returns two buckets:
 *
 *   - verified  → company + (greenhouse|lever|ashby, slug) we actually
 *                 confirmed by HTTP probe; safe to create a watchlist for.
 *   - unverified → company name + Gemini's careersUrl. Surfaces companies
 *                  on Workday, self-hosted careers pages, or with slugs that
 *                  don't match the company name. The user copies these to a
 *                  future Claude session to wire up bespoke support.
 *
 * Why deterministic and not "ask Gemini for the slug": Gemini guesses slug ==
 * companyname for everything, which 404s on real companies that exist at
 * boards.greenhouse.io/<actual-slug>. Probing slug variants ourselves is
 * cheap (all three ATSes have public GET endpoints) and far more accurate.
 *
 * Anti-repetition is load-bearing — see memory[feedback-llm-anti-repetition].
 * The `exclude` list is passed to Gemini AS A FIRST-CLASS instruction; without
 * it Gemini loops the same canonical 5-7 names for any topic. The route
 * combines the curated COMPANY_DIRECTORY entries for the topic + the user's
 * existing watchlist company names + any caller-supplied additional excludes
 * (so successive "Refresh suggestions" clicks keep digging).
 */
import { z } from "zod";
import { chatJSON } from "@/lib/ai/gemini";
import { resolveCompanyToBoard, type ProbableKind } from "@/lib/discovery/slug-probe";

const GeminiCandidateSchema = z.object({
    name: z.string().min(1),
    blurb: z.string().optional().default(""),
    careersUrl: z.string().optional().default(""),
});

const GeminiResponseSchema = z.object({
    candidates: z.array(GeminiCandidateSchema),
});

export type GeminiCandidate = z.infer<typeof GeminiCandidateSchema>;

export interface VerifiedSuggestion {
    name: string;
    blurb: string;
    kind: ProbableKind;
    slug: string;
    /** What postings get attributed to — same as `name` for now. */
    companyName: string;
    jobCount: number;
}

export interface UnverifiedSuggestion {
    name: string;
    blurb: string;
    careersUrl: string;
    /** Kept on the wire for the modal's existing UI; always "unknown" now
     *  that we no longer ask Gemini to guess. */
    atsGuess: string;
    /** Free-text reason the user can act on. */
    reason: string;
}

export interface SuggestResult {
    topic: string;
    verified: VerifiedSuggestion[];
    unverified: UnverifiedSuggestion[];
    /** Count of Gemini suggestions filtered out by the exclude list. */
    excludedCount: number;
    /** Total raw suggestions from Gemini, pre-exclude. */
    totalSuggested: number;
}

export interface SuggestOptions {
    topic: string;
    /** Case-insensitive names to exclude. Combined with provider-side excludes. */
    exclude?: ReadonlyArray<string>;
    /** Override the Gemini ask count. Defaults to 20. */
    count?: number;
    /** How many companies to resolve in parallel. Each company internally
     *  probes ATSes sequentially (short-circuits on first hit). Default 5 —
     *  combined with per-host limiter in slug-probe.ts that bounds in-flight
     *  per ATS, this gives ~3-5 concurrent HTTP per host worst case. */
    companyConcurrency?: number;
    /** Test seam — injects a fake candidate-source so the hermetic smoke can
     *  exercise the resolve flow without hitting Gemini. */
    _suggestFn?: (prompt: string) => Promise<{ candidates: GeminiCandidate[] }>;
}

function buildPrompt(topic: string, exclude: string[], count: number): string {
    const excludeBlock = exclude.length > 0
        ? `EXCLUDED — do NOT suggest any of these (the user already has them):\n${exclude.map(n => `- ${n}`).join("\n")}`
        : `(The user has nothing in this topic yet — suggest from scratch.)`;
    return [
        `You're helping a job seeker discover companies in the topic: "${topic}".`,
        ``,
        excludeBlock,
        ``,
        `Suggest ${count} ADDITIONAL companies in this topic that are NOT in the excluded list. Prefer real companies actively hiring. Include both well-known players AND smaller / less-obvious ones — the user already has the canonical names, they need depth.`,
        ``,
        `For each company return:`,
        `  - name        canonical company name`,
        `  - blurb       one short sentence about what they do, under 80 chars`,
        `  - careersUrl  the public careers-page URL you're confident exists (or "" if unsure)`,
        ``,
        `Do NOT guess the ATS or fabricate slugs — we verify ATS connectivity ourselves downstream by probing greenhouse / lever / ashby with the company name. Focus on returning real companies; that's the only thing we need from you.`,
        ``,
        `Return JSON: { "candidates": [ ... ] }. No prose, no markdown fence.`,
    ].join("\n");
}

function normalize(s: string): string {
    return s.trim().toLowerCase();
}

async function workerPool<T, R>(
    items: ReadonlyArray<T>,
    concurrency: number,
    worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const run = async () => {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    };
    const n = Math.min(Math.max(1, concurrency), items.length);
    if (n === 0) return results;
    await Promise.all(Array.from({ length: n }, run));
    return results;
}

export async function suggestCompanies(opts: SuggestOptions): Promise<SuggestResult> {
    const topic = opts.topic.trim();
    if (!topic) throw new Error("topic is required");
    const count = opts.count ?? 20;
    const concurrency = opts.companyConcurrency ?? 5;
    const exclude = Array.from(new Set((opts.exclude ?? []).map(n => n.trim()).filter(Boolean)));
    const excludeSet = new Set(exclude.map(normalize));

    const prompt = buildPrompt(topic, exclude, count);
    const response = opts._suggestFn
        ? await opts._suggestFn(prompt)
        : await chatJSON({
            user: prompt,
            schema: GeminiResponseSchema,
            // Higher temp than the default 0.4 — discovery benefits from
            // exploration; lower temp tends to converge on the same handful
            // of canonical names even with anti-repetition wording.
            temperature: 0.9,
            // Inherits MODEL_LITE default — exploration over a short list
            // of names + blurbs doesn't need full Flash. 20 candidates ×
            // ~50 output tokens per entry ≈ 1k. 4k is plenty of headroom.
            maxOutputTokens: 4096,
        });

    const totalSuggested = response.candidates.length;

    // Provider-side defense — Gemini sometimes repeats excluded names anyway
    // (especially when they're famous in the topic). Cull here before
    // resolving so we don't waste HTTP requests on duplicates.
    const candidates = response.candidates.filter(c => !excludeSet.has(normalize(c.name)));
    const excludedCount = totalSuggested - candidates.length;

    // Per company: sequential probe across slug variants × ATSes (in
    // resolveCompanyToBoard), short-circuit on first hit. Across companies:
    // parallel up to `concurrency`. The 24h cache in slug-probe makes
    // repeated discover sessions for the same company free.
    const resolved = await workerPool(candidates, concurrency, async (c) => {
        return await resolveCompanyToBoard(c.name);
    });

    const verified: VerifiedSuggestion[] = [];
    const unverified: UnverifiedSuggestion[] = [];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const r = resolved[i];
        if (r) {
            verified.push({
                name: c.name,
                blurb: c.blurb,
                kind: r.kind,
                slug: r.slug,
                companyName: c.name,
                jobCount: r.jobCount,
            });
        } else {
            unverified.push({
                name: c.name,
                blurb: c.blurb,
                careersUrl: c.careersUrl,
                atsGuess: "unknown",
                reason: "No public Greenhouse/Lever/Ashby board found for this name — likely Workday, a self-hosted careers page, or a slug that doesn't match the company name. Needs custom integration.",
            });
        }
    }

    return { topic, verified, unverified, excludedCount, totalSuggested };
}
