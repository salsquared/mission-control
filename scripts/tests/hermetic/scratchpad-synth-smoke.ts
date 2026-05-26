/**
 * Hermetic smoke for M8.6 — resume-gen scratchpad synthesis pass.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/scratchpad-synth-smoke.ts
 *
 * Drives the full POST /api/resumes pipeline with mocked chatJSON to verify:
 *   - Synthesis fires for entities with non-empty scratchpad + mentioned
 *     uncovered posting keywords.
 *   - Synthesis SKIPS entities with empty scratchpad (no LLM call recorded
 *     for them).
 *   - Synthesis SKIPS entities whose scratchpad doesn't mention any
 *     uncovered keyword (no LLM call for them either).
 *   - Synthesized rows land in GeneratedResume.selections with
 *     synthSource="scratchpad".
 *   - Cross-entity isolation: each chatJSON call sees ONLY its own entity's
 *     scratchpad. A sibling entity's notes never appear in another entity's
 *     prompt body.
 *   - Synthesis throw → resume still generates (best-effort posture).
 *   - Skills-gap counts synthesized matchedKeywords as covered.
 *
 * Mocks NextAuth, parsePosting, selectBullets, rewriteBullets, render-pdf
 * via require.cache injection (same pattern as resume-from-application-smoke).
 * chatJSON is mocked but inspects each call's prompt body so we can assert
 * on cross-entity isolation. Cleans up scratch user + profile in finally.
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

// ─── Mocked module state ───────────────────────────────────────────────────
let mockSessionUser: { id: string; email: string } | null = null;

// Per-call capture for chatJSON. Each entry: { name, system, user, response }.
interface ChatJSONCall {
    name: string;
    system: string;
    user: string;
}
const chatJSONCalls: ChatJSONCall[] = [];

// Per-call canned response for scratchpad-synth, keyed by which entity the
// caller is asking about. Detected via the entityId substring in the user
// prompt — the prompt includes spine text which contains entity-specific
// values like "Acme Corp" vs "Beta Labs".
type SynthResponse = { bullets: Array<{ text: string; tags: string[] }> } | { __throw: string };
const cannedByEntityKeyword: Record<string, SynthResponse> = {};
let cannedByEntityKeywordOrder: string[] = [];

function cannedResponseFor(name: string, userPrompt: string): SynthResponse | null {
    if (name !== "scratchpad-synth") return null;
    for (const kw of cannedByEntityKeywordOrder) {
        if (userPrompt.includes(kw)) return cannedByEntityKeyword[kw];
    }
    return { bullets: [] };
}

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
    chatJSON: async (opts: { name: string; system: string; user: string }) => {
        chatJSONCalls.push({ name: opts.name, system: opts.system, user: opts.user });
        if (opts.name === "bullet-auto-tag") {
            return { proposals: [] };
        }
        if (opts.name === "scratchpad-synth") {
            const canned = cannedResponseFor(opts.name, opts.user);
            if (canned && "__throw" in canned) throw new Error(canned.__throw);
            return canned ?? { bullets: [] };
        }
        throw new Error(`unexpected chatJSON name in this smoke: ${opts.name}`);
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

// parsePosting → return canned posting with our keywords.
let cannedPostingKeywords: string[] = [];
injectCacheEntry("@/lib/resumes/posting", {
    parsePosting: async () => ({
        title: "Senior Backend Engineer",
        company: "TestCo",
        location: null,
        seniority: "senior" as const,
        rawText: "mocked posting",
        sourceUrl: null,
        keywords: cannedPostingKeywords,
    }),
});

// rewriteBullets → echo originalText (no rewriting needed for these
// assertions — we care about which bullets reach the rewrite step).
injectCacheEntry("@/lib/resumes/rewrite", {
    rewriteBullets: async (selections: Array<{ bulletId: string; originalText: string; matchedKeywords?: string[] }>) =>
        selections.map(s => ({
            id: s.bulletId,
            rewrittenText: s.originalText,
            matchedKeywords: s.matchedKeywords ?? [],
        })),
});

// Render → return tiny non-PDF buffer (route doesn't validate, just writes).
injectCacheEntry("@/lib/resumes/render-pdf", {
    renderResumePDF: async () => Buffer.from("%PDF-1.4 mocked", "utf8"),
});
injectCacheEntry("@/lib/resumes/render-docx", {
    renderResumeDOCX: async () => Buffer.from("PK mock-docx", "utf8"),
});

injectCacheEntry("@/lib/resumes/storage", {
    writeResumeArtifact: async (id: string) => `mock/${id}.pdf`,
    deleteResumeArtifact: async () => undefined,
});

const routeMod = require("@/app/api/resumes/route");
const POST: (req: Request) => Promise<Response> = routeMod.POST;

const prisma = new PrismaClient();
const tag = randomBytes(4).toString("hex");
const userId = `ss-smoke-user-${tag}`;
let profileId = "";
let workRoleAId = "";
let workRoleBId = "";
let workRoleCId = "";
const resumeIds: string[] = [];

function buildPostRequest(body: unknown): Request {
    return new Request("http://test.invalid/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function main(): Promise<void> {
    try {
        await prisma.user.create({ data: { id: userId, email: `ss-${tag}@example.invalid` } });
        const profile = await prisma.profile.create({ data: { userId, headline: "Test User" } });
        profileId = profile.id;

        // Three WorkRoles with different scratchpad states:
        //   A: scratchpad mentions "PostgreSQL" (matches an uncovered keyword)
        //   B: scratchpad mentions "Redis" (NOT in the posting → no relevant uncovered)
        //   C: empty scratchpad
        // Each gets one existing bullet so select returns something. Posting
        // keywords are ["TypeScript", "PostgreSQL", "Go"]. The existing bullets
        // cover "TypeScript" only — PostgreSQL + Go are uncovered.
        const wrA = await prisma.workRole.create({
            data: {
                profileId,
                company: `Acme Corp-${tag}`,
                title: "Engineer",
                startDate: new Date("2022-01-01"),
                bullets: JSON.stringify([{ id: `b-a-${tag}`, text: "Built a TypeScript service", tags: ["TypeScript"], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false }]),
                scratchpad: "Spent two quarters migrating data pipeline to PostgreSQL. Schema reshape + cutover. Also wrote a query layer in Go.",
                position: 0,
            },
        });
        workRoleAId = wrA.id;

        const wrB = await prisma.workRole.create({
            data: {
                profileId,
                company: `Beta Labs-${tag}`,
                title: "Engineer",
                startDate: new Date("2021-01-01"),
                bullets: JSON.stringify([{ id: `b-b-${tag}`, text: "Built a TypeScript dashboard", tags: ["TypeScript"], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false }]),
                scratchpad: "Worked on Redis caching layer. Lots of LRU tuning.",
                position: 1,
            },
        });
        workRoleBId = wrB.id;

        const wrC = await prisma.workRole.create({
            data: {
                profileId,
                company: `Gamma Inc-${tag}`,
                title: "Engineer",
                startDate: new Date("2020-01-01"),
                bullets: JSON.stringify([{ id: `b-c-${tag}`, text: "Built a TypeScript backend", tags: ["TypeScript"], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false }]),
                scratchpad: null,
                position: 2,
            },
        });
        workRoleCId = wrC.id;

        mockSessionUser = { id: userId, email: `ss-${tag}@example.invalid` };
        cannedPostingKeywords = ["TypeScript", "PostgreSQL", "Go"];

        // ─── Test 1: synthesis fires for entity A only ────────────────────
        // A's scratchpad mentions "PostgreSQL" + "Go" (both uncovered).
        // B's scratchpad mentions "Redis" only — no overlap with uncovered.
        // C has null scratchpad.
        // ⇒ exactly ONE scratchpad-synth chatJSON call (for entity A).
        chatJSONCalls.length = 0;
        cannedByEntityKeyword[`Acme Corp-${tag}`] = {
            bullets: [
                { text: "Migrated production data pipeline to PostgreSQL with zero downtime", tags: ["PostgreSQL", "data pipeline", "schema migration"] },
                { text: "Built a Go query layer using prepared statements", tags: ["Go", "PostgreSQL", "performance"] },
            ],
        };
        cannedByEntityKeywordOrder = [`Acme Corp-${tag}`];

        const res = await POST(buildPostRequest({ posting: { url: "https://example.invalid/job" } }));

        if (res.status !== 200) {
            fail(`Test 1: expected 200, got ${res.status}`, await res.text().catch(() => null));
        } else {
            pass("Test 1: POST 200");
        }

        const resumeId = res.headers.get("X-Resume-Id");
        if (!resumeId) {
            fail("Test 1: X-Resume-Id header missing");
        } else {
            resumeIds.push(resumeId);
            const row = await prisma.generatedResume.findUnique({ where: { id: resumeId } });
            if (!row) {
                fail("Test 1: GeneratedResume row missing");
            } else {
                const selections = JSON.parse(row.selections) as Array<{ bulletId: string; synthSource?: string; sourceId: string }>;
                const synthRows = selections.filter(s => s.synthSource === "scratchpad");
                if (synthRows.length !== 2) {
                    fail(`Test 1: expected 2 synthesized rows in selections, got ${synthRows.length}`, synthRows);
                } else {
                    pass(`Test 1: ${synthRows.length} synthesized rows landed in GeneratedResume.selections with synthSource="scratchpad"`);
                }
                if (synthRows.some(s => s.sourceId !== workRoleAId)) {
                    fail("Test 1: synthesized rows should ONLY map to entity A", synthRows.map(s => s.sourceId));
                } else {
                    pass("Test 1: synthesized rows all map to entity A (correct entity)");
                }
            }
        }

        // ─── Test 2: only one scratchpad-synth call fired ────────────────
        const synthCalls = chatJSONCalls.filter(c => c.name === "scratchpad-synth");
        if (synthCalls.length !== 1) {
            fail(`Test 2: expected exactly 1 scratchpad-synth call (entity A only), got ${synthCalls.length}`,
                synthCalls.map(c => c.user.slice(0, 60)));
        } else {
            pass("Test 2: exactly 1 scratchpad-synth call (entity A — B/C correctly skipped)");
        }

        // ─── Test 3: cross-entity isolation — A's prompt has A's scratchpad
        // only; B's "Redis caching" notes NEVER appear in A's prompt.
        if (synthCalls.length === 1) {
            const userPrompt = synthCalls[0].user;
            if (!userPrompt.includes("migrating data pipeline to PostgreSQL")) {
                fail("Test 3: A's prompt should contain A's scratchpad text");
            } else {
                pass("Test 3: A's prompt contains A's own scratchpad");
            }
            if (userPrompt.includes("Redis caching")) {
                fail("Test 3: A's prompt CONTAINS B's scratchpad — cross-entity leak detected");
            } else {
                pass("Test 3: A's prompt does NOT contain B's scratchpad (cross-entity isolation)");
            }
        }

        // ─── Test 4: synthesis throw → resume still generates ─────────────
        chatJSONCalls.length = 0;
        cannedByEntityKeyword[`Acme Corp-${tag}`] = { __throw: "scratchpad-synth simulated failure" };
        const res2 = await POST(buildPostRequest({ posting: { url: "https://example.invalid/job" } }));
        if (res2.status !== 200) {
            fail(`Test 4: synthesis throw should not block resume — expected 200, got ${res2.status}`);
        } else {
            pass("Test 4: synthesis throw still yields 200 (best-effort posture)");
            const resumeId2 = res2.headers.get("X-Resume-Id");
            if (resumeId2) {
                resumeIds.push(resumeId2);
                const row = await prisma.generatedResume.findUnique({ where: { id: resumeId2 } });
                if (row) {
                    const selections = JSON.parse(row.selections) as Array<{ synthSource?: string }>;
                    const synthRows = selections.filter(s => s.synthSource === "scratchpad");
                    if (synthRows.length !== 0) {
                        fail(`Test 4: expected 0 synthesized rows after throw, got ${synthRows.length}`);
                    } else {
                        pass("Test 4: zero synthesized rows in selections after throw");
                    }
                }
            }
        }

        // ─── Test 5: skills-gap excludes synthesized coverage ─────────────
        // The route persists skillsGap as JSON.stringify(skillsGap.missing) —
        // i.e. just the array of uncovered keywords (the format the existing
        // skills-gap UI expects). A's scratchpad-synth covers "PostgreSQL"
        // post-M8.6.4, so it should NOT appear in the persisted missing array.
        chatJSONCalls.length = 0;
        cannedByEntityKeyword[`Acme Corp-${tag}`] = {
            bullets: [
                { text: "Migrated production data pipeline to PostgreSQL with zero downtime", tags: ["PostgreSQL", "data pipeline"] },
            ],
        };
        const res3 = await POST(buildPostRequest({ posting: { url: "https://example.invalid/job" } }));
        if (res3.status === 200) {
            const resumeId3 = res3.headers.get("X-Resume-Id");
            if (resumeId3) {
                resumeIds.push(resumeId3);
                const row = await prisma.generatedResume.findUnique({ where: { id: resumeId3 } });
                // `skillsGap` is `String?` on GeneratedResume — defensively
                // handle the null case (shouldn't fire on a successful gen
                // but keeps tsc + the smoke happy under either schema).
                if (row && row.skillsGap) {
                    const missing = JSON.parse(row.skillsGap) as string[];
                    const missingLower = missing.map(s => s.toLowerCase());
                    if (missingLower.includes("postgresql")) {
                        fail("Test 5: PostgreSQL still in skills-gap missing after synthesis covered it", missing);
                    } else {
                        pass("Test 5: PostgreSQL removed from skills-gap.missing after synthesis covered it");
                    }
                } else if (row) {
                    fail("Test 5: skillsGap column was null on a successful resume gen");
                }
            }
        }
    } finally {
        for (const id of resumeIds) {
            await prisma.generatedResume.delete({ where: { id } }).catch(() => {});
        }
        if (workRoleAId) await prisma.workRole.delete({ where: { id: workRoleAId } }).catch(() => {});
        if (workRoleBId) await prisma.workRole.delete({ where: { id: workRoleBId } }).catch(() => {});
        if (workRoleCId) await prisma.workRole.delete({ where: { id: workRoleCId } }).catch(() => {});
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
