// Fetches READMEs from github.com for projects whose `repoUrl` parses to an
// owner/repo. Used purely as factual grounding for the bullet-assist and
// resume-rewrite LLM prompts — no user-facing surface (no notifications, no
// stars, no language stats). Replaced the M9 `github-metrics` job; metrics +
// portfolio toggle were retired with the UI cleanup on 2026-05-26.

import { prisma } from "@/lib/prisma";
import { fetchGithubReadme, parseGithubOwnerRepo } from "@/lib/fetchers/github-public-fetcher";

// Refresh each repo's README at most once per week — README content changes
// rarely, and the unauthed GitHub rate limit (60 req/h) is the binding cost
// constraint when a user has many GitHub-hosted projects.
const README_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReadmeBatchResult {
    processed: number;
    succeeded: number;
    failed: number;
    skippedRecent: number;
}

export async function runGithubReadmes(): Promise<ReadmeBatchResult> {
    const projects = await prisma.project.findMany({
        where: { repoUrl: { not: null } },
        select: { id: true, repoUrl: true, readmeUpdatedAt: true },
    });

    const result: ReadmeBatchResult = { processed: 0, succeeded: 0, failed: 0, skippedRecent: 0 };
    const cutoff = Date.now() - README_FRESHNESS_MS;

    for (const p of projects) {
        const ownerRepo = parseGithubOwnerRepo(p.repoUrl);
        if (!ownerRepo) continue;

        result.processed += 1;

        if (p.readmeUpdatedAt && p.readmeUpdatedAt.getTime() > cutoff) {
            result.skippedRecent += 1;
            continue;
        }

        const res = await fetchGithubReadme(ownerRepo);
        if (!res.ok) {
            console.warn(`[github-readmes] ${ownerRepo} failed: ${res.error}`);
            result.failed += 1;
            // Still bump readmeUpdatedAt so a perpetually-404 repo doesn't
            // re-fetch every tick. A 7d wait between attempts is fine.
            try {
                await prisma.project.update({
                    where: { id: p.id },
                    data: { readmeUpdatedAt: new Date() },
                });
            } catch (e) {
                console.warn(`[github-readmes] freshness write failed for ${p.id}:`, e);
            }
            continue;
        }

        try {
            await prisma.project.update({
                where: { id: p.id },
                data: { readme: res.readme, readmeUpdatedAt: new Date() },
            });
            result.succeeded += 1;
        } catch (e) {
            console.warn(`[github-readmes] DB write failed for ${p.id}:`, e);
            result.failed += 1;
        }
    }

    return result;
}
