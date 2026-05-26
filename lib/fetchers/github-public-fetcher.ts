// Slim GitHub public-API fetcher. The full metrics/star/language path was
// removed when the M9 portfolio-metrics surface was retired; only README
// ingestion remains, used as LLM grounding by bullet-assist and the resume
// rewrite prompt. No auth — public anonymous calls only; subject to the
// 60 req/h unauthed rate limit.

const GITHUB_API = "https://api.github.com";

// Cap stored README content at 16 KB to bound row size. Prompt builders slice
// further (2 KB excerpt) before sending to Gemini.
export const README_MAX_BYTES = 16 * 1024;

export type FetchResult<T> = { ok: true; readme: T } | { ok: false; error: string };

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Parse "github.com/owner/repo" out of a repo URL. Tolerates http(s) schemes,
 * trailing slashes, ".git" suffix, and "/tree/..." or "/blob/..." suffixes.
 * Returns null when the URL isn't a github.com repo URL (e.g. GitLab, raw
 * path strings without a host).
 */
export function parseGithubOwnerRepo(repoUrl: string | null | undefined): string | null {
    if (!repoUrl || typeof repoUrl !== "string") return null;
    const trimmed = repoUrl.trim();
    if (trimmed.length === 0) return null;
    try {
        const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
        if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
        const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
        if (parts.length < 2) return null;
        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/i, "");
        const candidate = `${owner}/${repo}`;
        return OWNER_REPO_RE.test(candidate) ? candidate : null;
    } catch {
        return null;
    }
}

/**
 * Fetch the README markdown for a public repo. Returns the body (truncated
 * at README_MAX_BYTES) on success, or an error string on failure. No throw —
 * the caller is the scheduler, and one bad repo shouldn't tank the batch.
 */
export async function fetchGithubReadme(ownerRepo: string): Promise<FetchResult<string>> {
    if (!OWNER_REPO_RE.test(ownerRepo)) {
        return { ok: false, error: `Invalid owner/repo: ${ownerRepo}` };
    }
    try {
        const res = await fetch(`${GITHUB_API}/repos/${ownerRepo}/readme`, {
            headers: {
                "accept": "application/vnd.github.raw",
                "user-agent": "mission-control",
            },
        });
        if (res.status === 404) {
            return { ok: false, error: "404 (no README on default branch)" };
        }
        if (!res.ok) {
            return { ok: false, error: `${res.status} ${res.statusText}` };
        }
        const body = await res.text();
        const truncated = body.length > README_MAX_BYTES
            ? body.slice(0, README_MAX_BYTES)
            : body;
        return { ok: true, readme: truncated };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
