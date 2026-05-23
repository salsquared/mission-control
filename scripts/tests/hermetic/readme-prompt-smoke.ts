// Story 46 hermetic smoke for the README-context branch of the rewrite
// prompt. Tests buildRewriteUserPrompt — a pure function over selections /
// posting / readmeCtx — so we never hit Gemini.
//
// Run with: npx tsx scripts/tests/hermetic/readme-prompt-smoke.ts

import {
    buildRewriteUserPrompt,
    PROJECT_README_PROMPT_LIMIT,
    type ProjectReadmeContext,
} from '@/lib/resumes/rewrite';
import type { BulletSelection } from '@/lib/resumes/select';
import type { ParsedPosting } from '@/lib/resumes/posting';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const posting: ParsedPosting = {
    title: 'Senior Engineer',
    company: 'Acme',
    location: null,
    seniority: 'senior',
    rawText: 'placeholder',
    sourceUrl: null,
    keywords: ['typescript', 'distributed'],
};

function mkSel(overrides: Partial<BulletSelection> & { bulletId: string }): BulletSelection {
    return {
        kind: 'project',
        sourceId: 'p1',
        sourceLabel: 'Project Alpha',
        originalText: 'Built a thing',
        score: 1,
        matchedTags: [],
        matchedKeywords: [],
        locked: false,
        ...overrides,
    };
}

// 1. No context → no README section in the prompt.
{
    const prompt = buildRewriteUserPrompt([mkSel({ bulletId: 'b1' })], posting, undefined);
    record('no-ctx: prompt has no README section header', !prompt.includes('Project READMEs'));
    record('no-ctx: prompt still has bullets section', prompt.includes('Bullets to rewrite'));
}

// 2. Empty context → no README section.
{
    const ctx: ProjectReadmeContext = { readmesBySourceId: {} };
    const prompt = buildRewriteUserPrompt([mkSel({ bulletId: 'b1' })], posting, ctx);
    record('empty-ctx: still no README section', !prompt.includes('Project READMEs'));
}

// 3. Project bullet with matching readme → README section appears with the label.
{
    const ctx: ProjectReadmeContext = {
        readmesBySourceId: { p1: '# Project Alpha\nA tool for X.' },
    };
    const prompt = buildRewriteUserPrompt([mkSel({ bulletId: 'b1' })], posting, ctx);
    record('with-readme: section header present', prompt.includes('Project READMEs'));
    record('with-readme: project label appears', prompt.includes('### Project README — Project Alpha'));
    record('with-readme: readme content embedded', prompt.includes('A tool for X.'));
}

// 4. Multiple bullets for same project → README appears once, not per bullet.
{
    const ctx: ProjectReadmeContext = {
        readmesBySourceId: { p1: 'README ALPHA' },
    };
    const prompt = buildRewriteUserPrompt(
        [mkSel({ bulletId: 'b1' }), mkSel({ bulletId: 'b2' }), mkSel({ bulletId: 'b3' })],
        posting,
        ctx,
    );
    const occurrences = prompt.split('README ALPHA').length - 1;
    record('dedup: readme text appears exactly once', occurrences === 1, `got ${occurrences}`);
}

// 5. WorkRole bullets do NOT pull README context (only project bullets do).
{
    const ctx: ProjectReadmeContext = {
        readmesBySourceId: { wr1: 'should not appear', p1: 'project readme' },
    };
    const prompt = buildRewriteUserPrompt(
        [
            mkSel({ bulletId: 'b1', kind: 'workRole', sourceId: 'wr1', sourceLabel: 'Engineer at Acme' }),
            mkSel({ bulletId: 'b2', kind: 'project', sourceId: 'p1' }),
        ],
        posting,
        ctx,
    );
    record('non-project: workRole readme not included', !prompt.includes('should not appear'));
    record('non-project: project readme still included', prompt.includes('project readme'));
}

// 6. README in ctx for a sourceId not in selection → not included.
{
    const ctx: ProjectReadmeContext = {
        readmesBySourceId: { p1: 'in selection', p2: 'NOT in selection' },
    };
    const prompt = buildRewriteUserPrompt([mkSel({ bulletId: 'b1', sourceId: 'p1' })], posting, ctx);
    record('selective: only in-selection readmes appear', prompt.includes('in selection') && !prompt.includes('NOT in selection'));
}

// 7. Long README → truncated at PROJECT_README_PROMPT_LIMIT + "…(truncated)" marker.
{
    const long = 'X'.repeat(PROJECT_README_PROMPT_LIMIT + 500);
    const ctx: ProjectReadmeContext = { readmesBySourceId: { p1: long } };
    const prompt = buildRewriteUserPrompt([mkSel({ bulletId: 'b1' })], posting, ctx);
    record('truncate: marker appears', prompt.includes('…(truncated)'));
    // The truncated portion in the prompt is exactly PROJECT_README_PROMPT_LIMIT
    // chars of 'X' followed by the marker.
    const xRun = prompt.match(/X+/);
    record(
        'truncate: kept exactly the configured chars',
        xRun !== null && xRun[0].length === PROJECT_README_PROMPT_LIMIT,
        xRun ? `got ${xRun[0].length}` : 'no X-run found',
    );
}

// 8. Empty-string readme is treated as "no readme" — not rendered.
{
    const ctx: ProjectReadmeContext = { readmesBySourceId: { p1: '' } };
    const prompt = buildRewriteUserPrompt([mkSel({ bulletId: 'b1' })], posting, ctx);
    record('empty readme: no section emitted', !prompt.includes('Project READMEs'));
}

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
