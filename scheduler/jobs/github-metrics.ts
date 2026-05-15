/**
 * M9 Phase 1 scheduler job — refreshes GitHub metrics for all `portfolio=true`
 * projects with a `githubRepo` set. Runs daily (per implementation.md §M9).
 *
 * Public GitHub API only (Decision 5): rate limit is 60 req/h unauthenticated.
 * Three calls per project (repo + languages + commits), so 60/3 = up to 20
 * projects per hour — well above typical personal portfolio size.
 */
import { prisma } from "@/lib/prisma";
import { fetchGithubRepoMetrics } from "@/lib/fetchers/github-public-fetcher";

export interface GithubMetricsRunResult {
    processed: number;
    succeeded: number;
    failed: number;
    skippedRecent: number;
}

const STALE_AFTER_MS = 20 * 60 * 60 * 1000; // 20h — skip if refreshed within this window

export async function runGithubMetrics(): Promise<GithubMetricsRunResult> {
    const candidates = await prisma.project.findMany({
        where: {
            portfolio: true,
            githubRepo: { not: null },
        },
        select: { id: true, githubRepo: true, metricsUpdatedAt: true },
    });

    let succeeded = 0;
    let failed = 0;
    let skippedRecent = 0;
    const now = Date.now();

    for (const p of candidates) {
        if (p.metricsUpdatedAt && now - p.metricsUpdatedAt.getTime() < STALE_AFTER_MS) {
            skippedRecent++;
            continue;
        }
        const repo = p.githubRepo!;
        const result = await fetchGithubRepoMetrics(repo);
        if (!result.ok) {
            console.warn(`[github-metrics] ${repo} failed: ${result.error}`);
            failed++;
            continue;
        }
        try {
            await prisma.project.update({
                where: { id: p.id },
                data: {
                    metrics: JSON.stringify(result.metrics),
                    metricsUpdatedAt: new Date(),
                },
            });
            succeeded++;
        } catch (e) {
            console.warn(`[github-metrics] DB write failed for project ${p.id}:`, e);
            failed++;
        }
    }

    return { processed: candidates.length, succeeded, failed, skippedRecent };
}
