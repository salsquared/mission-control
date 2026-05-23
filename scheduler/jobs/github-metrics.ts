/**
 * M9 Phase 1 scheduler job — refreshes GitHub metrics for all `portfolio=true`
 * projects with a `githubRepo` set. Runs daily (per implementation.md §M9).
 *
 * Public GitHub API only (Decision 5): rate limit is 60 req/h unauthenticated.
 * Three calls per project (repo + languages + commits), so 60/3 = up to 20
 * projects per hour — well above typical personal portfolio size.
 */
import { prisma } from "@/lib/prisma";
import { fetchGithubRepoMetrics, fetchGithubReadme, type RepoMetrics } from "@/lib/fetchers/github-public-fetcher";
import { computeMetricDeltas } from "@/lib/profile/metric-deltas";
import { dispatchNotification } from "@/lib/notifications/dispatch";

export interface GithubMetricsRunResult {
    processed: number;
    succeeded: number;
    failed: number;
    skippedRecent: number;
    readmesFetched: number;
    deltasDispatched: number;
}

function parsePriorMetrics(raw: string | null): RepoMetrics | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<RepoMetrics> | null;
        if (!parsed || typeof parsed !== "object") return null;
        // Tolerant cast — the row is a JSON-stringified RepoMetrics from a
        // prior tick, but a hand-edited or legacy row might be sparse. The
        // delta function reads each field defensively, so a partial shape
        // is fine.
        return parsed as RepoMetrics;
    } catch {
        return null;
    }
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
        // Story 45: include the project's prior metrics + name + profile.userId
        // so the metric-delta detector can compare new vs. prior and the
        // notification dispatcher can target the owning user.
        select: {
            id: true,
            name: true,
            githubRepo: true,
            metrics: true,
            metricsUpdatedAt: true,
            readmeUpdatedAt: true,
            profile: { select: { userId: true } },
        },
    });

    let succeeded = 0;
    let failed = 0;
    let skippedRecent = 0;
    let readmesFetched = 0;
    let deltasDispatched = 0;
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
        let newMetrics: RepoMetrics | null = null;

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
                newMetrics = result.metrics;
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
            continue;
        }

        // Story 45 — compare new vs prior metrics and dispatch a
        // suggested-rewrite Notification per significant delta. Runs AFTER
        // the row update so a notification can never be sent for a state
        // that didn't actually persist. dedupKey ties each milestone to a
        // single dispatch; once "stars-threshold:100" fires for project X
        // it won't re-fire until the next milestone (250) is crossed.
        if (newMetrics) {
            const prevMetrics = parsePriorMetrics(p.metrics);
            const deltas = computeMetricDeltas(prevMetrics, newMetrics);
            for (const delta of deltas) {
                try {
                    const result = await dispatchNotification({
                        userId: p.profile.userId,
                        tier: "standard",
                        kind: "system",
                        title: `${p.name} — ${delta.summary}`,
                        body: `Consider revisiting the bullets for ${p.name} on your profile — the project's metrics meaningfully changed.`,
                        payload: {
                            projectId: p.id,
                            type: "portfolio-rewrite-suggestion",
                            deltaType: delta.type,
                            milestone: delta.milestone,
                        },
                        dedupKey: `portfolio-rewrite:${p.id}:${delta.type}:${delta.milestone}`,
                    });
                    if (result) deltasDispatched++;
                } catch (e) {
                    console.warn(`[github-metrics] delta dispatch failed for project ${p.id} (${delta.type}):`, e);
                }
            }
        }
    }

    return { processed: candidates.length, succeeded, failed, skippedRecent, readmesFetched, deltasDispatched };
}
