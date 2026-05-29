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

// Below this many characters we treat the fetched/pasted posting as unusable
// (near-empty → nothing for the LLM to extract). Used both as the parsePosting
// guard AND as the "is the rendered DOM substantial enough?" bar in
// extractPostingTextFromHtml before falling back to embedded JSON.
const MIN_POSTING_TEXT_CHARS = 30;

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

// ─── embedded-JSON fallback for client-rendered (SPA) ATS portals ──────────
//
// Many modern ATS job boards are client-rendered single-page apps: the server
// ships a near-empty <body> and hydrates the posting with JavaScript after
// load. A static fetch + cheerio DOM read (our approach — no headless browser)
// therefore returns ZERO visible text, and parsePosting would throw "empty or
// too short" even though the page clearly has content.
//
// The content isn't gone, though — these frameworks serialize the full posting
// into the initial HTML as a JSON blob, just inside <script> tags (which our
// DOM pass strips). Two near-universal carriers:
//
//   • Dayforce HCM (jobs.dayforcehcm.com), and any Next.js-built board, embed a
//     <script id="__NEXT_DATA__"> blob. Dayforce nests the posting under a node
//     with `jobTitle` + a `jobPostingContent` object holding the description
//     (header / body / footer).
//   • Greenhouse, LinkedIn, and many job boards emit a schema.org
//     <script type="application/ld+json"> with `@type: "JobPosting"` and a
//     standard `description` field.
//
// Workday and some others use yet other shapes (and a few are pure XHR with no
// initial-state blob at all — those still need a paste). We cover the two
// common carriers here; anything we can't read falls through to the paste tab.
function stripHtmlToText(s: string): string {
    if (!s) return "";
    // Embedded descriptions are HTML fragments with entities; cheerio strips
    // tags and decodes entities in one pass.
    return clean(cheerio.load(s).root().text());
}

// JSON-LD payloads come as a single object, an array, or an object whose
// `@graph` holds the nodes. Flatten to a list of plain objects.
function jsonLdNodes(parsed: unknown): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const visit = (n: unknown) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) { n.forEach(visit); return; }
        const obj = n as Record<string, unknown>;
        out.push(obj);
        if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
    };
    visit(parsed);
    return out;
}

function extractJsonLdJobPosting($: cheerio.CheerioAPI): string | null {
    let best: string | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        if (best) return;
        const raw = ($(el).html() || $(el).text() || "").trim();
        if (!raw) return;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return; }
        for (const node of jsonLdNodes(parsed)) {
            const type = node["@type"];
            const isJob = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
            if (!isJob) continue;
            const parts: string[] = [];
            // Every field gets stripHtmlToText: titles/org names can carry HTML
            // entities (e.g. "R&amp;D", "Don&#39;t") and JSON doesn't decode them.
            if (typeof node.title === "string") parts.push(stripHtmlToText(node.title));
            const org = node.hiringOrganization;
            if (org && typeof org === "object" && typeof (org as Record<string, unknown>).name === "string") {
                parts.push(stripHtmlToText((org as Record<string, unknown>).name as string));
            } else if (typeof org === "string") {
                parts.push(stripHtmlToText(org));
            }
            if (typeof node.description === "string") parts.push(stripHtmlToText(node.description));
            const joined = clean(parts.join("\n"));
            if (joined.length >= MIN_POSTING_TEXT_CHARS) { best = joined; return; }
        }
    });
    return best;
}

// Recursively locate the posting node in a __NEXT_DATA__ tree. Anchored on the
// pair (`jobTitle` string + `jobPostingContent` object) so we don't match the
// i18n string dictionary these blobs also carry (whose innocuous keys like
// "description":"Description" a looser match would grab).
function findNextDataJobNode(o: unknown, depth = 0): Record<string, unknown> | null {
    if (!o || typeof o !== "object" || depth > 25) return null;
    if (Array.isArray(o)) {
        for (const item of o) { const r = findNextDataJobNode(item, depth + 1); if (r) return r; }
        return null;
    }
    const obj = o as Record<string, unknown>;
    if (typeof obj.jobTitle === "string" && obj.jobPostingContent && typeof obj.jobPostingContent === "object") {
        return obj;
    }
    for (const k of Object.keys(obj)) {
        const r = findNextDataJobNode(obj[k], depth + 1);
        if (r) return r;
    }
    return null;
}

function extractNextDataJobPosting($: cheerio.CheerioAPI): string | null {
    const raw = ($("script#__NEXT_DATA__").html() || $("script#__NEXT_DATA__").text() || "").trim();
    if (!raw) return null;
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return null; }
    const node = findNextDataJobNode(json);
    if (!node) return null;
    const parts: string[] = [];
    if (typeof node.jobTitle === "string") parts.push(stripHtmlToText(node.jobTitle));
    const content = node.jobPostingContent;
    if (content && typeof content === "object") {
        for (const v of Object.values(content as Record<string, unknown>)) {
            if (typeof v === "string" && v.trim()) parts.push(stripHtmlToText(v));
        }
    }
    const joined = clean(parts.join("\n"));
    return joined.length >= MIN_POSTING_TEXT_CHARS ? joined : null;
}

function extractEmbeddedPostingText($: cheerio.CheerioAPI): string | null {
    // JSON-LD first (standardized, unambiguous), then the Next.js blob.
    return extractJsonLdJobPosting($) ?? extractNextDataJobPosting($);
}

/**
 * Pure HTML → posting-text extractor (no network). Exported for hermetic tests.
 * Prefers the rendered DOM text; when that comes back empty/too short (a
 * client-rendered SPA), falls back to posting JSON embedded in <script> tags.
 * Result is capped at MAX_INPUT_CHARS. Returns "" when nothing usable is found.
 */
export function extractPostingTextFromHtml(html: string): string {
    const $ = cheerio.load(html);
    // Read embedded JSON BEFORE we strip <script> tags for the DOM pass.
    const embedded = extractEmbeddedPostingText($);
    $("script, style, nav, footer, header, noscript, svg").remove();
    const body = $("main, [role=main], article, body").first();
    const domText = clean(body.length ? body.text() : $.root().text());
    const chosen = domText.length >= MIN_POSTING_TEXT_CHARS ? domText : (embedded ?? domText);
    return chosen.slice(0, MAX_INPUT_CHARS);
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
    // DOM text when present; embedded posting JSON as the SPA fallback.
    return extractPostingTextFromHtml(html);
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

    if (rawText.length < MIN_POSTING_TEXT_CHARS) {
        // A client-rendered SPA whose posting JSON we couldn't read (Workday,
        // an unrecognized blob shape) lands here too — the message points at the
        // paste tab, which bypasses scraping entirely.
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
