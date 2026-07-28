/**
 * Hermetic smoke for M7.7.3 + M7.7.5 — per-bullet AI tag generator route.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/bullet-tag-suggest-smoke.ts
 *
 * Exercises the full POST /api/profile/bullets/assist with mode='tags':
 *   - Pin preservation (server re-adds pinned tags the LLM dropped).
 *   - 3–7 cap respected (server truncates if LLM over-shoots).
 *   - removedTags blocklist filtered (server strips any leaked tags).
 *   - 7-tag bullet → 400 tag-limit-reached BEFORE LLM call (cap guard).
 *   - Locked bullet → 400 cannot-suggest-tags-locked.
 *   - Cross-user bullet → 404 not-found (no existence leak).
 *
 * Mocks `chatJSON` via require.cache injection so no Gemini tokens get burned.
 * Auth: post the Cloudflare-Access rewrite (docs/cloudflare-access-auth.html),
 * `requireSession` resolves "the owner" via lib/owner.ts:resolveOwner instead
 * of NextAuth. Since the owner/crew rework the guards resolve through
 * lib/viewer.ts:resolveViewer() instead, so the smoke acts as the scratch user
 * through the __seedViewer seam (the legacy getServerSession mock below is now
 * vestigial but harmless). Cleans up the scratch user + profile in finally.
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { __seedViewer, __resetViewer } from '@/lib/viewer';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}

// Mocked chatJSON state.
let cannedTags: string[] = [];
let cannedReason: string | undefined = undefined;
let chatJSONCallCount = 0;
let mockSessionUser: { id: string; email: string } | null = null;

const cache = (require as unknown as { cache: Record<string, unknown> }).cache;

function injectCacheEntry(specifier: string, exports: Record<string, unknown>): void {
    const resolved = require.resolve(specifier);
    cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        children: [],
        paths: [],
        exports,
    };
}

class AIError extends Error {
    constructor(public readonly stage: string, message: string) {
        super(message);
        this.name = 'AIError';
    }
}

injectCacheEntry('@/lib/ai/gemini', {
    chatJSON: async (opts: { name: string }) => {
        chatJSONCallCount += 1;
        if (opts.name === 'bullet-tags-from-profile') {
            return { tags: cannedTags, reason: cannedReason };
        }
        throw new Error(`unexpected chatJSON name in this smoke: ${opts.name}`);
    },
    AIError,
    MODEL_FLASH: 'gemini-3.5-flash',
    MODEL_LITE: 'gemini-3.1-flash-lite',
    MODEL_LITE_CHEAP: 'gemini-3.1-flash-lite',
});

injectCacheEntry('next-auth/next', {
    getServerSession: async () => {
        if (!mockSessionUser) return null;
        return { user: { id: mockSessionUser.id, email: mockSessionUser.email } };
    },
    default: () => undefined,
    unstable_getServerSession: async () => null,
});

// Now load the route — must come AFTER cache injection so the route's
// requires resolve to our mocks.
const routeMod = require('@/app/api/profile/bullets/assist/route');
const POST: (req: Request) => Promise<Response> = routeMod.POST;

const prisma = new PrismaClient();
const tag = randomBytes(4).toString('hex');
const userId = `bts-smoke-user-${tag}`;
const otherUserId = `bts-smoke-other-${tag}`;
// Act as the scratch "userId" account. Since the owner/crew rework (P1.3.2)
// the guards resolve identity through lib/viewer.ts:resolveViewer(), which reads
// the Access-verified header via next/headers — and `headers()` THROWS for a
// route handler called in-process from a tsx script, so every request here would
// 401. The old owner-email env pin is retired and there is no identity
// fallback by design; the
// sanctioned way in is the explicit __seedViewer seam (P1.2.4), cleared in
// main()'s finally so it cannot leak into the next suite.
__seedViewer({ id: userId, email: `bts-${tag}@example.invalid`, role: 'owner' });
let profileId = '';
let otherProfileId = '';
let workRoleId = '';
let otherWorkRoleId = '';

function buildPostRequest(body: unknown): Request {
    return new Request('http://test.invalid/api/profile/bullets/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function callTags(parentId: string, bulletId: string): Promise<{ status: number; body: unknown }> {
    const res = await POST(buildPostRequest({
        mode: 'tags',
        parentKind: 'work-role',
        parentId,
        bulletId,
    }));
    let body: unknown = null;
    try { body = await res.json(); } catch { /* noop */ }
    return { status: res.status, body };
}

async function main(): Promise<void> {
    try {
        // Two users + a profile + work role per user.
        await prisma.user.create({ data: { id: userId, email: `bts-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `bts-other-${tag}@example.invalid` } });

        const profile = await prisma.profile.create({ data: { userId } });
        profileId = profile.id;
        const otherProfile = await prisma.profile.create({ data: { userId: otherUserId } });
        otherProfileId = otherProfile.id;

        // Seed bullets exercising the four states the smoke tests:
        //   b-happy: 2 tags, 1 pinned, room to grow
        //   b-locked: locked=true (route should 400 before LLM)
        //   b-at-cap: 7 tags (route should 400 tag-limit-reached before LLM)
        //   b-blocklist: 2 tags + 1 in removedTags
        const seedBullets = [
            { id: 'b-happy', text: 'Built a Python service', tags: ['Python', 'API'], autoTags: [], removedTags: [], pinnedTags: ['Python'], locked: false, excluded: false },
            { id: 'b-locked', text: 'Locked accomplishment', tags: ['leadership'], autoTags: [], removedTags: [], pinnedTags: [], locked: true, excluded: false },
            { id: 'b-at-cap', text: 'Lots of stuff', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false },
            { id: 'b-blocklist', text: 'Built a JS UI', tags: ['React', 'CSS'], autoTags: [], removedTags: ['JavaScript'], pinnedTags: [], locked: false, excluded: false },
        ];
        const wr = await prisma.workRole.create({
            data: {
                profileId,
                company: `AcmeCo-${tag}`,
                title: 'Senior Engineer',
                startDate: new Date('2022-01-01'),
                bullets: JSON.stringify(seedBullets),
                position: 0,
            },
        });
        workRoleId = wr.id;

        const otherWr = await prisma.workRole.create({
            data: {
                profileId: otherProfileId,
                company: `OtherCo-${tag}`,
                title: 'Engineer',
                startDate: new Date('2022-01-01'),
                bullets: JSON.stringify([
                    { id: 'b-other', text: 'Other stuff', tags: ['Java'], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false },
                ]),
                position: 0,
            },
        });
        otherWorkRoleId = otherWr.id;

        // ─── Test 1: cross-user bullet → 404 ──────────────────────────────
        mockSessionUser = { id: userId, email: `bts-${tag}@example.invalid` };
        chatJSONCallCount = 0;
        {
            const { status, body } = await callTags(otherWorkRoleId, 'b-other');
            if (status !== 404) {
                fail(`cross-user: expected 404, got ${status}`, body);
            } else {
                pass('cross-user: bullet from another user → 404');
            }
            if (chatJSONCallCount !== 0) fail(`cross-user: LLM should not be called, count=${chatJSONCallCount}`);
            else pass('cross-user: no LLM call fired');
        }

        // ─── Test 2: locked bullet → 400 ──────────────────────────────────
        chatJSONCallCount = 0;
        {
            const { status, body } = await callTags(workRoleId, 'b-locked');
            if (status !== 400) {
                fail(`locked: expected 400, got ${status}`, body);
            } else {
                const errCode = (body as { error?: string })?.error;
                if (errCode !== 'cannot-suggest-tags-locked') {
                    fail(`locked: expected error='cannot-suggest-tags-locked', got '${errCode}'`, body);
                } else {
                    pass("locked: 400 with error='cannot-suggest-tags-locked'");
                }
            }
            if (chatJSONCallCount !== 0) fail(`locked: LLM should not be called, count=${chatJSONCallCount}`);
            else pass('locked: no LLM call fired');
        }

        // ─── Test 3: 7-tag bullet → 400 tag-limit-reached BEFORE LLM ──────
        chatJSONCallCount = 0;
        {
            const { status, body } = await callTags(workRoleId, 'b-at-cap');
            if (status !== 400) {
                fail(`at-cap: expected 400, got ${status}`, body);
            } else {
                const errCode = (body as { error?: string })?.error;
                if (errCode !== 'tag-limit-reached') {
                    fail(`at-cap: expected error='tag-limit-reached', got '${errCode}'`, body);
                } else {
                    pass("at-cap: 400 with error='tag-limit-reached'");
                }
            }
            // The cap guard MUST fire before the LLM call. If chatJSON ran,
            // we burned tokens for no reason — a regression we explicitly
            // care about (the user spec said "system should protect from
            // querying the ai when there are 7 or more tags").
            if (chatJSONCallCount !== 0) {
                fail(`at-cap: cap guard failed — LLM called ${chatJSONCallCount}x BEFORE the route 400'd`);
            } else {
                pass('at-cap: cap guard prevented LLM call (no token spend)');
            }
        }

        // ─── Test 4: happy path → pin preservation ────────────────────────
        // Seed b-happy has pinnedTags=["Python"]. Mock LLM returns tags
        // WITHOUT Python (simulating a hallucinating model). Server post-
        // filter should re-add Python at position 0.
        chatJSONCallCount = 0;
        cannedTags = ['REST', 'Node.js', 'TypeScript'];
        cannedReason = undefined;
        {
            const { status, body } = await callTags(workRoleId, 'b-happy');
            if (status !== 200) {
                fail(`happy: expected 200, got ${status}`, body);
            } else {
                pass('happy: 200 OK');
                const proposal = (body as { proposal?: { tags?: string[] } })?.proposal;
                if (!proposal?.tags) {
                    fail('happy: missing proposal.tags', body);
                } else {
                    if (!proposal.tags.includes('Python')) {
                        fail('happy: pinned "Python" missing from output (server-side patch-back failed)', proposal.tags);
                    } else {
                        pass('happy: pinned "Python" re-added by server post-filter');
                    }
                    if (proposal.tags[0] !== 'Python') {
                        fail(`happy: pinned tag should be first in output, got order: ${proposal.tags.join(',')}`);
                    } else {
                        pass('happy: pinned tag emitted first in output');
                    }
                }
            }
            if (chatJSONCallCount !== 1) fail(`happy: expected 1 LLM call, got ${chatJSONCallCount}`);
            else pass('happy: exactly 1 LLM call');
        }

        // ─── Test 5: blocklist filter — LLM proposes a blocked tag ────────
        // Seed b-blocklist has removedTags=["JavaScript"]. Mock LLM proposes
        // JavaScript. Server post-filter should strip it from the output.
        chatJSONCallCount = 0;
        cannedTags = ['React', 'CSS', 'JavaScript', 'frontend'];
        {
            const { status, body } = await callTags(workRoleId, 'b-blocklist');
            if (status !== 200) {
                fail(`blocklist: expected 200, got ${status}`, body);
            } else {
                const proposal = (body as { proposal?: { tags?: string[] } })?.proposal;
                if (!proposal?.tags) {
                    fail('blocklist: missing proposal.tags', body);
                } else if (proposal.tags.includes('JavaScript')) {
                    fail('blocklist: "JavaScript" should have been stripped by post-filter', proposal.tags);
                } else {
                    pass('blocklist: blocked tag "JavaScript" stripped from output');
                }
            }
        }

        // ─── Test 6: cap respected on output ──────────────────────────────
        // Mock LLM returns 10 tags. Server should truncate to 7.
        chatJSONCallCount = 0;
        cannedTags = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];
        {
            // Use b-happy again (2 tags, 1 pinned, room to grow). Pinned
            // "Python" will be re-added by the post-filter at position 0,
            // then up to 6 of the LLM's proposals fit before MAX_TAGS=7 cap.
            const { status, body } = await callTags(workRoleId, 'b-happy');
            if (status !== 200) {
                fail(`cap-out: expected 200, got ${status}`, body);
            } else {
                const proposal = (body as { proposal?: { tags?: string[] } })?.proposal;
                if (!proposal?.tags) {
                    fail('cap-out: missing proposal.tags', body);
                } else if (proposal.tags.length > 7) {
                    fail(`cap-out: output should be capped at 7, got ${proposal.tags.length}`, proposal.tags);
                } else {
                    pass(`cap-out: output capped at MAX_TAGS=7 (got ${proposal.tags.length})`);
                }
                if (proposal?.tags && proposal.tags[0] !== 'Python') {
                    fail('cap-out: pinned "Python" should still be first even after truncation');
                } else {
                    pass('cap-out: pinned "Python" preserved at position 0 even with 10-tag LLM proposal');
                }
            }
        }

        // ─── Test 7: bogus payload (non-cuid bulletId) → 400 ──────────────
        // The discriminated-union schema rejects shapes that fail any leaf
        // validator. We don't have a .cuid() constraint here (bulletId is
        // .min(1)), but a missing bulletId in tags mode should reject.
        chatJSONCallCount = 0;
        {
            const res = await POST(buildPostRequest({
                mode: 'tags',
                parentKind: 'work-role',
                parentId: workRoleId,
                // bulletId omitted
            }));
            if (res.status !== 400) {
                fail(`missing-bulletId: expected 400, got ${res.status}`);
            } else {
                pass('missing-bulletId: 400 on schema validation');
            }
            if (chatJSONCallCount !== 0) fail(`missing-bulletId: LLM should not be called`);
            else pass('missing-bulletId: no LLM call fired');
        }
    } finally {
        // Clear the identity seam first — a seam left armed here would hand the
        // next suite in the pre-push gate this smoke's throwaway viewer.
        __resetViewer();
        if (workRoleId) await prisma.workRole.delete({ where: { id: workRoleId } }).catch(() => {});
        if (otherWorkRoleId) await prisma.workRole.delete({ where: { id: otherWorkRoleId } }).catch(() => {});
        if (profileId) await prisma.profile.delete({ where: { id: profileId } }).catch(() => {});
        if (otherProfileId) await prisma.profile.delete({ where: { id: otherProfileId } }).catch(() => {});
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
        await prisma.$disconnect();
    }

}

/**
 * The exit path lives OUT here, not at the bottom of `main()`, so no early
 * `return` inside the body can skip it. `resume-list-smoke.ts` had exactly that
 * bug: it printed `[FAIL]` and still exited 0, and the pre-push gate — which
 * reads only the exit code — passed a red suite.
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log('All checks passed.');
    process.exit(0);
}

main().then(finish, e => {
    console.error('Unhandled error:', e);
    process.exit(2);
});
