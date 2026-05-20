/**
 * Tier B employment-type classifier — batched LLM fallback for the
 * lib/fetchers/employment-type.ts heuristic.
 *
 * Most ATSes (Workday, careers-page, LinkedIn, Greenhouse w/o metadata) don't
 * expose an employment-type field. Title-keyword inference catches the obvious
 * cases (Internship, Contract, Summer 2026) but leaves generic titles like
 * "Software Engineer III" as NULL — which the UI then renders as "Unspecified".
 *
 * This module batches those nulls into a single Gemini Flash call per crawl
 * and returns a definitive answer (defaulting to "full-time" for unambiguous
 * permanent-role titles). One call per ~50 postings, gated to new postings
 * only by the caller in scheduler/jobs/job-watcher.ts so we don't re-classify
 * rows that are already in the DB.
 *
 * Timing: every batch logs `[employment-type-classifier]` lines with
 * per-batch latency, item count, and ms/item. The overall run logs a summary.
 * If those numbers drift above a few seconds per batch we'll swap to a local
 * model (Gemma-3n on the mac mini) — keep the call shape thin to make that
 * easy.
 */
import { z } from "zod";
import { chatJSON, MODEL_LITE_CHEAP } from "@/lib/ai/gemini";
import { EMPLOYMENT_TYPES, type EmploymentType } from "@/lib/fetchers/employment-type";

export interface ClassifyInput {
    /** Stable ID supplied by the caller (we use the posting's externalId). */
    id: string;
    company: string;
    title: string;
    snippet: string | null;
    location: string | null;
}

const ResultSchema = z.object({
    items: z.array(z.object({
        id: z.string(),
        employmentType: z.enum(["full-time", "part-time", "internship", "contract", "temporary"]).nullable(),
    })),
});

// 50 keeps the prompt well under Gemini's 32k output budget while still
// amortising the per-request rate-bucket cost. Bigger batches save calls but
// raise the chance of one bad item failing schema validation for the whole
// batch — 50 is the empirical sweet spot from MB Phase 1 testing.
const BATCH_SIZE = 50;

const SYSTEM_PROMPT = `You classify job postings by employment type.

For each posting, choose exactly one of:
- "full-time": salaried permanent role (Engineer, Manager, Director, Senior X, Staff X, etc.). DEFAULT when the title implies a typical permanent position at a normal company.
- "part-time": explicitly part-time hourly role.
- "internship": interns, co-ops, apprenticeships, fellowships, seasonal student programs (Summer 2026 SWE, Anthropic Fellows Program).
- "contract": 1099, freelance, fixed-term consulting. Does NOT include "Contract Manager" / "Contract Specialist" / "Contract Negotiator" — those are permanent roles administering contracts. Only when the WORKER is hired on contract.
- "temporary": seasonal or short-term hourly work, temp positions.

Use null ONLY when the title is genuinely ambiguous AND no other signal helps. When in doubt for a normal-looking software/engineering/operations title at a normal company, pick "full-time".

Output EXACTLY one entry per input id, preserving the input id values verbatim. Output schema:
{ "items": [ { "id": "<input id>", "employmentType": "full-time" | "part-time" | "internship" | "contract" | "temporary" | null }, ... ] }`;

function buildUserPrompt(items: ClassifyInput[]): string {
    const rows = items.map(i => ({
        id: i.id,
        company: i.company,
        title: i.title,
        department: i.snippet ?? null,
        location: i.location ?? null,
    }));
    return `Classify each of these postings.\n\n${JSON.stringify(rows, null, 2)}`;
}

async function classifyOneBatch(
    items: ClassifyInput[],
    batchIdx: number,
    totalBatches: number,
): Promise<Map<string, EmploymentType | null>> {
    const start = Date.now();
    const result = await chatJSON({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(items),
        schema: ResultSchema,
        temperature: 0.1,
        // Pure enum picker — output space is { full-time | part-time |
        // internship | contract | temporary | null } per item. Cheapest
        // model is invisible-quality here. See docs/llm-calls.md.
        model: MODEL_LITE_CHEAP,
        // 50-item batch × ~30 output tokens per row = ~1.5k worst case.
        // 4k leaves headroom for the array wrapping + a few longer ids.
        maxOutputTokens: 4096,
    });
    const elapsed = Date.now() - start;
    const out = new Map<string, EmploymentType | null>();
    for (const item of result.items) {
        if (EMPLOYMENT_TYPES.includes(item.employmentType as EmploymentType) || item.employmentType === null) {
            out.set(item.id, item.employmentType);
        }
    }
    // Surface every input id even if the model dropped it — caller relies on
    // `has(id)` to detect "saw it, decided null" vs "model lost it".
    const missing = items.filter(i => !out.has(i.id));
    for (const m of missing) out.set(m.id, null);
    console.info(
        `[employment-type-classifier] batch ${batchIdx + 1}/${totalBatches}: ${items.length} items in ${elapsed}ms (${Math.round(elapsed / items.length)}ms/item)${missing.length ? `, ${missing.length} missing-from-response (defaulted null)` : ""}`,
    );
    return out;
}

/**
 * Classify a list of postings in batches. Returns a Map<id, EmploymentType | null>.
 * Caller is expected to filter to *new postings with null employmentType* before
 * calling — we don't re-classify rows already in the DB.
 *
 * Throws if any batch fails after retries (caller in job-watcher catches and
 * falls back to leaving the postings as Unspecified — strictly degrades, never
 * worse than today's behavior).
 */
export async function classifyEmploymentTypes(
    items: ClassifyInput[],
): Promise<Map<string, EmploymentType | null>> {
    if (items.length === 0) return new Map();
    const batches: ClassifyInput[][] = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        batches.push(items.slice(i, i + BATCH_SIZE));
    }
    const start = Date.now();
    // Sequential, not Promise.all — the Gemini rate limiter (12 req/min) would
    // serialize parallel calls anyway, and a 429 in one parallel branch can
    // poison the others. Sequential keeps the timing logs interpretable.
    const merged = new Map<string, EmploymentType | null>();
    for (let i = 0; i < batches.length; i++) {
        const batchResult = await classifyOneBatch(batches[i], i, batches.length);
        for (const [k, v] of batchResult) merged.set(k, v);
    }
    const elapsed = Date.now() - start;
    const decided = Array.from(merged.values()).filter(v => v !== null).length;
    console.info(
        `[employment-type-classifier] DONE ${items.length} items / ${batches.length} batch(es) in ${elapsed}ms (${Math.round(elapsed / items.length)}ms/item) — ${decided} classified, ${items.length - decided} null`,
    );
    return merged;
}
