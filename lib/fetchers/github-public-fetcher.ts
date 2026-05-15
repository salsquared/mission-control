/**
 * Public GitHub metrics fetcher (M9 Phase 1).
 *
 * Per Decision 5 in user-stories-applications.md — public API only, no OAuth.
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
