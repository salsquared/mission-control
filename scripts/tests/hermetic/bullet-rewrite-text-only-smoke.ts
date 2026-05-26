/**
 * Hermetic smoke for M7.7.2 — bullet-assist rewrite is text-only.
 *
 *   npx tsx scripts/tests/hermetic/bullet-rewrite-text-only-smoke.ts
 *
 * Mocks `chatJSON` via require.cache injection so no Gemini tokens get
 * burned, then calls the real `callBulletAssist` in rewrite mode and
 * asserts the proposal preserves every tag-related field on the input
 * bullet verbatim. Only `text` should flow from the model.
 *
 * Why this test exists: the M7.6 rewrite shipped with a `fffa038`
 * enhancement that let the LLM rewrite tags alongside the text. The
 * user reported this as a footgun — sentence polish shouldn't clobber
 * carefully chosen tags. M7.7.2 narrowed the response back to text-only;
 * this smoke pins the contract.
 *
 * Bonus assertion: the rewrite prompt-template content (loaded via
 * loadPrompt) MUST NOT instruct the LLM to return tags. We grep the
 * rendered user prompt for the absence of a `"tags":` schema marker.
 */

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

// Capture every chatJSON call so we can assert on (a) the prompt sent and
// (b) how many calls fired. The mock returns a canned text-only response.
let chatJSONCallCount = 0;
let lastChatJSONCall: { name?: string; user?: string; system?: string } = {};

class AIError extends Error {
    constructor(public readonly stage: string, message: string) {
        super(message);
        this.name = 'AIError';
    }
}

injectCacheEntry('@/lib/ai/gemini', {
    chatJSON: async (opts: { name: string; user: string; system: string }) => {
        chatJSONCallCount += 1;
        lastChatJSONCall = { name: opts.name, user: opts.user, system: opts.system };
        if (opts.name === 'bullet-assist-rewrite') {
            return { text: 'Rewritten bullet text — sharper and more concrete' };
            // No `tags` field. Schema is text-only post-M7.7.2.
        }
        throw new Error(`unexpected chatJSON name: ${opts.name}`);
    },
    AIError,
    MODEL_FLASH: 'gemini-3.5-flash',
    MODEL_LITE: 'gemini-3.1-flash-lite',
    MODEL_LITE_CHEAP: 'gemini-3.1-flash-lite',
});

// Lazy require AFTER cache injection so the lib resolves OUR mocked gemini.
const bulletAssist = require('@/lib/profile/bullet-assist') as typeof import('@/lib/profile/bullet-assist');
const { buildBulletAssistPrompt, callBulletAssist } = bulletAssist;

import type { Bullet } from '@/lib/profile/types';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}

async function main(): Promise<void> {
    // The input bullet that callBulletAssist receives via currentBullet.
    // Every tag-related field should pass through unchanged on the proposal.
    const input: Bullet = {
        id: 'b_existing',
        text: 'Worked on backend stuff',
        tags: ['typescript', 'performance', 'leadership'],
        autoTags: ['leadership'],
        removedTags: ['javascript'],
        pinnedTags: ['typescript'],
        locked: false,
        excluded: false,
    };

    const prompt = await buildBulletAssistPrompt({
        mode: 'rewrite',
        parent: {
            kind: 'work-role',
            id: 'wr_1',
            company: 'Acme Corp',
            title: 'Senior Engineer',
            location: 'Remote',
            startDate: '2022-01-01',
            endDate: null,
        },
        siblingBullets: [],
        archiveSpans: [],
        readmeContext: null,
        currentBullet: { text: input.text, tags: input.tags },
    });

    // ─── Assertion 1: prompt content forbids tag output ────────────────────
    // The bullet-assist-rewrite.md template (post-M7.7.2) explicitly tells
    // the model not to return tags. Verify the schema description in the
    // rendered user prompt reflects that — no `"tags":` in the output schema.
    {
        const userPrompt = prompt.user;
        const schemaSection = userPrompt.split('Output schema').pop() ?? '';
        if (schemaSection.includes('"tags"')) {
            fail('rewrite prompt schema still mentions "tags" — should be text-only', schemaSection.slice(0, 300));
        } else {
            pass('rewrite prompt schema is text-only (no "tags" field in output schema)');
        }
    }

    // ─── Run the rewrite and inspect the proposal ─────────────────────────
    const result = await callBulletAssist({
        mode: 'rewrite',
        prompt,
        currentBullet: input,
        parentKind: 'work-role',
        parentId: 'wr_1',
    });

    // ─── Assertion 2: response shape ───────────────────────────────────────
    if (result.mode !== 'rewrite') {
        fail(`expected mode='rewrite', got '${result.mode}'`);
        process.exit(1);
    }
    pass('result.mode === "rewrite"');

    const proposal = result.proposal;

    // ─── Assertion 3: text from LLM ────────────────────────────────────────
    if (proposal.text !== 'Rewritten bullet text — sharper and more concrete') {
        fail('proposal.text does not match mocked LLM output', proposal.text);
    } else {
        pass('proposal.text reflects LLM response');
    }

    // ─── Assertion 4: id preserved ─────────────────────────────────────────
    if (proposal.id !== input.id) {
        fail(`proposal.id changed: expected ${input.id}, got ${proposal.id}`);
    } else {
        pass('proposal.id preserved from input bullet');
    }

    // ─── Assertion 5: tags pass through verbatim ──────────────────────────
    if (JSON.stringify(proposal.tags) !== JSON.stringify(input.tags)) {
        fail('proposal.tags should equal input.tags verbatim (M7.7.2 text-only contract)', {
            expected: input.tags, got: proposal.tags,
        });
    } else {
        pass('proposal.tags preserved verbatim from input bullet');
    }

    // ─── Assertion 6: autoTags preserved ──────────────────────────────────
    if (JSON.stringify(proposal.autoTags) !== JSON.stringify(input.autoTags)) {
        fail('proposal.autoTags should equal input.autoTags', { expected: input.autoTags, got: proposal.autoTags });
    } else {
        pass('proposal.autoTags preserved verbatim from input bullet');
    }

    // ─── Assertion 7: removedTags preserved ───────────────────────────────
    if (JSON.stringify(proposal.removedTags) !== JSON.stringify(input.removedTags)) {
        fail('proposal.removedTags should equal input.removedTags', { expected: input.removedTags, got: proposal.removedTags });
    } else {
        pass('proposal.removedTags preserved verbatim from input bullet');
    }

    // ─── Assertion 8: pinnedTags preserved (M7.7.1 new field) ─────────────
    if (JSON.stringify(proposal.pinnedTags) !== JSON.stringify(input.pinnedTags)) {
        fail('proposal.pinnedTags should equal input.pinnedTags', { expected: input.pinnedTags, got: proposal.pinnedTags });
    } else {
        pass('proposal.pinnedTags preserved verbatim from input bullet (M7.7.1)');
    }

    // ─── Assertion 9: locked / excluded preserved ─────────────────────────
    if (proposal.locked !== input.locked) {
        fail(`proposal.locked changed: ${input.locked} → ${proposal.locked}`);
    } else {
        pass('proposal.locked preserved');
    }
    if (proposal.excluded !== input.excluded) {
        fail(`proposal.excluded changed: ${input.excluded} → ${proposal.excluded}`);
    } else {
        pass('proposal.excluded preserved');
    }

    // ─── Assertion 10: chatJSON called with name=bullet-assist-rewrite ────
    if (lastChatJSONCall.name !== 'bullet-assist-rewrite') {
        fail(`chatJSON called with wrong name: ${lastChatJSONCall.name}`);
    } else {
        pass('chatJSON dispatched with name="bullet-assist-rewrite"');
    }

    if (chatJSONCallCount !== 1) {
        fail(`expected exactly 1 chatJSON call, got ${chatJSONCallCount}`);
    } else {
        pass('chatJSON invoked exactly once');
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log('All checks passed.');
}

main().catch(e => {
    console.error('Unhandled error:', e);
    process.exit(2);
});
