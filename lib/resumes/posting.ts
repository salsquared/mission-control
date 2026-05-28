import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { z } from "zod";
import { chatJSON } from "@/lib/ai/gemini";
import { loadPrompt } from "@/lib/ai/prompts";
import { assertExternalHttpUrl, assertSafeResponseUrl } from "@/lib/security/url-guard";

// Test seam: parsePosting accepts an injectable chat function so hermetic
// smokes can count LLM calls (and assert the cache below actually elides
// them) without mocking the module. Defaults to the real chatJSON.
export type ChatJSONFn = typeof chatJSON;

export interface PostingInput {
    url?: string;
    text?: string;
}

export interface ParsedPosting {
    title: string | null;
    company: string | null;
    location: string | null;
    seniority: string | null;
    rawText: string;
    sourceUrl: string | null;
    keywords: string[];
    // Posting-keyword importance multiplier, keyed by LOWERCASED keyword.
    // Range 1–5: 1 = commodity skill / table stakes, 5 = primary
    // differentiator (e.g. domain-specific keyword like "Space Systems"
    // for a Rocket Lab posting, or compliance-specific like "ITAR"). The
    // bullet scorer multiplies its base weight by this when computing per-
    // bullet score. Missing keys default to 1 — i.e. legacy behavior for
    // any caller that doesn't supply weights.
    //
    // Optional on the interface so existing in-tree fixture literals don't
    // need to spell out an empty `{}`; `parsePosting` always populates it.
    keywordWeights?: Record<string, number>;
}

// Posting-parse LLM output. Accepts BOTH the legacy `string[]` form (for
// safety against stale Lunary templates that haven't been re-synced) AND
// the new `{keyword, importance}` form. Normalized into the structured
// form by `parsePosting` after validation.
const KeywordEntrySchema = z.union([
    z.string(),
    z.object({
        keyword: z.string().min(1),
        importance: z.number().min(1).max(5),
    }),
]);

const PostingExtractSchema = z.object({
    title: z.string().nullable(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    seniority: z.string().nullable(),
    keywords: z.array(KeywordEntrySchema).min(1).max(40),
});

// Job postings have their signal up top — title, must-haves, tech stack.
// The tail is benefits/equal-opportunity/legal boilerplate. 8KB captures
// the meaningful portion; tightened from 12KB on 2026-05-19 alongside the
// model swap to flash-lite. See docs/llm-calls.html.
const MAX_INPUT_CHARS = 8_000;

function clean(s: string): string {
    return s.replace(/[ \s]+/g, " ").trim();
}

// ─── posting-parse result cache ──────────────────────────────────────────
//
// parsePosting is invoked once per resume generate (app/api/resumes). Before
// this cache, generating N tailored variants against the SAME posting meant N
// identical URL fetches + N identical Gemini calls (LITE, 3072 out, 8 KB in).
// The parse output is a pure function of the resolved posting text, so we
// memoize it keyed on content:
//   - pasted text  → key = "t:" + sha256(cleaned+capped text). Content-keyed,
//                     so it can never go stale: identical text ⇒ identical parse.
//   - URL only     → key = "u:" + sourceUrl, computed BEFORE the fetch so a hit
//                     skips both the slow scrape AND the LLM call. TTL-bounded
//                     because the live posting could change/close under us.
// Process-memory (stashed on globalThis for HMR safety, same pattern as the
// Prisma client + logger ring buffer). Not shared across PM2 processes — each
// tier memoizes independently, which is fine: the win is intra-session repeat
// generates, not cross-process coherence.
const POSTING_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — bounds URL staleness
const POSTING_CACHE_MAX = 200;

interface PostingCacheEntry {
    value: ParsedPosting;
    expires: number;
}

const cacheStore: Map<string, PostingCacheEntry> = (() => {
    const g = globalThis as unknown as { __postingParseCache?: Map<string, PostingCacheEntry> };
    return g.__postingParseCache ?? (g.__postingParseCache = new Map());
})();

function cacheGet(key: string, now: number): ParsedPosting | null {
    const hit = cacheStore.get(key);
    if (!hit) return null;
    if (hit.expires <= now) {
        cacheStore.delete(key);
        return null;
    }
    // Refresh insertion order so the cap eviction below is LRU-ish.
    cacheStore.delete(key);
    cacheStore.set(key, hit);
    // Clone so a caller mutating the returned object can't poison the cache.
    return structuredClone(hit.value);
}

function cacheSet(key: string, value: ParsedPosting, now: number): void {
    cacheStore.set(key, { value: structuredClone(value), expires: now + POSTING_CACHE_TTL_MS });
    // Evict oldest entries past the cap (Map iterates in insertion order).
    while (cacheStore.size > POSTING_CACHE_MAX) {
        const oldest = cacheStore.keys().next().value;
        if (oldest === undefined) break;
        cacheStore.delete(oldest);
    }
}

/** Test seam — clears the process-memory parse cache between hermetic cases. */
export function _clearPostingParseCache(): void {
    cacheStore.clear();
}

async function fetchVisibleText(url: string): Promise<string> {
    assertExternalHttpUrl(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8_000);
    let res: Response;
    try {
        res = await fetch(url, {
            headers: {
                "User-Agent": "mission-control-resume-bot/1.0 (+https://mc.local)",
                "Accept": "text/html,application/xhtml+xml",
            },
            redirect: "follow",
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    // Re-check in case the redirect chain landed on an internal target.
    assertSafeResponseUrl(res);
    const html = await res.text();
    const $ = cheerio.load(html);
    // Drop noise
    $("script, style, nav, footer, header, noscript, svg").remove();
    const body = $("main, [role=main], article, body").first();
    const text = clean(body.length ? body.text() : $.root().text());
    return text.slice(0, MAX_INPUT_CHARS);
}

export async function parsePosting(
    input: PostingInput,
    chatFn: ChatJSONFn = chatJSON,
): Promise<ParsedPosting> {
    let rawText = "";
    let sourceUrl: string | null = null;
    const hasUrl = !!input.url && input.url.trim().length > 0;
    const hasText = !!input.text && input.text.trim().length > 0;

    // When both are supplied, the pasted text wins — it's almost always more
    // accurate than what we can scrape, and the user clearly wanted to override.
    // Skip the URL fetch entirely in that case (saves a slow round-trip and
    // dodges SSRF-guard rejections from URLs the user only included for
    // archival purposes).
    if (hasUrl) sourceUrl = input.url!.trim();

    // Resolve the cache key up front. For pasted text we must clean+cap first
    // (so the key matches the bytes actually parsed); for URL-only we key on
    // the URL so a hit skips the fetch entirely. Text wins, mirroring the
    // rawText precedence below.
    const now = Date.now();
    let cacheKey: string | null = null;
    if (hasText) {
        rawText = clean(input.text!).slice(0, MAX_INPUT_CHARS);
        cacheKey = "t:" + createHash("sha256").update(rawText).digest("hex");
    } else if (hasUrl) {
        cacheKey = "u:" + sourceUrl!;
    }

    if (cacheKey) {
        const cached = cacheGet(cacheKey, now);
        if (cached) return cached;
    }

    if (!hasText && hasUrl) {
        rawText = await fetchVisibleText(sourceUrl!);
    }

    if (rawText.length < 30) {
        throw new Error("Posting input is empty or too short — provide a URL or paste the listing text.");
    }

    const prompt = await loadPrompt("posting-parse", { postingText: rawText });

    const extracted = await chatFn({
        name: "posting-parse",
        system: prompt.system,
        user: prompt.user,
        schema: PostingExtractSchema,
        temperature: 0.2,
        // Inherits MODEL_LITE default — keyword extraction is mechanical.
        // Output is ~5 short fields + 10–25 `{keyword, importance}` objects;
        // 3k accommodates the per-keyword importance objects (each ~15-25
        // tokens vs ~5 for bare strings) plus headroom.
        maxOutputTokens: 3072,
    });

    const keywords: string[] = [];
    const keywordWeights: Record<string, number> = {};
    for (const entry of extracted.keywords) {
        if (typeof entry === "string") {
            // Legacy form — default importance to 1 (neutral, identical to
            // pre-importance behavior).
            keywords.push(entry);
            keywordWeights[entry.toLowerCase()] = 1;
        } else {
            keywords.push(entry.keyword);
            keywordWeights[entry.keyword.toLowerCase()] = entry.importance;
        }
    }

    const result: ParsedPosting = {
        title: extracted.title,
        company: extracted.company,
        location: extracted.location,
        seniority: extracted.seniority,
        rawText,
        sourceUrl,
        keywords,
        keywordWeights,
    };

    if (cacheKey) cacheSet(cacheKey, result, now);
    return result;
}
