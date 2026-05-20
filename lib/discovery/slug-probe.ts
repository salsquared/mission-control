/**
 * Slug-probe helpers for the topical-discovery flow.
 *
 * Approach: don't trust Gemini to know which ATS a company uses. Take the
 * company name, deterministically generate slug candidates from it, and probe
 * the three public ATS endpoints (greenhouse / lever / ashby) in sequence.
 * First hit wins; rest are skipped. Results are cached so successive discover
 * sessions don't re-probe the same names.
 *
 * Scope:
 *  - greenhouse / lever / ashby — public board endpoints, single GET, easy.
 *  - workday — skipped. POST + tenant host validation is too noisy to auto-
 *    verify; Gemini hallucinates tenant hosts badly. Workday companies land
 *    in the modal's "needs custom integration" bucket as `null` resolutions.
 *  - linkedin / careers-page — not company-keyed; not applicable.
 */
import { z } from "zod";
import { cachedValue } from "@/lib/cache";

export type ProbableKind = "greenhouse" | "lever" | "ashby";

export interface SlugProbeResult {
    ok: boolean;
    kind: ProbableKind;
    slug: string;
    /** Live posting count when ok=true; informational only. */
    jobCount?: number;
    /** Set on failure: HTTP status if the request returned a non-2xx. */
    status?: number;
    /** Set on failure: free-text reason (network error, timeout, etc.). */
    error?: string;
}

export interface ResolvedBoard {
    kind: ProbableKind;
    slug: string;
    jobCount: number;
}

const PROBE_TIMEOUT_MS = 8_000;
const USER_AGENT = "mission-control/0.1 directory-verify";

// Per-host rate limit. With company-level parallelism (default 5) plus
// per-company sequential probing, in-flight count per host is naturally
// bounded — but defense-in-depth here keeps a bursty discover session from
// tripping any of the ATSes' edge throttling. Min-interval adds a small floor
// between request *starts* so we don't appear as a tight burst even when 4
// slots open simultaneously.
const HOST_MAX_CONCURRENT = 4;
const HOST_MIN_INTERVAL_MS = 100;

// 24h positive+negative TTL on company resolutions. A company switching ATS
// providers within a day is exceedingly rare; the upside is repeated discover
// clicks across the day cost zero outbound probes for already-seen names.
const RESOLVE_TTL_SECONDS = 24 * 60 * 60;

class HostLimiter {
    private active = 0;
    private queue: Array<() => void> = [];
    private lastStartAt = 0;
    constructor(private readonly max: number, private readonly minInterval: number) {}

    async acquire(): Promise<void> {
        if (this.active < this.max) {
            this.active++;
        } else {
            // Slot transfer pattern: a waiter resumes with the slot already
            // owned, releaser does NOT decrement when handing off. Prevents
            // the classic "decrement-then-reincrement" race that lets active
            // briefly exceed max.
            await new Promise<void>(resolve => this.queue.push(resolve));
        }
        const wait = this.lastStartAt + this.minInterval - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.lastStartAt = Date.now();
    }

    release(): void {
        const next = this.queue.shift();
        if (next) next();
        else this.active--;
    }
}

declare global {
    var __mcDiscoveryHostLimiters: Record<ProbableKind, HostLimiter> | undefined;
}

const HOST_LIMITERS: Record<ProbableKind, HostLimiter> = globalThis.__mcDiscoveryHostLimiters ?? {
    greenhouse: new HostLimiter(HOST_MAX_CONCURRENT, HOST_MIN_INTERVAL_MS),
    lever: new HostLimiter(HOST_MAX_CONCURRENT, HOST_MIN_INTERVAL_MS),
    ashby: new HostLimiter(HOST_MAX_CONCURRENT, HOST_MIN_INTERVAL_MS),
};
if (process.env.NODE_ENV !== "production") {
    globalThis.__mcDiscoveryHostLimiters = HOST_LIMITERS;
}

function endpointFor(kind: ProbableKind, slug: string): string {
    if (kind === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    if (kind === "lever") return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
}

// Each ATS exposes a slightly different envelope:
//   Greenhouse → { jobs: [...] }
//   Lever      → [...]  (top-level array)
//   Ashby      → { jobs: [...] } usually, sometimes { data: [...] }
function countJobs(body: unknown): number {
    if (Array.isArray(body)) return body.length;
    if (body && typeof body === "object") {
        const obj = body as { jobs?: unknown; data?: unknown };
        if (Array.isArray(obj.jobs)) return obj.jobs.length;
        if (Array.isArray(obj.data)) return obj.data.length;
    }
    return 0;
}

export async function probeSlug(kind: ProbableKind, slug: string): Promise<SlugProbeResult> {
    if (!slug) return { ok: false, kind, slug, error: "empty slug" };
    const limiter = HOST_LIMITERS[kind];
    await limiter.acquire();
    try {
        const url = endpointFor(kind, slug);
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) {
            return { ok: false, kind, slug, status: res.status, error: `HTTP ${res.status}` };
        }
        const body = await res.json().catch(() => null);
        return { ok: true, kind, slug, status: res.status, jobCount: countJobs(body) };
    } catch (e) {
        return { ok: false, kind, slug, error: e instanceof Error ? e.message : String(e) };
    } finally {
        limiter.release();
    }
}

// ─── Company name → slug candidates ──────────────────────────────────────

// Common trailing tokens that aren't part of the canonical ATS slug. Leading
// articles ("the") are NOT stripped — companies that include "The" usually
// do so in their slug too (e.g. "The Browser Company" → "thebrowsercompany").
const CORPORATE_SUFFIXES = new Set([
    "inc", "incorporated", "corp", "corporation",
    "llc", "ltd", "limited",
    "co", "company",
]);

// Cap variants to keep the worst-case probe cost bounded. With 3 ATSes per
// variant, a fully-failed lookup costs MAX_SLUG_VARIANTS × 3 HTTP calls. The
// canonical, dashed, and underscored forms catch >95% of real-world slugs;
// suffix-stripping adds the long tail.
const MAX_SLUG_VARIANTS = 4;

// Greenhouse is more common than Lever/Ashby for the kinds of companies in
// the topical-discovery space — try it first to short-circuit faster on
// average.
const KIND_ORDER: ProbableKind[] = ["greenhouse", "lever", "ashby"];

function normalizeForSlug(s: string): string {
    return s.toLowerCase().trim()
        // Drop apostrophes outright so "L'Oreal" doesn't turn into "l-oreal".
        .replace(/['']/g, "")
        // "AT&T" → "at and t" so the and-form is reachable as a token.
        .replace(/&/g, " and ")
        // Everything else non-alphanumeric collapses to a space; dashes are
        // kept so already-dashed inputs (e.g. "Y-Combinator") survive.
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function generateSlugCandidates(name: string): string[] {
    const cleaned = normalizeForSlug(name);
    if (!cleaned) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (s: string) => {
        if (s.length === 0 || s.length > 60) return;
        if (seen.has(s)) return;
        seen.add(s);
        out.push(s);
    };

    add(cleaned.replace(/[\s-]+/g, ""));   // "blueorigin" — most common in practice
    add(cleaned.replace(/\s+/g, "-"));      // "blue-origin"
    add(cleaned.replace(/\s+/g, "_"));      // "blue_origin" (rare but cheap to try)

    const tokens = cleaned.split(/\s+/);
    if (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) {
        const stripped = tokens.slice(0, -1).join(" ");
        add(stripped.replace(/[\s-]+/g, ""));
        add(stripped.replace(/\s+/g, "-"));
    }

    return out.slice(0, MAX_SLUG_VARIANTS);
}

function resolveCacheKey(name: string): string {
    return `discovery:resolve:v1:${name.toLowerCase().trim()}`;
}

/**
 * Resolve a company name to a verified (kind, slug) on a public ATS by
 * probing greenhouse → lever → ashby with deterministically-generated slug
 * candidates. First hit wins; remaining probes are skipped (load-bearing —
 * the user explicitly asked for sequential-per-company so we don't waste
 * calls). `null` means we couldn't find any public board.
 *
 * Cached for 24h — repeated discover sessions across a day cost zero probes
 * for already-resolved names. Negative results are cached too: if Gemini
 * keeps suggesting a Workday-only company, we only pay the probe cost once.
 */
export async function resolveCompanyToBoard(name: string): Promise<ResolvedBoard | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return await cachedValue<ResolvedBoard | null>(
        resolveCacheKey(trimmed),
        RESOLVE_TTL_SECONDS,
        async () => {
            const variants = generateSlugCandidates(trimmed);
            for (const slug of variants) {
                for (const kind of KIND_ORDER) {
                    const result = await probeSlug(kind, slug);
                    if (result.ok) {
                        return { kind, slug, jobCount: result.jobCount ?? 0 };
                    }
                }
            }
            return null;
        },
    );
}

export const ProbableKindSchema = z.enum(["greenhouse", "lever", "ashby"]);
