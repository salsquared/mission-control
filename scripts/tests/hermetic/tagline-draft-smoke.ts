/**
 * Hermetic smoke for M7.9.3 + M7.9.5 — tagline-draft LLM caller + API route.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/tagline-draft-smoke.ts
 *
 * Exercises POST /api/profile/tagline/draft via require.cache injection of
 * NextAuth + chatJSON. Verifies:
 *   - Mode dispatch: empty current tagline → response mode='draft'; non-empty
 *     → response mode='enhance'.
 *   - Server-side post-filter applied: trims, strips wrapping quotes,
 *     enforces trailing period, hard-truncates at 200 chars on word boundary.
 *   - Rate-limit kicks in on the 11th call within the window → 429.
 *   - AIError → 502 with stage='call' + aiStage from the wrapped error.
 *   - Pure-function postFilterTagline covers the cleanup edge cases the
 *     route-level test can't surface (LLM-emitted multi-line + quoted output).
 *
 * Mocks chatJSON to return canned responses without burning Gemini tokens.
 */

import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? "");
    fails++;
}

let mockSessionUser: { id: string; email: string } | null = null;
let cannedResponse: { tagline: string } | { __throw: string; aiStage?: string } = { tagline: "Backend engineer focused on developer-facing systems." };
let chatJSONCallCount = 0;

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
        this.name = "AIError";
    }
}

injectCacheEntry("@/lib/ai/gemini", {
    chatJSON: async (opts: { name: string }) => {
        chatJSONCallCount += 1;
        if (opts.name !== "tagline-draft") {
            throw new Error(`unexpected chatJSON name in this smoke: ${opts.name}`);
        }
        if ("__throw" in cannedResponse) {
            throw new AIError(cannedResponse.aiStage ?? "model", cannedResponse.__throw);
        }
        return cannedResponse;
    },
    AIError,
    MODEL_FLASH: "gemini-3.5-flash",
    MODEL_LITE: "gemini-3.1-flash-lite",
    MODEL_LITE_CHEAP: "gemini-3.1-flash-lite",
});

injectCacheEntry("next-auth/next", {
    getServerSession: async () => {
        if (!mockSessionUser) return null;
        return { user: { id: mockSessionUser.id, email: mockSessionUser.email } };
    },
    default: () => undefined,
    unstable_getServerSession: async () => null,
});

const routeMod = require("@/app/api/profile/tagline/draft/route");
const POST: (req: Request) => Promise<Response> = routeMod.POST;
const { postFilterTagline } = require("@/lib/profile/tagline-draft") as typeof import("@/lib/profile/tagline-draft");

const prisma = new PrismaClient();
const tag = randomBytes(4).toString("hex");
const userId = `td-smoke-user-${tag}`;
let profileId = "";

function buildPostRequest(): Request {
    return new Request("http://test.invalid/api/profile/tagline/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
}

async function callDraft(): Promise<{ status: number; body: unknown }> {
    const res = await POST(buildPostRequest());
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    try {
        await prisma.user.create({ data: { id: userId, email: `td-${tag}@example.invalid` } });
        const profile = await prisma.profile.create({
            data: {
                userId,
                headline: "Sal Salcedo",
            },
        });
        profileId = profile.id;

        mockSessionUser = { id: userId, email: `td-${tag}@example.invalid` };

        // ─── Test 1: post-filter (pure) covers cleanup edge cases ─────────
        {
            // Wrapping quotes stripped.
            const stripped = postFilterTagline('"Backend engineer focused on systems."');
            if (stripped !== "Backend engineer focused on systems.") {
                fail(`post-filter quotes: got "${stripped}"`);
            } else pass("post-filter strips wrapping double-quotes");

            // Trailing period appended when missing.
            const periodAppended = postFilterTagline("Backend engineer focused on systems");
            if (!periodAppended.endsWith(".")) {
                fail(`post-filter period: got "${periodAppended}"`);
            } else pass("post-filter appends trailing period when missing");

            // Internal newlines collapsed to single space.
            const collapsed = postFilterTagline("Backend engineer\nfocused on systems.");
            if (collapsed !== "Backend engineer focused on systems.") {
                fail(`post-filter newlines: got "${collapsed}"`);
            } else pass("post-filter collapses internal newlines");

            // Over-cap input truncated on word boundary + period re-added.
            const longInput = "Backend engineer focused on developer-facing systems and reliability " + "x".repeat(150);
            const truncated = postFilterTagline(longInput);
            if (truncated.length > 200) {
                fail(`post-filter cap: got ${truncated.length} chars`);
            } else if (!truncated.endsWith(".")) {
                fail(`post-filter cap: missing trailing period`);
            } else {
                pass(`post-filter truncates over-cap to ${truncated.length} chars with period`);
            }
        }

        // ─── Test 2: empty tagline → mode='draft' ─────────────────────────
        chatJSONCallCount = 0;
        cannedResponse = { tagline: "Backend engineer focused on developer-facing systems." };
        {
            const { status, body } = await callDraft();
            if (status !== 200) fail(`draft: expected 200, got ${status}`, body);
            else pass("draft: 200 OK");

            const b = body as { tagline: string; mode: string };
            if (b.mode !== "draft") fail(`draft: expected mode='draft', got '${b.mode}'`);
            else pass("draft: mode='draft' (empty current tagline)");

            if (b.tagline !== "Backend engineer focused on developer-facing systems.") {
                fail(`draft: response tagline mismatch`, b.tagline);
            } else pass("draft: response tagline matches mocked LLM output");

            if (chatJSONCallCount !== 1) fail(`draft: expected 1 chatJSON call, got ${chatJSONCallCount}`);
            else pass("draft: exactly 1 chatJSON call");
        }

        // ─── Test 3: non-empty tagline → mode='enhance' ───────────────────
        chatJSONCallCount = 0;
        cannedResponse = { tagline: "Backend systems engineer building developer-facing APIs." };
        await prisma.profile.update({
            where: { id: profileId },
            data: { tagline: "Backend engineer who likes systems work." },
        });
        {
            const { status, body } = await callDraft();
            if (status !== 200) fail(`enhance: expected 200, got ${status}`, body);
            else pass("enhance: 200 OK");

            const b = body as { tagline: string; mode: string };
            if (b.mode !== "enhance") fail(`enhance: expected mode='enhance', got '${b.mode}'`);
            else pass("enhance: mode='enhance' (non-empty current tagline)");

            if (b.tagline !== "Backend systems engineer building developer-facing APIs.") {
                fail(`enhance: response tagline mismatch`, b.tagline);
            } else pass("enhance: response tagline matches mocked LLM output");
        }

        // ─── Test 4: post-filter applied through the route ───────────────
        // LLM returns text WITHOUT trailing period; route should add it.
        chatJSONCallCount = 0;
        cannedResponse = { tagline: "  Backend engineer building reliable APIs  " };
        {
            const { body } = await callDraft();
            const b = body as { tagline: string };
            if (!b.tagline.endsWith(".")) {
                fail(`route post-filter: missing trailing period`, b.tagline);
            } else if (b.tagline.startsWith(" ") || b.tagline.endsWith(" .")) {
                fail(`route post-filter: leading/trailing whitespace not trimmed`, b.tagline);
            } else {
                pass("route post-filter: trims whitespace + appends trailing period");
            }
        }

        // ─── Test 5: AIError → 502 ───────────────────────────────────────
        chatJSONCallCount = 0;
        cannedResponse = { __throw: "Gemini 503 — simulated outage", aiStage: "rate-limit" };
        {
            const { status, body } = await callDraft();
            if (status !== 502) fail(`AIError: expected 502, got ${status}`, body);
            else pass("AIError: 502 OK");

            const b = body as { error: string; stage: string; aiStage?: string };
            if (b.error !== "llm-error") fail(`AIError: expected error='llm-error', got '${b.error}'`);
            else pass("AIError: error='llm-error'");

            if (b.aiStage !== "rate-limit") fail(`AIError: expected aiStage='rate-limit', got '${b.aiStage}'`);
            else pass("AIError: aiStage propagates from AIError instance");
        }

        // ─── Test 6: rate-limit kicks in on 11th call → 429 ──────────────
        // Reset chatJSON to success; the route counts every call against
        // the per-user limit regardless of outcome. Test 1's 4 calls + this
        // run's existing calls already consumed some budget — drain to 10
        // first, then verify the 11th 429s.
        cannedResponse = { tagline: "Engineer focused on systems." };
        chatJSONCallCount = 0;
        // Use a fresh user so the rate-limit counter is clean (no leakage
        // from prior tests' calls — the limit is per-user-per-window).
        const rlUserId = `td-smoke-rl-${tag}`;
        await prisma.user.create({ data: { id: rlUserId, email: `td-rl-${tag}@example.invalid` } });
        const rlProfile = await prisma.profile.create({ data: { userId: rlUserId } });
        mockSessionUser = { id: rlUserId, email: `td-rl-${tag}@example.invalid` };
        try {
            for (let i = 0; i < 10; i++) {
                const { status } = await callDraft();
                if (status !== 200) {
                    fail(`rate-limit: call #${i + 1} expected 200, got ${status}`);
                    break;
                }
            }
            const { status, body } = await callDraft();
            if (status !== 429) {
                fail(`rate-limit: 11th call expected 429, got ${status}`, body);
            } else {
                pass("rate-limit: 11th call within window → 429");
                const b = body as { stage?: string };
                if (b.stage !== "rate-limit") {
                    fail(`rate-limit: expected stage='rate-limit', got '${b.stage}'`);
                } else {
                    pass("rate-limit: response carries stage='rate-limit'");
                }
            }
        } finally {
            await prisma.profile.delete({ where: { id: rlProfile.id } }).catch(() => {});
            await prisma.user.delete({ where: { id: rlUserId } }).catch(() => {});
            mockSessionUser = { id: userId, email: `td-${tag}@example.invalid` };
        }
    } finally {
        if (profileId) await prisma.profile.delete({ where: { id: profileId } }).catch(() => {});
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.$disconnect();
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
