// Story S9.4 — pure-function delta detection between two RepoMetrics
// snapshots. The scheduler reads prior metrics out of Project.metrics,
// fetches new ones, calls computeMetricDeltas, and dispatches one
// notification per event. Tested without hitting GitHub or the DB.

import type { RepoMetrics } from "@/lib/fetchers/github-public-fetcher";

export type MetricDeltaType =
    | "star-threshold"        // crossed an absolute star milestone (5/10/25/...)
    | "primary-language"      // primaryLanguage changed
    | "new-language"          // a language appeared in languageMix that wasn't there before
    | "commit-jump";          // commitsTotal grew by ≥ 25% AND ≥ 10 commits

export interface MetricDelta {
    type: MetricDeltaType;
    // Short, human-readable string the dispatcher renders as the notification
    // body. Self-contained so the caller doesn't have to reach for repo info.
    summary: string;
    // For dedupKey composition — uniquely identifies this delta event so we
    // never re-fire the same milestone. Composed as
    //   portfolio-rewrite:${projectId}:${type}:${milestone}
    // upstream.
    milestone: string;
}

// Star milestones come from real-world resume-relevance signal. Crossing 5
// stars is "someone else found this useful"; 100+ is a real shoutout; 1k+
// is a portfolio centerpiece.
const STAR_MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

function highestMilestoneUnder(stars: number): number {
    let last = 0;
    for (const m of STAR_MILESTONES) {
        if (stars >= m) last = m;
        else break;
    }
    return last;
}

export function computeMetricDeltas(
    prev: RepoMetrics | null | undefined,
    next: RepoMetrics,
): MetricDelta[] {
    // First-fetch (no prior metrics): no deltas — every signal would
    // otherwise fire on the initial ingest. The point of these is to
    // surface meaningful CHANGES.
    if (!prev) return [];

    const out: MetricDelta[] = [];

    // ─── Star threshold crossings ───────────────────────────────────────
    const prevTier = highestMilestoneUnder(prev.stars ?? 0);
    const nextTier = highestMilestoneUnder(next.stars ?? 0);
    if (nextTier > prevTier && nextTier > 0) {
        out.push({
            type: "star-threshold",
            milestone: String(nextTier),
            summary: `crossed ${nextTier.toLocaleString()} stars on GitHub`,
        });
    }

    // ─── Primary language flipped ──────────────────────────────────────
    if (prev.primaryLanguage && next.primaryLanguage && prev.primaryLanguage !== next.primaryLanguage) {
        out.push({
            type: "primary-language",
            milestone: `${prev.primaryLanguage}→${next.primaryLanguage}`,
            summary: `primary language shifted ${prev.primaryLanguage} → ${next.primaryLanguage}`,
        });
    }

    // ─── New language added to the mix ─────────────────────────────────
    // Only counts languages with non-trivial byte share (≥ 5% of the new
    // total) so a one-off shell script doesn't trigger a notification.
    const prevLangs = new Set(Object.keys(prev.languageMix ?? {}));
    const totalBytes = Object.values(next.languageMix ?? {}).reduce((a, b) => a + b, 0);
    if (totalBytes > 0) {
        for (const [lang, bytes] of Object.entries(next.languageMix ?? {})) {
            if (prevLangs.has(lang)) continue;
            if (bytes / totalBytes < 0.05) continue;  // < 5% share — noise
            // Skip the primary-language flip case (already covered above).
            if (lang === next.primaryLanguage && prev.primaryLanguage !== next.primaryLanguage) continue;
            out.push({
                type: "new-language",
                milestone: lang,
                summary: `added ${lang} to the project (now ${Math.round((bytes / totalBytes) * 100)}% of the codebase)`,
            });
        }
    }

    // ─── Commit count jump ─────────────────────────────────────────────
    // Requires both a 25%+ relative jump AND a 10+ absolute jump so tiny
    // repos don't churn ("5 → 10 commits" is interesting, but firing once
    // per linear-history sprint isn't).
    const prevCommits = prev.commitsTotal ?? 0;
    const nextCommits = next.commitsTotal ?? 0;
    if (
        nextCommits > prevCommits + 10
        && (prevCommits === 0 || (nextCommits - prevCommits) / prevCommits >= 0.25)
    ) {
        const delta = nextCommits - prevCommits;
        out.push({
            type: "commit-jump",
            // Use the absolute commit count as the milestone so each jump
            // gets its own dedupKey — a +47-then-+53 sequence on different
            // ticks fires two notifications (one at total 47, one at 100),
            // rather than the second silently dedup-suppressed.
            milestone: String(nextCommits),
            summary: `+${delta.toLocaleString()} commits since last snapshot`,
        });
    }

    return out;
}
