// M7.6.4 hermetic smoke. Pure function, no DB.
// Run with: npx tsx scripts/tests/hermetic/archive-spans-smoke.ts

import type { ResumeUpload } from '@prisma/client';
import { findArchiveSpansFor, type ArchiveSpan } from '@/lib/profile/upload-archive';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Mock builder — only fields the function reads (id, uploadedAt, filename,
// rawText) need real values. Everything else is satisfied via the cast.
function mockUpload(partial: {
    id: string;
    uploadedAt: Date;
    filename: string;
    rawText: string | null;
}): ResumeUpload {
    return partial as unknown as ResumeUpload;
}

// Helper: invariant check applied to every returned span across every case.
const allSpanRecords: { caseName: string; span: ArchiveSpan; identifier: string }[] = [];
function recordSpans(caseName: string, identifier: string, spans: ArchiveSpan[]) {
    for (const s of spans) allSpanRecords.push({ caseName, span: s, identifier });
}

// ─── 1. Empty uploads list ────────────────────────────────────────────────
{
    const out = findArchiveSpansFor({ kind: 'work-role', identifier: 'Acme' }, []);
    record('empty uploads → []', out.length === 0, `got ${JSON.stringify(out)}`);
}

// Shared minimal one-upload fixture for the null/empty-identifier cases.
const oneUpload = mockUpload({
    id: 'u-one',
    uploadedAt: new Date('2026-01-01T00:00:00Z'),
    filename: 'one.pdf',
    rawText: 'I worked at Acme Corp in 2024 on cool things.',
});

// ─── 2. Null identifier ───────────────────────────────────────────────────
{
    const out = findArchiveSpansFor({ kind: 'work-role', identifier: null }, [oneUpload]);
    record('null identifier → []', out.length === 0, `got ${JSON.stringify(out)}`);
}

// ─── 3. Empty-string identifier ───────────────────────────────────────────
{
    const out = findArchiveSpansFor({ kind: 'work-role', identifier: '' }, [oneUpload]);
    record('empty-string identifier → []', out.length === 0, `got ${JSON.stringify(out)}`);
}

// ─── 4. Whitespace-only identifier ────────────────────────────────────────
{
    const out = findArchiveSpansFor({ kind: 'work-role', identifier: '   ' }, [oneUpload]);
    record('whitespace-only identifier → []', out.length === 0, `got ${JSON.stringify(out)}`);
}

// ─── 5. Upload with rawText: null is skipped ──────────────────────────────
{
    const nullText = mockUpload({
        id: 'u-null',
        uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'null.pdf',
        // Function's runtime guard handles null even though TS type is `string`.
        rawText: null as unknown as string,
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier: 'Acme' }, [nullText]);
    record('rawText null → skipped → []', out.length === 0, `got ${JSON.stringify(out)}`);
}

// ─── 6. Upload with rawText: '' is skipped ────────────────────────────────
{
    const empty = mockUpload({
        id: 'u-empty',
        uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'empty.pdf',
        rawText: '',
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier: 'Acme' }, [empty]);
    record('rawText empty → skipped → []', out.length === 0, `got ${JSON.stringify(out)}`);
}

// ─── 7. No matches across all uploads → [] ────────────────────────────────
{
    const u1 = mockUpload({
        id: 'u1', uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'a.pdf', rawText: 'Worked at Beta Co on widgets.',
    });
    const u2 = mockUpload({
        id: 'u2', uploadedAt: new Date('2026-01-02T00:00:00Z'),
        filename: 'b.pdf', rawText: 'Studied at Gamma University.',
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier: 'Acme' }, [u1, u2]);
    record('no matches → []', out.length === 0, `got ${JSON.stringify(out)}`);
}

// ─── 8. Single match in middle: window is identifier.length + 1000 ───────
{
    // Build a long rawText with the identifier near the middle so both sides
    // have at least 500 chars of context to slice.
    const identifier = 'Acme';
    const pre = 'a'.repeat(800);
    const post = 'b'.repeat(800);
    const raw = pre + identifier + post;
    const u = mockUpload({
        id: 'u-mid', uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'mid.pdf', rawText: raw,
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier }, [u]);
    recordSpans('single-mid', identifier, out);

    record('mid: one span returned', out.length === 1, `got len=${out.length}`);
    if (out.length === 1) {
        const s = out[0];
        record(
            'mid: span contains identifier',
            s.span.toLowerCase().includes(identifier.toLowerCase()),
        );
        record(
            'mid: span.length === identifier.length + 1000',
            s.span.length === identifier.length + 1000,
            `got ${s.span.length}, expected ${identifier.length + 1000}`,
        );
        record('mid: uploadId === u-mid', s.uploadId === 'u-mid');
        record('mid: filename === mid.pdf', s.filename === 'mid.pdf');
    }
}

// ─── 9. Match near start (index < 500): window starts at 0 ───────────────
{
    const identifier = 'Acme';
    // identifier at offset 10 — start clamps to 0, so span starts with the
    // first chars of rawText.
    const raw = 'prelude___' + identifier + 'x'.repeat(600);
    const u = mockUpload({
        id: 'u-start', uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'start.pdf', rawText: raw,
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier }, [u]);
    recordSpans('near-start', identifier, out);

    record('start: one span', out.length === 1);
    if (out.length === 1) {
        const s = out[0];
        // start == max(0, 10 - 500) == 0 → span must start with rawText[0..]
        // expected end == min(raw.length, 10 + 4 + 500) == 514
        const expectedEnd = Math.min(raw.length, 10 + identifier.length + 500);
        record(
            'start: span === rawText.slice(0, expectedEnd)',
            s.span === raw.slice(0, expectedEnd),
            `len got=${s.span.length} expected=${expectedEnd}`,
        );
        record(
            'start: span.startsWith(rawText.slice(0, 10))',
            s.span.startsWith(raw.slice(0, 10)),
        );
        record(
            'start: span.length <= identifier.length + 1000',
            s.span.length <= identifier.length + 1000,
            `got ${s.span.length}`,
        );
    }
}

// ─── 10. Match near end: window ends at rawText.length ───────────────────
{
    const identifier = 'Acme';
    const raw = 'y'.repeat(600) + identifier + 'tail';
    const u = mockUpload({
        id: 'u-end', uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'end.pdf', rawText: raw,
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier }, [u]);
    recordSpans('near-end', identifier, out);

    record('end: one span', out.length === 1);
    if (out.length === 1) {
        const s = out[0];
        // idx = 600, identifier.length = 4 → end = min(raw.length, 600 + 4 + 500) = min(608, 1104) = 608
        record(
            'end: span ends at rawText.length',
            s.span.endsWith('tail') && raw.endsWith(s.span.slice(-Math.min(10, s.span.length))),
        );
        record(
            'end: span === rawText.slice(start, rawText.length)',
            s.span === raw.slice(Math.max(0, 600 - 500), raw.length),
        );
        record(
            'end: span.length <= identifier.length + 1000',
            s.span.length <= identifier.length + 1000,
            `got ${s.span.length}`,
        );
    }
}

// ─── 11. Multiple matches in same rawText: only first window included ────
{
    const identifier = 'Acme';
    const raw = 'before ' + identifier + ' middle '.repeat(50) + identifier + ' after';
    const u = mockUpload({
        id: 'u-multi', uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'multi.pdf', rawText: raw,
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier }, [u]);
    recordSpans('multi-in-one', identifier, out);

    record('multi-in-one: exactly one span', out.length === 1, `got ${out.length}`);
    if (out.length === 1) {
        const firstIdx = raw.toLowerCase().indexOf(identifier.toLowerCase());
        const expectedStart = Math.max(0, firstIdx - 500);
        const expectedEnd = Math.min(raw.length, firstIdx + identifier.length + 500);
        record(
            'multi-in-one: span === slice(firstIdx-500, firstIdx+id.len+500)',
            out[0].span === raw.slice(expectedStart, expectedEnd),
        );
    }
}

// ─── 12. Case-insensitive: 'ACME' matches 'acme corp' ────────────────────
{
    const identifier = 'ACME';
    const raw = 'I worked at acme corp on backend systems.';
    const u = mockUpload({
        id: 'u-case', uploadedAt: new Date('2026-01-01T00:00:00Z'),
        filename: 'case.pdf', rawText: raw,
    });
    const out = findArchiveSpansFor({ kind: 'work-role', identifier }, [u]);
    recordSpans('case-insensitive', identifier, out);

    record('case: one span', out.length === 1);
    if (out.length === 1) {
        record(
            'case: span contains "acme corp" (lowercase preserved)',
            out[0].span.includes('acme corp'),
        );
    }
}

// ─── 13. 5 matching uploads → top 3 newest-first ─────────────────────────
{
    const identifier = 'Acme';
    const uploads = [1, 2, 3, 4, 5].map(i => mockUpload({
        id: `u${i}`,
        uploadedAt: new Date(`2026-01-0${i}T00:00:00Z`),  // 01..05
        filename: `file${i}.pdf`,
        rawText: `Some prelude about Acme #${i} and the rest.`,
    }));
    const out = findArchiveSpansFor({ kind: 'work-role', identifier }, uploads);
    recordSpans('top-3', identifier, out);

    record('top-3: returns exactly 3', out.length === 3, `got ${out.length}`);
    if (out.length === 3) {
        // Newest-first: u5, u4, u3
        record('top-3: [0] is u5', out[0].uploadId === 'u5', `got ${out[0].uploadId}`);
        record('top-3: [1] is u4', out[1].uploadId === 'u4', `got ${out[1].uploadId}`);
        record('top-3: [2] is u3', out[2].uploadId === 'u3', `got ${out[2].uploadId}`);
        // And in strictly descending order of uploadedAt
        const desc =
            out[0].uploadedAt.getTime() >= out[1].uploadedAt.getTime() &&
            out[1].uploadedAt.getTime() >= out[2].uploadedAt.getTime();
        record('top-3: ordering monotonically non-increasing', desc);
    }
}

// ─── 14. Equal uploadedAt: stable order preserves input order ────────────
{
    const identifier = 'Acme';
    const sameTime = new Date('2026-02-01T00:00:00Z');
    const uploads = [
        mockUpload({ id: 'tieA', uploadedAt: sameTime, filename: 'A.pdf', rawText: 'Acme here.' }),
        mockUpload({ id: 'tieB', uploadedAt: sameTime, filename: 'B.pdf', rawText: 'Acme there.' }),
    ];
    const out = findArchiveSpansFor({ kind: 'work-role', identifier }, uploads);
    recordSpans('tie', identifier, out);

    record('tie: both returned', out.length === 2, `got ${out.length}`);
    if (out.length === 2) {
        // Stable sort: equal keys preserve input order, so tieA precedes tieB.
        record(
            'tie: stable input order preserved (tieA before tieB)',
            out[0].uploadId === 'tieA' && out[1].uploadId === 'tieB',
            `got [${out[0].uploadId}, ${out[1].uploadId}]`,
        );
    }
}

// ─── 15. Global invariant: every span across every case obeys length cap ─
{
    let allOk = true;
    let firstFail: string | null = null;
    for (const r of allSpanRecords) {
        const cap = r.identifier.length + 1000;
        if (r.span.span.length > cap) {
            allOk = false;
            firstFail = `case=${r.caseName} uploadId=${r.span.uploadId} len=${r.span.span.length} cap=${cap}`;
            break;
        }
    }
    record(
        `global invariant: all ${allSpanRecords.length} spans satisfy span.length <= identifier.length + 1000`,
        allOk,
        firstFail ?? undefined,
    );
}

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
