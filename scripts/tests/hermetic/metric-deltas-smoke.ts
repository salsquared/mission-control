// Story S9.4 hermetic smoke for computeMetricDeltas — pure function over two
// RepoMetrics snapshots. No DB, no GitHub.
//
// Run with: npx tsx scripts/tests/hermetic/metric-deltas-smoke.ts

import { computeMetricDeltas } from '@/lib/profile/metric-deltas';
import type { RepoMetrics } from '@/lib/fetchers/github-public-fetcher';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function mk(over: Partial<RepoMetrics>): RepoMetrics {
    return {
        stars: 0,
        primaryLanguage: 'TypeScript',
        languageMix: { TypeScript: 10_000 },
        lastCommitAt: '2026-05-01T00:00:00Z',
        commitsTotal: 0,
        ageDays: 100,
        fetchedAt: '2026-05-01T00:00:00Z',
        ...over,
    };
}

// 1. No prior → no deltas (first ingest is silent).
{
    const out = computeMetricDeltas(null, mk({ stars: 200 }));
    record('first-ingest: no deltas', out.length === 0);
}

// 2. No change → no deltas.
{
    const both = mk({ stars: 42, commitsTotal: 100 });
    const out = computeMetricDeltas(both, both);
    record('identical: no deltas', out.length === 0);
}

// 3. Star threshold crossing (4 → 12 crosses both 5 and 10; only the highest fires).
{
    const out = computeMetricDeltas(mk({ stars: 4 }), mk({ stars: 12 }));
    const ev = out.find(d => d.type === 'star-threshold');
    record('stars 4→12: fires star-threshold', ev !== undefined);
    record('stars 4→12: milestone is 10 (highest crossed)', ev?.milestone === '10');
}

// 4. Crossing exactly the milestone fires.
{
    const out = computeMetricDeltas(mk({ stars: 99 }), mk({ stars: 100 }));
    record('stars 99→100: fires at 100', out.some(d => d.milestone === '100'));
}

// 5. Below first milestone → no fire.
{
    const out = computeMetricDeltas(mk({ stars: 1 }), mk({ stars: 4 }));
    record('stars below 5: no star-threshold delta', out.every(d => d.type !== 'star-threshold'));
}

// 6. Star count dropping does not fire.
{
    const out = computeMetricDeltas(mk({ stars: 200 }), mk({ stars: 150 }));
    record('stars dropping: no star-threshold', out.every(d => d.type !== 'star-threshold'));
}

// 7. Primary language flip.
{
    const out = computeMetricDeltas(
        mk({ primaryLanguage: 'TypeScript' }),
        mk({ primaryLanguage: 'Go', languageMix: { Go: 8_000, TypeScript: 2_000 } }),
    );
    const ev = out.find(d => d.type === 'primary-language');
    record('primary flip: fires', ev !== undefined);
    record('primary flip: milestone format', ev?.milestone === 'TypeScript→Go');
}

// 8. New language (non-primary) appearing with ≥5% share.
{
    const out = computeMetricDeltas(
        mk({ languageMix: { TypeScript: 10_000 } }),
        mk({ languageMix: { TypeScript: 9_000, Rust: 1_000 } }),  // Rust = 10%
    );
    record('new lang ≥5%: fires', out.some(d => d.type === 'new-language' && d.milestone === 'Rust'));
}

// 9. New language with < 5% share is filtered out as noise.
{
    const out = computeMetricDeltas(
        mk({ languageMix: { TypeScript: 100_000 } }),
        mk({ languageMix: { TypeScript: 100_000, Shell: 100 } }),  // Shell ≈ 0.1%
    );
    record('new lang <5%: filtered', out.every(d => d.type !== 'new-language'));
}

// 10. Primary-flip suppresses redundant new-language delta for the new primary.
{
    const out = computeMetricDeltas(
        mk({ primaryLanguage: 'TypeScript', languageMix: { TypeScript: 10_000 } }),
        mk({ primaryLanguage: 'Go', languageMix: { Go: 10_000, TypeScript: 5_000 } }),
    );
    const newLang = out.filter(d => d.type === 'new-language');
    record('primary-flip dedup: no new-language for the new primary', newLang.every(d => d.milestone !== 'Go'));
}

// 11. Commit jump — relative ≥25% AND absolute ≥10.
{
    const out = computeMetricDeltas(mk({ commitsTotal: 100 }), mk({ commitsTotal: 150 }));
    record('commit jump 100→150: fires', out.some(d => d.type === 'commit-jump' && d.milestone === '150'));
}

// 12. Commit jump rejected when absolute delta < 10.
{
    const out = computeMetricDeltas(mk({ commitsTotal: 20 }), mk({ commitsTotal: 28 }));
    record('commit jump 20→28: too small (abs)', out.every(d => d.type !== 'commit-jump'));
}

// 13. Commit jump rejected when relative growth < 25%.
{
    const out = computeMetricDeltas(mk({ commitsTotal: 1_000 }), mk({ commitsTotal: 1_100 }));
    record('commit jump 1000→1100: too small (rel)', out.every(d => d.type !== 'commit-jump'));
}

// 14. Multiple deltas in one tick.
{
    const out = computeMetricDeltas(
        mk({ stars: 4, commitsTotal: 50, languageMix: { TypeScript: 10_000 } }),
        mk({ stars: 26, commitsTotal: 200, languageMix: { TypeScript: 10_000, Go: 5_000 } }),
    );
    record('multi-delta: star + commit + new-lang all fire',
        out.some(d => d.type === 'star-threshold')
        && out.some(d => d.type === 'commit-jump')
        && out.some(d => d.type === 'new-language'));
}

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
