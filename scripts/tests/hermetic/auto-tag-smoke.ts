/**
 * Hermetic smoke for M8.5.4 / M8.5.3 (story S8.9) — `autoTagBullets` reads
 * the live profile, calls a (mocked) Gemini, post-filters proposals against
 * `removedTags` + existing `tags`, and writes the result through the
 * existing profile repos. The merge logic itself is exercised by
 * `auto-tag-merge-smoke.ts`; this smoke exercises the END-TO-END caller
 * (profile load → prompt build → chatJSON → write).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/auto-tag-smoke.ts
 *
 * Mocks `chatJSON` via require.cache injection so no Gemini tokens get burned.
 * Cleans up the scratch user + profile in finally.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// Mocked chatJSON state — set per test case.
type Proposal = { bulletId: string; addedTags: string[] };
type CannedResponse = { proposals: Proposal[] } | { __throw: string };
let cannedResponse: CannedResponse = { proposals: [] };
let recordedChatCall: { name?: string; system?: string; user?: string } = {};

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

// `@/lib/ai/gemini` — mock chatJSON, keep AIError and the MODEL_LITE export
// so callers that import them don't crash.
class AIError extends Error {
    constructor(public readonly stage: string, message: string) {
        super(message);
        this.name = "AIError";
    }
}
injectCacheEntry("@/lib/ai/gemini", {
    chatJSON: async (opts: { name: string; system: string; user: string }) => {
        recordedChatCall = { name: opts.name, system: opts.system, user: opts.user };
        if ("__throw" in cannedResponse) throw new Error(cannedResponse.__throw);
        return cannedResponse;
    },
    AIError,
    MODEL_FLASH: "gemini-3.5-flash",
    MODEL_LITE: "gemini-3.1-flash-lite",
    MODEL_LITE_CHEAP: "gemini-3.1-flash-lite",
});

// IMPORTANT: load lazily via require() AFTER the cache injection above.
// Static `import` statements get hoisted to the top of the module and would
// resolve the REAL chatJSON before the cache patch takes effect.
const autoTag = require("@/lib/profile/auto-tag") as typeof import("@/lib/profile/auto-tag");
const profileRepo = require("@/lib/repositories/profile") as typeof import("@/lib/repositories/profile");
const autoTagBullets = autoTag.autoTagBullets;
const findOrCreateProfile = profileRepo.findOrCreateProfile;

const prisma = new PrismaClient();
const tag = randomBytes(4).toString("hex");
const userId = `auto-tag-smoke-user-${tag}`;
let profileId = "";
let workRoleId = "";

async function main() {
    try {
        await prisma.user.create({ data: { id: userId, email: `auto-tag-smoke-${tag}@example.invalid` } });
        const profile = await findOrCreateProfile(userId);
        profileId = profile.id;

        // Seed a WorkRole with three bullets — two candidates + one with
        // a blocklist entry to verify the post-filter.
        const seedBullets = [
            { id: "b001", text: "Built a Python service handling 50k req/day", tags: [], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false },
            { id: "b002", text: "Cut latency 40% in our Go API by sharding writes", tags: [], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false },
            { id: "b003", text: "Migrated production payments to Kubernetes", tags: [], autoTags: [], removedTags: ["Kubernetes"], pinnedTags: [], locked: false, excluded: false },
        ];
        const wr = await prisma.workRole.create({
            data: {
                profileId,
                company: `AcmeCo-${tag}`,
                title: "Senior Engineer",
                startDate: new Date("2022-01-01"),
                bullets: JSON.stringify(seedBullets),
                position: 0,
            },
        });
        workRoleId = wr.id;

        // ── Test 1: positive proposals get written to tags + autoTags ──────
        {
            cannedResponse = {
                proposals: [
                    { bulletId: "b001", addedTags: ["Python"] },
                    { bulletId: "b002", addedTags: ["Go"] },
                    // Blocked by removedTags — the caller's post-filter must drop this.
                    { bulletId: "b003", addedTags: ["Kubernetes"] },
                ],
            };
            const result = await autoTagBullets({ userId, postingKeywords: ["Python", "Go", "Kubernetes"] });

            if (recordedChatCall.name !== "bullet-auto-tag") fail(`chatJSON called with wrong name: ${recordedChatCall.name}`);
            else pass("chatJSON dispatched with name=bullet-auto-tag");

            if (result.tagsAdded !== 2) fail(`tagsAdded should be 2 (Python+Go; Kubernetes blocked), got ${result.tagsAdded}`, result);
            else pass("tagsAdded reflects post-filter against removedTags");

            if (result.bulletsAffected !== 2) fail(`bulletsAffected should be 2, got ${result.bulletsAffected}`, result);
            else pass("bulletsAffected reflects post-filter");

            // Verify persistence — re-read the profile.
            const wrRow = await prisma.workRole.findUnique({ where: { id: workRoleId } });
            const persisted = JSON.parse(wrRow!.bullets) as Array<{ id: string; tags: string[]; autoTags: string[]; removedTags: string[] }>;
            const b001 = persisted.find(b => b.id === "b001")!;
            const b002 = persisted.find(b => b.id === "b002")!;
            const b003 = persisted.find(b => b.id === "b003")!;

            if (!b001.tags.includes("Python") || !b001.autoTags.includes("Python")) {
                fail("b001 should have Python in both tags + autoTags", b001);
            } else pass("b001 (positive) writes Python to tags + autoTags");

            if (!b002.tags.includes("Go") || !b002.autoTags.includes("Go")) {
                fail("b002 should have Go in both tags + autoTags", b002);
            } else pass("b002 (positive) writes Go to tags + autoTags");

            if (b003.tags.includes("Kubernetes") || b003.autoTags.includes("Kubernetes")) {
                fail("b003 (blocked) should NOT have Kubernetes", b003);
            } else pass("b003 (blocked) preserves removedTags blocklist — no write");

            if (!b003.removedTags.includes("Kubernetes")) {
                fail("b003 removedTags should still include Kubernetes after the pass", b003);
            } else pass("b003 removedTags unchanged after the pass");
        }

        // ── Test 2: already-tagged keyword does NOT re-mark in autoTags ────
        {
            cannedResponse = {
                proposals: [
                    // b001 already has "Python" from Test 1 — should be no-op in autoTags.
                    { bulletId: "b001", addedTags: ["Python"] },
                ],
            };
            // Snapshot autoTags state before the second pass.
            const wrBefore = await prisma.workRole.findUnique({ where: { id: workRoleId } });
            const beforeBullets = JSON.parse(wrBefore!.bullets) as Array<{ id: string; tags: string[]; autoTags: string[] }>;
            const b001Before = beforeBullets.find(b => b.id === "b001")!;
            const beforePythonCount = b001Before.autoTags.filter(t => t === "Python").length;

            const result = await autoTagBullets({ userId, postingKeywords: ["Python"] });
            if (result.tagsAdded !== 0) fail(`tagsAdded should be 0 on a no-op second pass, got ${result.tagsAdded}`, result);
            else pass("re-run with already-tagged keyword: tagsAdded=0");

            const wrAfter = await prisma.workRole.findUnique({ where: { id: workRoleId } });
            const afterBullets = JSON.parse(wrAfter!.bullets) as Array<{ id: string; tags: string[]; autoTags: string[] }>;
            const b001After = afterBullets.find(b => b.id === "b001")!;
            const afterPythonCount = b001After.autoTags.filter(t => t === "Python").length;
            if (afterPythonCount !== beforePythonCount) {
                fail("autoTags Python count changed on a no-op pass", { before: beforePythonCount, after: afterPythonCount });
            } else pass("re-run with already-tagged keyword: autoTags unchanged");
        }

        // ── Test 3: chatJSON throws → autoTagBullets propagates ────────────
        {
            cannedResponse = { __throw: "Gemini 503 — simulated outage" };
            let threw: Error | null = null;
            try {
                await autoTagBullets({ userId, postingKeywords: ["whatever"] });
            } catch (e) {
                threw = e as Error;
            }
            if (!threw) fail("expected autoTagBullets to throw when chatJSON throws");
            else if (!/Gemini 503/.test(threw.message)) {
                fail("threw error message should mention chatJSON's error", threw.message);
            } else pass("error propagation: chatJSON throw bubbles up to autoTagBullets caller");
            // (The route handler swallows this — covered by tsc on app/api/resumes/route.ts.)
        }
    } finally {
        if (workRoleId) {
            await prisma.workRole.delete({ where: { id: workRoleId } }).catch(() => {});
        }
        if (profileId) {
            await prisma.profile.delete({ where: { id: profileId } }).catch(() => {});
        }
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
