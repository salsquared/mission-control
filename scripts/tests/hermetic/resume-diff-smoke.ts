// Story S10.2 hermetic smoke for computeResumeDiff — pure function, no DB.
// Run with: npx tsx scripts/tests/hermetic/resume-diff-smoke.ts

import { computeResumeDiff, type ResumeForDiff, type StoredSelection } from '@/lib/resumes/diff';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function mkSelection(overrides: Partial<StoredSelection>): StoredSelection {
    return {
        kind: 'workRole',
        sourceId: 'wr1',
        sourceLabel: 'Engineer @ Acme',
        bulletId: 'b1',
        originalText: 'Shipped X',
        rewrittenText: 'Shipped X',
        score: 1,
        matchedTags: [],
        matchedKeywords: [],
        locked: false,
        ...overrides,
    };
}

function mkResume(overrides: Partial<ResumeForDiff>): ResumeForDiff {
    return {
        id: 'r1',
        createdAt: '2026-05-01T00:00:00Z',
        applicationId: null,
        company: 'Acme',
        title: 'SWE',
        parsedKeywords: [],
        skillsGap: [],
        selections: [],
        ...overrides,
    };
}

// 1. Identical resumes — zero deltas in every bucket.
{
    const sel = mkSelection({ bulletId: 'b1', rewrittenText: 'Same rewrite' });
    const a = mkResume({ id: 'a1', parsedKeywords: ['go', 'kubernetes'], skillsGap: ['rust'], selections: [sel] });
    const b = mkResume({ id: 'b1', parsedKeywords: ['go', 'kubernetes'], skillsGap: ['rust'], selections: [sel] });
    const d = computeResumeDiff(a, b);
    record('identical: zero keyword deltas', d.keywords.onlyA.length === 0 && d.keywords.onlyB.length === 0);
    record('identical: both-list contains all', d.keywords.both.length === 2);
    record('identical: zero skillsGap deltas', d.skillsGap.onlyA.length === 0 && d.skillsGap.onlyB.length === 0);
    record('identical: zero selection deltas', d.selections.onlyA.length === 0 && d.selections.onlyB.length === 0);
    record('identical: shared has 1 entry, rewriteChanged=false', d.selections.shared.length === 1 && d.selections.shared[0].rewriteChanged === false);
    record('identical: summary all-zero',
        d.summary.keywordsChanged === 0 && d.summary.selectionsChanged === 0 && d.summary.rewritesChanged === 0);
}

// 2. Different keyword sets — onlyA / onlyB / both populate correctly, order preserved from A.
{
    const a = mkResume({ id: 'a2', parsedKeywords: ['go', 'kubernetes', 'docker'] });
    const b = mkResume({ id: 'b2', parsedKeywords: ['kubernetes', 'rust', 'docker'] });
    const d = computeResumeDiff(a, b);
    record('keywords: onlyA preserves A-order', JSON.stringify(d.keywords.onlyA) === JSON.stringify(['go']));
    record('keywords: onlyB preserves B-order minus shared', JSON.stringify(d.keywords.onlyB) === JSON.stringify(['rust']));
    record('keywords: both in A-order', JSON.stringify(d.keywords.both) === JSON.stringify(['kubernetes', 'docker']));
    record('summary.keywordsChanged = onlyA + onlyB', d.summary.keywordsChanged === 2);
}

// 3. Bullet selected in A but not B — and vice versa.
{
    const a = mkResume({
        id: 'a3',
        selections: [
            mkSelection({ bulletId: 'b1', sourceLabel: 'Acme', rewrittenText: 'shared' }),
            mkSelection({ bulletId: 'b2', sourceLabel: 'A-only', rewrittenText: 'A only' }),
        ],
    });
    const b = mkResume({
        id: 'b3',
        selections: [
            mkSelection({ bulletId: 'b1', sourceLabel: 'Acme', rewrittenText: 'shared' }),
            mkSelection({ bulletId: 'b3', sourceLabel: 'B-only', rewrittenText: 'B only' }),
        ],
    });
    const d = computeResumeDiff(a, b);
    record('selections: onlyA has b2', d.selections.onlyA.length === 1 && d.selections.onlyA[0].bulletId === 'b2');
    record('selections: onlyB has b3', d.selections.onlyB.length === 1 && d.selections.onlyB[0].bulletId === 'b3');
    record('selections: shared has b1', d.selections.shared.length === 1 && d.selections.shared[0].bulletId === 'b1');
    record('selections: shared.b1 rewriteChanged=false', d.selections.shared[0].rewriteChanged === false);
    record('summary.selectionsChanged = 2', d.summary.selectionsChanged === 2);
    record('summary.rewritesChanged = 0', d.summary.rewritesChanged === 0);
}

// 4. Same bullet, different rewrittenText → rewriteChanged + scoreDelta.
{
    const a = mkResume({
        id: 'a4',
        selections: [mkSelection({ bulletId: 'b1', rewrittenText: 'Built TS API', score: 5 })],
    });
    const b = mkResume({
        id: 'b4',
        selections: [mkSelection({ bulletId: 'b1', rewrittenText: 'Built a TypeScript API', score: 7 })],
    });
    const d = computeResumeDiff(a, b);
    record('rewrite-changed: shared.rewriteChanged=true', d.selections.shared[0].rewriteChanged === true);
    record('rewrite-changed: scoreDelta=+2', d.selections.shared[0].scoreDelta === 2);
    record('rewrite-changed: summary.rewritesChanged = 1', d.summary.rewritesChanged === 1);
    record('rewrite-changed: summary.selectionsChanged = 0', d.summary.selectionsChanged === 0);
}

// 5. matchedKeywords + matchedTags per-bullet deltas.
{
    const a = mkResume({
        id: 'a5',
        selections: [mkSelection({ bulletId: 'b1', matchedKeywords: ['go', 'docker'], matchedTags: ['backend'] })],
    });
    const b = mkResume({
        id: 'b5',
        selections: [mkSelection({ bulletId: 'b1', matchedKeywords: ['docker', 'kubernetes'], matchedTags: ['backend', 'devops'] })],
    });
    const d = computeResumeDiff(a, b);
    const shared = d.selections.shared[0];
    record('per-bullet keywordsOnlyA = [go]', JSON.stringify(shared.keywordsOnlyA) === JSON.stringify(['go']));
    record('per-bullet keywordsOnlyB = [kubernetes]', JSON.stringify(shared.keywordsOnlyB) === JSON.stringify(['kubernetes']));
    record('per-bullet tagsOnlyA empty', shared.tagsOnlyA.length === 0);
    record('per-bullet tagsOnlyB = [devops]', JSON.stringify(shared.tagsOnlyB) === JSON.stringify(['devops']));
}

// 6. Skills-gap deltas (story S8.8 column).
{
    const a = mkResume({ id: 'a6', skillsGap: ['rust', 'k8s'] });
    const b = mkResume({ id: 'b6', skillsGap: ['k8s', 'erlang'] });
    const d = computeResumeDiff(a, b);
    record('skillsGap.onlyA = [rust]', JSON.stringify(d.skillsGap.onlyA) === JSON.stringify(['rust']));
    record('skillsGap.onlyB = [erlang]', JSON.stringify(d.skillsGap.onlyB) === JSON.stringify(['erlang']));
    record('skillsGap.both = [k8s]', JSON.stringify(d.skillsGap.both) === JSON.stringify(['k8s']));
}

// 7. A.id and B.id propagate to the diff.
{
    const a = mkResume({ id: 'aaa', company: 'Foo', title: 'Eng' });
    const b = mkResume({ id: 'bbb', company: 'Bar', title: 'Lead' });
    const d = computeResumeDiff(a, b);
    record('diff carries a.id', d.a.id === 'aaa');
    record('diff carries b.id', d.b.id === 'bbb');
    record('diff carries a.company', d.a.company === 'Foo');
    record('diff carries b.title', d.b.title === 'Lead');
}

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
