/**
 * Public GitHub metrics fetcher (M9 Phase 1).
 *
 * Per Decision 5 in user-stories.md — public API only, no OAuth.
 * Public read endpoints are rate-limited at 60 requests/hour unauthenticated,
 * which is plenty for personal portfolio-scale use (3-10 projects, daily tick).
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import { assertExternalHttpUrl, UnsafeURLError } from "@/lib/security/url-guard";

export interface RepoMetrics {
    stars: number;
    primaryLanguage: string | null;
    languageMix: Record<string, number>; // language → byte count
    lastCommitAt: string | null;          // ISO
    commitsTotal: number | null;
    ageDays: number | null;
    fetchedAt: string;                    // ISO
}

export type GithubFetcherResult =
    | { ok: true; metrics: RepoMetrics }
    | { ok: false; error: string };

const FETCH_TIMEOUT_MS = 8_000;

const RepoSchema = z.object({
    stargazers_count: z.number().int(),
    language: z.string().nullable().optional(),
    created_at: z.string().optional(),
    pushed_at: z.string().nullable().optional(),
}).passthrough();

const LanguagesSchema = z.record(z.string(), z.number().int());

async function ghFetch(url: string, signal: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
    try {
        assertExternalHttpUrl(url);
    } catch (e) {
        if (e instanceof UnsafeURLError) return { ok: false, error: e.message };
        throw e;
    }
    let res: Response;
    try {
        res = await fetch(url, {
            headers: {
                "User-Agent": "mission-control/1.0 (+https://mc.local; personal project)",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            signal,
        });
    } catch (e) {
        return { ok: false, error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) {
        const rate = res.headers.get("x-ratelimit-remaining");
        return { ok: false, error: `HTTP ${res.status} ${res.statusText}${rate !== null ? ` (rate remaining ${rate})` : ""}` };
    }
    try {
        return { ok: true, json: await res.json() };
    } catch (e) {
        return { ok: false, error: `Bad JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
}

/**
 * Fetches public metrics for `<owner>/<repo>` via the GitHub REST API.
 * Three calls: repo info, languages, last commit.
 */
export async function fetchGithubRepoMetrics(ownerRepo: string): Promise<GithubFetcherResult> {
    const match = ownerRepo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) return { ok: false, error: `Invalid owner/repo: ${ownerRepo}` };
    const [, owner, repo] = match;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const repoRes = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`, controller.signal);
        if (!repoRes.ok) return { ok: false, error: repoRes.error };
        const parsedRepo = RepoSchema.safeParse(repoRes.json);
        if (!parsedRepo.success) return { ok: false, error: `Unexpected repo shape` };

        const langRes = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/languages`, controller.signal);
        if (!langRes.ok) return { ok: false, error: langRes.error };
        const parsedLangs = LanguagesSchema.safeParse(langRes.json);
        const languageMix = parsedLangs.success ? parsedLangs.data : {};

        // Commit count: GitHub doesn't expose total commits directly. We get the
        // last commit + an approximation via the link header on the commits
        // endpoint with per_page=1 (the `last` page number ≈ total commits).
        const commitsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, {
            headers: {
                "User-Agent": "mission-control/1.0",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: controller.signal,
        }).catch(() => null);
        let lastCommitAt: string | null = null;
        let commitsTotal: number | null = null;
        if (commitsRes && commitsRes.ok) {
            const linkHeader = commitsRes.headers.get("link") ?? "";
            const lastPageMatch = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
            if (lastPageMatch) commitsTotal = Number(lastPageMatch[1]);
            try {
                const arr = await commitsRes.json() as Array<{ commit?: { author?: { date?: string } } }>;
                lastCommitAt = arr?.[0]?.commit?.author?.date ?? null;
            } catch { /* ignore */ }
        }

        const createdAt = parsedRepo.data.created_at;
        const ageDays = createdAt
            ? Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000))
            : null;

        return {
            ok: true,
            metrics: {
                stars: parsedRepo.data.stargazers_count,
                primaryLanguage: parsedRepo.data.language ?? null,
                languageMix,
                lastCommitAt: lastCommitAt ?? parsedRepo.data.pushed_at ?? null,
                commitsTotal,
                ageDays,
                fetchedAt: new Date().toISOString(),
            },
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

// Story S9.5 — README ingestion. Separate from fetchGithubRepoMetrics so the
// hot path stays at 3 API calls; README is a 4th call only for repos we
// actually want to surface on resumes. Returns the decoded markdown, or
// null when the repo has no README (404) / the response was malformed.
// Errors are returned, not thrown.

const ReadmeResponseSchema = z.object({
    content: z.string(),     // base64-encoded
    encoding: z.string(),    // "base64" in practice
}).passthrough();

export type GithubReadmeResult =
    | { ok: true; readme: string | null }
    | { ok: false; error: string };

// 16 KB cap. A representative repo README (Iris, Pulsar, this app) is
// 2-8 KB; anything > 16 KB is almost certainly bundling a changelog or
// auto-generated API docs that doesn't belong in a resume-rewrite prompt.
const README_MAX_BYTES = 16_384;

export async function fetchGithubReadme(ownerRepo: string): Promise<GithubReadmeResult> {
    const match = ownerRepo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) return { ok: false, error: `Invalid owner/repo: ${ownerRepo}` };
    const [, owner, repo] = match;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const url = `https://api.github.com/repos/${owner}/${repo}/readme`;
        try {
            assertExternalHttpUrl(url);
        } catch (e) {
            if (e instanceof UnsafeURLError) return { ok: false, error: e.message };
            throw e;
        }
        let res: Response;
        try {
            res = await fetch(url, {
                headers: {
                    "User-Agent": "mission-control/1.0 (+https://mc.local; personal project)",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                signal: controller.signal,
            });
        } catch (e) {
            return { ok: false, error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (res.status === 404) return { ok: true, readme: null };
        if (!res.ok) {
            const rate = res.headers.get("x-ratelimit-remaining");
            return { ok: false, error: `HTTP ${res.status}${rate !== null ? ` (rate remaining ${rate})` : ""}` };
        }
        let json: unknown;
        try { json = await res.json(); } catch (e) { return { ok: false, error: `Bad JSON: ${e instanceof Error ? e.message : String(e)}` }; }
        const parsed = ReadmeResponseSchema.safeParse(json);
        if (!parsed.success) return { ok: false, error: "Unexpected README payload shape" };
        if (parsed.data.encoding !== "base64") {
            return { ok: false, error: `Unexpected README encoding: ${parsed.data.encoding}` };
        }
        let decoded: string;
        try {
            decoded = Buffer.from(parsed.data.content, "base64").toString("utf8");
        } catch (e) {
            return { ok: false, error: `Base64 decode failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        // Truncate at boundary, not mid-codepoint. Buffer.byteLength gives the
        // UTF-8 byte count regardless of the source string's encoding.
        if (Buffer.byteLength(decoded, "utf8") > README_MAX_BYTES) {
            // Use Buffer slicing then re-decode so we don't split a multi-byte
            // char. The trailing slice is dropped — losing 1-3 bytes of tail
            // is a non-issue for resume-prompt purposes.
            const buf = Buffer.from(decoded, "utf8").subarray(0, README_MAX_BYTES);
            decoded = buf.toString("utf8");
        }
        return { ok: true, readme: decoded };
    } finally {
        clearTimeout(timeoutId);
    }
}
