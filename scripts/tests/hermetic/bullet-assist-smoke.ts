// Hermetic smoke for the pure prompt-builder side of M7.6 bullet-assist.
// Exercises buildBulletAssistPrompt + its sub-renderers with a matrix of
// inputs covering section ordering, byte caps, mode-specific blocks, and the
// 8 KB total user-prompt ceiling. No DB, no LLM call — the impure
// callBulletAssist surface is tested manually in dev (per docs/implementation.md
// §M7.6.11) because mocking chatJSON would require a test-time injection
// seam the codebase doesn't otherwise have.
//
// Run: npx tsx scripts/tests/hermetic/bullet-assist-smoke.ts

import type { ResumeUpload } from '@prisma/client';
import {
    buildBulletAssistPrompt,
    renderArchiveSpans,
    renderSiblingBullets,
    renderSpine,
    type AssistParent,
    type SiblingInput,
} from '@/lib/profile/bullet-assist';
import { findArchiveSpansFor, type ArchiveSpan } from '@/lib/profile/upload-archive';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string): void {
    steps.push({ name, ok, detail });
    const tag = ok ? 'PASS' : 'FAIL';
    console.info(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

function makeWorkRoleParent(overrides: Partial<AssistParent> = {}): AssistParent {
    return {
        kind: 'work-role',
        id: 'wr_1',
        company: 'Acme Corp',
        title: 'Software Engineer',
        location: 'Remote',
        startDate: '2022-01-01',
        endDate: '2024-06-30',
        ...overrides,
    };
}
function makeProjectParent(overrides: Partial<AssistParent> = {}): AssistParent {
    return {
        kind: 'project',
        id: 'p_1',
        name: 'Pulsar',
        description: 'Financial ingestion engine',
        repoUrl: 'https://github.com/salsquared/pulsar',
        liveUrl: null,
        ...overrides,
    };
}
function makeEducationParent(overrides: Partial<AssistParent> = {}): AssistParent {
    return {
        kind: 'education',
        id: 'e_1',
        institution: 'CSULB',
        degree: 'B.S.',
        field: 'Computer Science',
        startDate: '2020-09-01',
        endDate: '2024-05-15',
        ...overrides,
    };
}
function makeSpan(overrides: Partial<ArchiveSpan> = {}): ArchiveSpan {
    return {
        uploadId: 'u_1',
        uploadedAt: new Date('2024-01-15T00:00:00Z'),
        filename: 'resume-2024.pdf',
        span: 'During my time at Acme Corp I shipped a TypeScript microservice that handled 5k RPS at p99 sub-50ms.',
        ...overrides,
    };
}

async function main(): Promise<void> {
    // ─── renderSpine ───────────────────────────────────────────────────────
    {
        const out = renderSpine(makeWorkRoleParent());
        record(
            'renderSpine: work-role includes Company / Title / Location / dates',
            out.includes('Acme Corp') &&
                out.includes('Software Engineer') &&
                out.includes('Remote') &&
                out.includes('2022-01-01') &&
                out.includes('2024-06-30'),
        );
    }
    {
        const out = renderSpine(makeProjectParent());
        record(
            'renderSpine: project includes Name / Description / Repo',
            out.includes('Pulsar') && out.includes('Financial ingestion engine') && out.includes('github.com/salsquared/pulsar'),
        );
    }
    {
        const out = renderSpine(makeEducationParent());
        record(
            'renderSpine: education includes Institution / Degree / Field',
            out.includes('CSULB') && out.includes('B.S.') && out.includes('Computer Science'),
        );
    }
    {
        const sparse = renderSpine({ kind: 'work-role', id: 'wr_x', company: null, title: '', location: undefined });
        record(
            'renderSpine: skips null/empty/undefined fields',
            !sparse.includes('Company:') && !sparse.includes('Title:') && !sparse.includes('Location:'),
            sparse.replace(/\n/g, ' | '),
        );
    }

    // ─── renderSiblingBullets ──────────────────────────────────────────────
    {
        const out = renderSiblingBullets([], 1_536);
        record('renderSiblingBullets: empty array → empty string', out === '');
    }
    {
        const tiny: SiblingInput[] = [
            { text: 'Built X', tags: ['typescript'] },
            { text: 'Shipped Y', tags: ['go'] },
        ];
        const out = renderSiblingBullets(tiny, 1_536);
        record(
            'renderSiblingBullets: under cap → all entries rendered',
            out.includes('Built X') && out.includes('Shipped Y') && utf8Bytes(out) <= 1_536,
        );
    }
    {
        // 30 entries × ~80 bytes each = ~2.4 KB raw. With a 256-byte cap we
        // must drop most of them and still stay under cap.
        const many: SiblingInput[] = Array.from({ length: 30 }, (_, i) => ({
            text: `Bullet text ${i} — moderately long content meant to push bytes`,
            tags: [],
        }));
        const out = renderSiblingBullets(many, 256);
        record(
            'renderSiblingBullets: over cap → trims trailing entries; stays under cap',
            out !== '' && utf8Bytes(out) <= 256,
            `bytes=${utf8Bytes(out)}`,
        );
    }
    {
        // Even one entry is bigger than the cap → return empty.
        const big: SiblingInput[] = [{ text: 'a'.repeat(2_000), tags: [] }];
        const out = renderSiblingBullets(big, 100);
        record('renderSiblingBullets: cap smaller than smallest entry → empty string', out === '');
    }

    // ─── renderArchiveSpans ────────────────────────────────────────────────
    {
        const out = renderArchiveSpans([], 1_536);
        record('renderArchiveSpans: empty → empty string', out === '');
    }
    {
        const spans = [
            makeSpan({ uploadId: 'u_a', uploadedAt: new Date('2024-01-01T00:00:00Z') }),
            makeSpan({ uploadId: 'u_b', uploadedAt: new Date('2023-06-01T00:00:00Z'), filename: 'resume-2023.pdf' }),
        ];
        const out = renderArchiveSpans(spans, 1_536);
        record(
            'renderArchiveSpans: renders filename + ISO date header per span',
            out.includes('resume-2024.pdf') &&
                out.includes('resume-2023.pdf') &&
                /2024-01-01/.test(out) &&
                /2023-06-01/.test(out) &&
                utf8Bytes(out) <= 1_536,
        );
    }
    {
        // Three spans where each individually fits, but together overflow.
        const spans = Array.from({ length: 3 }, (_, i) =>
            makeSpan({
                uploadId: `u_${i}`,
                uploadedAt: new Date(Date.UTC(2024, i, 1)),
                filename: `r-${i}.pdf`,
                span: 'x'.repeat(800),
            }),
        );
        const out = renderArchiveSpans(spans, 1_536);
        record(
            'renderArchiveSpans: trims trailing spans to stay under cap',
            utf8Bytes(out) <= 1_536,
            `bytes=${utf8Bytes(out)}`,
        );
    }

    // ─── buildBulletAssistPrompt — fill mode ───────────────────────────────
    {
        const result = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: makeWorkRoleParent(),
            siblingBullets: [
                { text: 'Migrated a TypeScript monorepo to pnpm', tags: ['typescript'] },
                { text: 'Cut p99 latency by 40 percent', tags: ['performance'] },
            ],
            archiveSpans: [makeSpan()],
            currentBullet: null,
        });
        const { system, user } = result;

        record(
            'buildBulletAssistPrompt: fill returns { system, user }',
            typeof system === 'string' && typeof user === 'string' && system.length > 0 && user.length > 0,
        );
        record(
            'fill: system contains all 4 hallucination guardrails',
            system.includes('Do not invent specific quantitative claims') &&
                system.includes("Preserve the user's existing tense") &&
                system.includes('return fewer bullets') &&
                system.includes('archive shows the same role described with different wording'),
        );
        record(
            'fill: user includes Entry section, Other-bullets, Archive section',
            user.includes('## Entry') &&
                user.includes('## Other bullets in this profile') &&
                user.includes('## Spans from prior uploaded resume versions'),
        );
        record(
            'fill: user includes fill-mode output schema (3–5 bullets)',
            /3.{0,5}5\s+bullets/i.test(user) && user.includes('"bullets"'),
        );
        record('fill: user does NOT include rewrite-only "Current bullet" header', !user.includes('## Current bullet'));

        // Section ordering: Entry, then Other bullets, then Archive
        const idxEntry = user.indexOf('## Entry');
        const idxSiblings = user.indexOf('## Other bullets in this profile');
        const idxArchive = user.indexOf('## Spans from prior uploaded resume versions');
        record(
            'fill: section ordering Entry → Other bullets → Archive',
            idxEntry !== -1 && idxSiblings !== -1 && idxArchive !== -1 && idxEntry < idxSiblings && idxSiblings < idxArchive,
        );
    }

    // ─── buildBulletAssistPrompt — rewrite mode ────────────────────────────
    {
        const result = await buildBulletAssistPrompt({
            mode: 'rewrite',
            parent: makeWorkRoleParent(),
            siblingBullets: [{ text: 'Migrated a TypeScript monorepo to pnpm', tags: ['typescript'] }],
            archiveSpans: [makeSpan()],
            currentBullet: { text: 'Worked on stuff', tags: ['general'] },
        });
        const { user } = result;

        record(
            'rewrite: user includes "Current bullet to rewrite" header + bullet text',
            user.includes('## Current bullet to rewrite') && user.includes('Worked on stuff'),
        );
        // M7.7.2 — rewrite is text-only. Output schema must NOT include a
        // `tags` field; the task statement explicitly instructs the LLM not
        // to return or modify tags. Tag churn moved to the bullet-tags-from-profile
        // callsite.
        record(
            'rewrite: output schema is text-only (no "tags" field, no "bullets" field — M7.7.2)',
            user.includes('"text"') &&
                !user.includes('"tags": ["') &&
                !/"tags"\s*:/.test(user.split('Output schema').pop() ?? '') &&
                !/3.{0,5}5\s+bullets/i.test(user),
        );
        record(
            'rewrite: task statement forbids the LLM from returning tags (M7.7.2)',
            /do not (return|touch|modify).{0,40}tags|return only the new text|tags.*owned by.*separate|context only/i.test(user),
        );

        // Section ordering for rewrite: Entry → Siblings → Archive → Current bullet → Output schema
        const idxEntry = user.indexOf('## Entry');
        const idxSiblings = user.indexOf('## Other bullets in this profile');
        const idxArchive = user.indexOf('## Spans from prior uploaded resume versions');
        const idxCurrent = user.indexOf('## Current bullet to rewrite');
        const idxSchema = user.indexOf('## Output schema');
        record(
            'rewrite: section ordering Entry → Siblings → Archive → Current bullet → Output schema',
            [idxEntry, idxSiblings, idxArchive, idxCurrent, idxSchema].every(i => i !== -1) &&
                idxEntry < idxSiblings &&
                idxSiblings < idxArchive &&
                idxArchive < idxCurrent &&
                idxCurrent < idxSchema,
        );
    }

    // ─── 8 KB total user-prompt ceiling ────────────────────────────────────
    {
        // Force an overflow with massive sibling list + huge archive spans.
        const hugeSiblings: SiblingInput[] = Array.from({ length: 50 }, (_, i) => ({
            text: `Sibling bullet ${i}: ${'pad '.repeat(40)}`,
            tags: ['typescript'],
        }));
        const hugeSpans: ArchiveSpan[] = Array.from({ length: 3 }, (_, i) =>
            makeSpan({
                uploadId: `u_${i}`,
                uploadedAt: new Date(Date.UTC(2024, i, 1)),
                span: 'x'.repeat(4_000),
            }),
        );
        const result = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: makeWorkRoleParent(),
            siblingBullets: hugeSiblings,
            archiveSpans: hugeSpans,
            currentBullet: null,
        });
        record(
            '8 KB ceiling: oversized inputs trimmed to fit user prompt under 8192 bytes',
            utf8Bytes(result.user) <= 8_192,
            `bytes=${utf8Bytes(result.user)}`,
        );
        // Entry + Output schema MUST survive trimming
        record(
            '8 KB ceiling: spine + output schema preserved through trim',
            result.user.includes('## Entry') && result.user.includes('## Output schema'),
        );
    }

    // ─── empty siblings / spans — sections omitted cleanly ────────────────
    {
        const result = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: makeWorkRoleParent({ company: 'NewCo', title: 'Engineer' }),
            siblingBullets: [],
            archiveSpans: [],
            currentBullet: null,
        });
        record(
            'cold-start: empty siblings + empty archive → those headers absent',
            !result.user.includes('## Other bullets in this profile') &&
                !result.user.includes('## Spans from prior uploaded resume versions'),
        );
        record(
            'cold-start: spine + output schema still rendered',
            result.user.includes('## Entry') && result.user.includes('NewCo') && result.user.includes('## Output schema'),
        );
    }

    // ─── integration with findArchiveSpansFor (sanity) ─────────────────────
    {
        const uploads: ResumeUpload[] = [
            {
                id: 'u_1',
                userId: 'user_x',
                filename: 'resume-2024.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 12_345,
                rawText: 'I worked at Acme Corp from 2022 to 2024 shipping TypeScript services that handled 5k RPS.',
                parsedJson: '{}',
                artifactPath: null,
                importBatchId: null,
                uploadedAt: new Date('2024-06-01T00:00:00Z'),
            },
        ];
        const spans = findArchiveSpansFor({ kind: 'work-role', identifier: 'Acme Corp' }, uploads);
        const result = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: makeWorkRoleParent({ company: 'Acme Corp' }),
            siblingBullets: [],
            archiveSpans: spans,
            currentBullet: null,
        });
        record(
            'integration: archive spans from real findArchiveSpansFor end up in the prompt',
            spans.length === 1 && result.user.includes('resume-2024.pdf') && result.user.includes('Acme Corp'),
        );
    }

    // ─── final tally ───────────────────────────────────────────────────────
    const passed = steps.filter(s => s.ok).length;
    const failed = steps.length - passed;
    console.info(`\n${passed}/${steps.length} steps passed`);
    if (failed > 0) {
        console.error(`${failed} step(s) failed.`);
        process.exit(1);
    }
    console.info('All checks passed.');
}

main().catch((err: unknown) => {
    console.error('Smoke crashed:', err);
    process.exit(1);
});
