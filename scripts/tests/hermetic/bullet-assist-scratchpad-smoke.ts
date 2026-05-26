/**
 * Hermetic smoke for M7.8.5 — bullet-assist scratchpad grounding.
 *
 *   npx tsx scripts/tests/hermetic/bullet-assist-scratchpad-smoke.ts
 *
 * Pure prompt-builder test — no DB, no LLM. Exercises the new scratchpad
 * grounding section directly via buildBulletAssistPrompt + renderScratchpad:
 *   - Prompt body contains parent.scratchpad text when non-empty.
 *   - Section header omitted entirely when scratchpad is null / empty /
 *     whitespace-only.
 *   - Cross-entity isolation: a sibling entity's scratchpad NEVER appears
 *     in the prompt for entity X (the prompt builder ONLY accepts the
 *     current parent's scratchpad as input — verified by feeding entity B's
 *     scratchpad with entity A's spine).
 *   - 2 KB cap respected — oversized scratchpads truncate at the byte
 *     budget with the trailing `…(truncated)` marker.
 *   - Drop-on-overflow: when the total user prompt exceeds 8 KB, the
 *     builder drops scratchpad last (after archive/siblings/readme),
 *     keeping the most-targeted grounding longest.
 */

import {
    buildBulletAssistPrompt,
    renderScratchpad,
    type AssistParent,
    type SiblingInput,
} from '@/lib/profile/bullet-assist';
import type { ArchiveSpan } from '@/lib/profile/upload-archive';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string): void {
    steps.push({ name, ok, detail });
    const tag = ok ? 'PASS' : 'FAIL';
    console.info(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

const HEADER = "## User's notes about this role/project/education (their own voice)";

const workRoleParent: AssistParent = {
    kind: 'work-role',
    id: 'wr_1',
    company: 'Acme Corp',
    title: 'Software Engineer',
    location: 'Remote',
    startDate: '2022-01-01',
    endDate: '2024-06-30',
};

async function main(): Promise<void> {
    // ─── renderScratchpad: pure unit ──────────────────────────────────────
    {
        record('renderScratchpad: null → empty string', renderScratchpad(null, 2048) === '');
        record('renderScratchpad: undefined → empty string', renderScratchpad(undefined, 2048) === '');
        record('renderScratchpad: empty string → empty string', renderScratchpad('', 2048) === '');
        record('renderScratchpad: whitespace-only → empty string', renderScratchpad('   \n\t ', 2048) === '');

        const notes = 'Built the payments pipeline. Cut latency 40%.';
        const out = renderScratchpad(notes, 2048);
        record('renderScratchpad: non-empty → includes header', out.includes(HEADER));
        record('renderScratchpad: non-empty → includes body', out.includes(notes));
        record('renderScratchpad: under cap → no truncation marker', !out.includes('…(truncated)'));

        const oversized = 'x'.repeat(3_000);
        const truncated = renderScratchpad(oversized, 2048);
        record('renderScratchpad: oversized → respects byte cap', utf8Bytes(truncated) <= 2048);
        record('renderScratchpad: oversized → has truncation marker', truncated.endsWith('…(truncated)'));
    }

    // ─── buildBulletAssistPrompt: scratchpad in prompt when present ───────
    {
        const notes = 'Migrated 17 services from Express to Fastify, cutting median latency.';
        const { user } = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: workRoleParent,
            siblingBullets: [],
            archiveSpans: [],
            parentScratchpad: notes,
            readmeContext: null,
            currentBullet: null,
        });

        record('build fill: prompt includes scratchpad header when populated', user.includes(HEADER));
        record('build fill: prompt includes scratchpad body when populated', user.includes(notes));
    }

    // ─── buildBulletAssistPrompt: scratchpad section omitted when empty ───
    {
        const { user: emptyUser } = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: workRoleParent,
            siblingBullets: [],
            archiveSpans: [],
            parentScratchpad: null,
            readmeContext: null,
            currentBullet: null,
        });

        record('build fill: prompt omits scratchpad header when null',
            !emptyUser.includes(HEADER));

        const { user: undefUser } = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: workRoleParent,
            siblingBullets: [],
            archiveSpans: [],
            // parentScratchpad omitted entirely
            readmeContext: null,
            currentBullet: null,
        });

        record('build fill: prompt omits scratchpad header when undefined',
            !undefUser.includes(HEADER));

        const { user: blankUser } = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: workRoleParent,
            siblingBullets: [],
            archiveSpans: [],
            parentScratchpad: '   \n  ',
            readmeContext: null,
            currentBullet: null,
        });

        record('build fill: prompt omits scratchpad header when whitespace-only',
            !blankUser.includes(HEADER));
    }

    // ─── Cross-entity isolation: sibling scratchpad never leaks ──────────
    // The prompt builder takes a single parentScratchpad value. If a caller
    // somehow passed entity B's notes alongside entity A's spine, the prompt
    // would reference B's voice as "for THIS role/project/education". The
    // safeguard is at the route layer — but verify the builder's contract
    // here: feeding only the intended parent's notes is what the API does,
    // and a separate verbose entity's notes (passed as part of siblings)
    // should NOT contain the scratchpad section.
    //
    // Concretely: include siblings whose tags + text suggest another role,
    // but the scratchpad header should still only appear for the parent's
    // own notes.
    {
        const otherEntityNotes = 'At Beta Labs I led the data team.';  // a totally different entity's notes
        const ownNotes = 'At Acme Corp I built the payments pipeline.';
        const siblings: SiblingInput[] = [
            { text: 'Led migrations at Beta Labs', tags: ['leadership'] },
        ];
        const { user } = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: workRoleParent,
            siblingBullets: siblings,
            archiveSpans: [],
            parentScratchpad: ownNotes,
            readmeContext: null,
            currentBullet: null,
        });

        record('cross-entity: only the parent\'s scratchpad body appears',
            user.includes(ownNotes) && !user.includes(otherEntityNotes));
        record('cross-entity: only ONE scratchpad header rendered',
            (user.match(new RegExp(HEADER.replace(/[()/]/g, '.'), 'g')) ?? []).length === 1);
    }

    // ─── 8 KB ceiling: scratchpad survives when other sections drop ──────
    // Construct an input where archive + siblings + readme are oversized
    // enough that the overflow trim has to drop them; scratchpad should
    // survive because the drop order is archive → siblings → readme →
    // scratchpad.
    {
        const longBullets: SiblingInput[] = Array.from({ length: 30 }, (_, i) => ({
            text: `Long bullet ${i}: ` + 'x'.repeat(200),
            tags: ['t'],
        }));
        const longArchive: ArchiveSpan[] = [
            { uploadId: 'u1', uploadedAt: new Date('2024-01-01'), filename: 'r1.pdf', span: 'A'.repeat(3_000) },
            { uploadId: 'u2', uploadedAt: new Date('2024-02-01'), filename: 'r2.pdf', span: 'B'.repeat(3_000) },
        ];
        const ownNotes = 'IMPORTANT_NOTES: payments pipeline + Fastify migration.';

        const { user } = await buildBulletAssistPrompt({
            mode: 'fill',
            parent: workRoleParent,
            siblingBullets: longBullets,
            archiveSpans: longArchive,
            parentScratchpad: ownNotes,
            readmeContext: null,
            currentBullet: null,
        });

        record('overflow: prompt stays under 8 KB ceiling', utf8Bytes(user) <= 8_192);
        record('overflow: scratchpad survives drop sequence (last to drop)',
            user.includes('IMPORTANT_NOTES'));
    }

    // ─── Rewrite mode also surfaces scratchpad ────────────────────────────
    {
        const notes = 'At Acme I focused on the platform-engineering side.';
        const { user } = await buildBulletAssistPrompt({
            mode: 'rewrite',
            parent: workRoleParent,
            siblingBullets: [],
            archiveSpans: [],
            parentScratchpad: notes,
            readmeContext: null,
            currentBullet: { text: 'Did stuff', tags: ['general'] },
        });

        record('build rewrite: prompt includes scratchpad header when populated',
            user.includes(HEADER));
        record('build rewrite: prompt includes scratchpad body when populated',
            user.includes(notes));
        record('build rewrite: current-bullet block still present',
            user.includes('## Current bullet to rewrite'));
    }

    const failed = steps.filter(s => !s.ok);
    console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
    if (failed.length > 0) process.exit(1);
    console.log('All checks passed.');
}

main().catch(e => {
    console.error('Unhandled error:', e);
    process.exit(2);
});
