/**
 * M9 Phase 1 scheduler job — refreshes GitHub metrics for all `portfolio=true`
 * projects with a `githubRepo` set. Runs daily (per implementation.md §M9).
 *
 * Public GitHub API only (Decision 5): rate limit is 60 req/h unauthenticated.
 * Three calls per project (repo + languages + commits), so 60/3 = up to 20
 * projects per hour — well above typical personal portfolio size.
 */
import { prisma } from "@/lib/prisma";
import { fetchGithubRepoMetrics, fetchGithubReadme } from "@/lib/fetchers/github-public-fetcher";

export interface GithubMetricsRunResult {
    processed: number;
    succeeded: number;
    failed: number;
    skippedRecent: number;
    readmesFetched: number;
}

// Story 46 — README cadence is independent from metrics. READMEs change
// much less often than star counts, and the API call is a 4th hit per
// project that would tighten the 60-req/h budget. Refresh once a week.
const README_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const STALE_AFTER_MS = 20 * 60 * 60 * 1000; // 20h — skip if refreshed within this window

export async function runGithubMetrics(): Promise<GithubMetricsRunResult> {
    const candidates = await prisma.project.findMany({
        where: {
            portfolio: true,
            githubRepo: { not: null },
        },
        select: { id: true, githubRepo: true, metricsUpdatedAt: true, readmeUpdatedAt: true },
    });

    let succeeded = 0;
    let failed = 0;
    let skippedRecent = 0;
    let readmesFetched = 0;
    const now = Date.now();

    for (const p of candidates) {
        const metricsStale = !p.metricsUpdatedAt || now - p.metricsUpdatedAt.getTime() >= STALE_AFTER_MS;
        const readmeStale = !p.readmeUpdatedAt || now - p.readmeUpdatedAt.getTime() >= README_STALE_AFTER_MS;

        if (!metricsStale && !readmeStale) {
            skippedRecent++;
            continue;
        }

        const repo = p.githubRepo!;
        const update: Record<string, unknown> = {};

        if (metricsStale) {
            const result = await fetchGithubRepoMetrics(repo);
            if (!result.ok) {
                console.warn(`[github-metrics] ${repo} failed: ${result.error}`);
                failed++;
                // Continue rather than `continue` — we may still be able to
                // refresh the README in this pass. README writes are cheaper
                // than the bottleneck (3-call metrics) so don't let a metrics
                // failure also lose us the README budget.
            } else {
                update.metrics = JSON.stringify(result.metrics);
                update.metricsUpdatedAt = new Date();
            }
        }

        if (readmeStale) {
            const readmeRes = await fetchGithubReadme(repo);
            if (!readmeRes.ok) {
                console.warn(`[github-metrics] readme for ${repo} failed: ${readmeRes.error}`);
                // README failure isn't a per-project failure — the project's
                // metrics may still have refreshed above. Don't bump failed++
                // unless we ALSO failed metrics.
            } else {
                update.readme = readmeRes.readme;
                update.readmeUpdatedAt = new Date();
                if (readmeRes.readme !== null) readmesFetched++;
            }
        }

        if (Object.keys(update).length === 0) {
            // Neither call produced an update; we already counted the metrics
            // failure if there was one. Move on.
            continue;
        }

        try {
            await prisma.project.update({
                where: { id: p.id },
                data: update,
            });
            // Count as succeeded if metrics refreshed, OR if the README
            // refreshed without metrics needing a touch this tick.
            if ('metrics' in update || !metricsStale) succeeded++;
        } catch (e) {
            console.warn(`[github-metrics] DB write failed for project ${p.id}:`, e);
            failed++;
        }
    }

    return { processed: candidates.length, succeeded, failed, skippedRecent, readmesFetched };
}
