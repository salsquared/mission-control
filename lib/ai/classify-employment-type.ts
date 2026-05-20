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

// Positional output — model returns an array of types in the same order the
// inputs were sent. Stops the model from echoing every external id back
// (Workday/Lever UUIDs are 20-40 chars apiece — that was burning ~70% of the
// output budget for no signal). Caller maps array index → input id.
const ResultSchema = z.object({
    types: z.array(z.enum(["full-time", "part-time", "internship", "contract", "temporary"]).nullable()),
});

// 50 keeps the prompt well under Gemini's 32k output budget while still
// amortising the per-request rate-bucket cost. Bigger batches save calls but
// raise the chance of one bad item failing schema validation for the whole
// batch — 50 is the empirical sweet spot from MB Phase 1 testing.
const BATCH_SIZE = 50;

const SYSTEM_PROMPT = `Classify each posting by employment type. Choose one of:
- "full-time": permanent salaried role (Engineer, Manager, Director, Staff/Senior X). Also paid post-grad fellowships at labs/companies (Anthropic Fellows, OpenAI Residency, "Research Fellow", "AI Safety Fellow") — these are typically 6-12mo W-2 roles for experienced hires.
- "internship": interns, co-ops, apprentices, student seasonal programs (Summer 2026 SWE). A summer-term fellowship tied to a student cohort goes here.
- "contract": 1099, freelance, fixed-term consulting. NOT "Contract Manager"/"Contract Specialist"/"Contract Negotiator" — those administer contracts and are full-time.
- "part-time": explicitly part-time hourly.
- "temporary": seasonal or short-term temp.
- null: genuinely ambiguous AND no signal.

Default to "full-time" for typical engineering/operations titles. Output: {"types":["full-time","internship",null,...]} — one entry per input line, same order, no other fields.`;

function buildUserPrompt(items: ClassifyInput[]): string {
    // Pipe-delimited, one row per line. Index|Company|Title|Location.
    // Snippet/department dropped: title is the load-bearing signal and the
    // disambiguation rules live in the system prompt, not the data. Verified
    // empirically: including snippet did not change classification on any of
    // the live-probe fixtures (including the "Anthropic AI Safety Fellow"
    // edge case) — only added ~9 % prompt tokens.
    const lines = items.map((it, i) =>
        `${i}|${it.company}|${it.title}|${it.location ?? ""}`,
    );
    return `Classify each line below (one row per line). Return ${items.length} types in input order.\n\n${lines.join("\n")}`;
}

// Injectable for hermetic tests (scripts/tests/hermetic/classify-employment-type-smoke.ts).
// Production callers omit it and get the real Gemini-backed chatJSON.
export type ChatJSONFn = typeof chatJSON;

async function classifyOneBatch(
    items: ClassifyInput[],
    batchIdx: number,
    totalBatches: number,
    chatFn: ChatJSONFn = chatJSON,
): Promise<Map<string, EmploymentType | null>> {
    const start = Date.now();
    const result = await chatFn({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(items),
        schema: ResultSchema,
        temperature: 0.1,
        // Pure enum picker — output space is { full-time | part-time |
        // internship | contract | temporary | null } per item. Cheapest
        // model is invisible-quality here. See docs/llm-calls.md.
        model: MODEL_LITE_CHEAP,
        // 50-item array of short enum strings — worst-case ~400 tokens. 1024
        // leaves headroom for array wrapping and surfaces any unexpected
        // growth as a MAX_TOKENS error (caught in chatJSON) instead of
        // silently burning the old 4k budget.
        maxOutputTokens: 1024,
    });
    const elapsed = Date.now() - start;
    const out = new Map<string, EmploymentType | null>();
    // Positional alignment: result.types[i] is the answer for items[i]. If the
    // model returned fewer (or somehow more) than we asked for, only the
    // prefix that aligns is trusted; the rest default to null below.
    const aligned = Math.min(result.types.length, items.length);
    for (let i = 0; i < aligned; i++) {
        out.set(items[i].id, result.types[i]);
    }
    // Surface every input id even if the model dropped it — caller relies on
    // `has(id)` to detect "saw it, decided null" vs "model lost it".
    const missing = items.filter(it => !out.has(it.id));
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
    chatFn: ChatJSONFn = chatJSON,
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
        const batchResult = await classifyOneBatch(batches[i], i, batches.length, chatFn);
        for (const [k, v] of batchResult) merged.set(k, v);
    }
    const elapsed = Date.now() - start;
    const decided = Array.from(merged.values()).filter(v => v !== null).length;
    console.info(
        `[employment-type-classifier] DONE ${items.length} items / ${batches.length} batch(es) in ${elapsed}ms (${Math.round(elapsed / items.length)}ms/item) — ${decided} classified, ${items.length - decided} null`,
    );
    return merged;
}
