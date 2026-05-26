/**
 * Hermetic smoke for M8.4.5 (story S8.12) — POST /api/resumes accepts
 * `posting.applicationId` and gates it through the Pipeline guards.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/resume-from-application-smoke.ts
 *
 * The route lives behind `requireSession` + `parsePosting` + the rewrite/render
 * pipeline. To exercise the validation guards hermetically we pre-populate
 * Node's `require.cache` with stubs for the modules the route imports — they
 * resolve to our fakes when the route handler is required.
 *
 *   1. `next-auth/next:getServerSession` → returns a forged session whose
 *      `user.email` + `user.id` match the test user. `requireSession` calls
 *      this and accepts the session.
 *   2. `@/lib/resumes/posting:parsePosting` → returns a stub ParsedPosting so
 *      no network fetch + no Gemini call.
 *   3. Heavy pipeline modules (select / rewrite / render) → stubbed so the
 *      happy-path 200 case doesn't burn Chrome or a real Gemini call.
 *
 * Cache injection only works for modules that haven't been imported yet — we
 * inject BEFORE the first `require('@/app/api/resumes/route')`.
 *
 * No HTTP, no PM2. Everything cleaned up in finally.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── Pre-populate require.cache with fakes for modules the route imports ──
// Mutable closure state the fakes consult — set the session user before each
// call, and the parsePosting fake echoes our stub response.
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

// next-auth/next — getServerSession is what requireSession calls under the hood.
injectCacheEntry("next-auth/next", {
    getServerSession: async () => {
        if (!mockSessionUser) return null;
        return { user: { id: mockSessionUser.id, email: mockSessionUser.email } };
    },
    default: () => undefined, // NextAuth default export
    unstable_getServerSession: async () => null,
});

// lib/resumes/posting — bypass network + Gemini.
injectCacheEntry("@/lib/resumes/posting", {
    parsePosting: async (input: { url?: string; text?: string }) => ({
        title: "Mocked Title",
        company: "Mocked Co",
        location: null,
        seniority: null,
        rawText: "mocked",
        sourceUrl: input.url ?? null,
        keywords: ["typescript", "react"],
    }),
});

// lib/resumes/select — bypass real matching. Return one bullet so flatten yields 1.
const flatSelections = [{
    kind: "workRole" as const,
    sourceId: "wr-mock",
    sourceLabel: "Mock Co",
    bulletId: "b-mock",
    originalText: "Did something with TypeScript",
    score: 5,
    matchedTags: ["typescript"],
    matchedKeywords: ["typescript"],
    locked: false,
}];
injectCacheEntry("@/lib/resumes/select", {
    selectBullets: () => ({
        workRoles: [{ kind: "workRole", id: "wr-mock", label: "Mock Co", bullets: flatSelections }],
        projects: [],
        education: [],
    }),
    flattenSelections: () => flatSelections,
});

injectCacheEntry("@/lib/resumes/rewrite", {
    rewriteBullets: async () => [{
        id: "b-mock",
        rewrittenText: "Built something with TypeScript",
        matchedKeywords: ["typescript"],
    }],
});

injectCacheEntry("@/lib/resumes/skills-gap", {
    computeSkillsGap: () => ({ missing: [], covered: [] }),
});

injectCacheEntry("@/lib/resumes/templates/ats-plain", {
    composeResumeProps: () => ({
        header: { name: "Test", contacts: [] },
        sections: { workRoles: [], projects: [], education: [] },
    }),
});

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

// Now load the route handler. The CJS require here will resolve the deps
// from our pre-populated cache.
const routeMod = require("@/app/api/resumes/route");
const POST: (req: Request) => Promise<Response> = routeMod.POST;

const prisma = new PrismaClient();

const tag = randomBytes(4).toString("hex");
const userId = `rfa-smoke-user-${tag}`;
const otherUserId = `rfa-smoke-other-${tag}`;
const watchlistIds: string[] = [];
const applicationIds: string[] = [];
const resumeIds: string[] = [];
const profileIds: string[] = [];

function buildPostRequest(body: unknown): Request {
    return new Request("http://test.invalid/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function main() {
    try {
        await prisma.user.create({ data: { id: userId, email: `rfa-smoke-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `rfa-smoke-other-${tag}@example.invalid` } });

        // Seed a profile + one work role so the route's "profile is empty"
        // guard passes (it fires AFTER the M8.4.5 guards, but the happy-path
        // case needs to reach the create step).
        const profile = await prisma.profile.create({ data: { userId } });
        profileIds.push(profile.id);
        await prisma.workRole.create({
            data: {
                profileId: profile.id,
                company: "Mock Co",
                title: "Engineer",
                startDate: new Date("2024-01-01"),
                bullets: JSON.stringify([{ id: "b-mock", text: "Did something with TypeScript", tags: ["typescript"], autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false }]),
            },
        });

        const watchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `rfa smoke ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({ kind: "careers-page", rootUrl: "https://example.invalid/careers/", linkPattern: "/c/", companyName: "Smoke Co" }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(watchlist.id);

        // Posting + applications for the four assertion paths:
        // 1. INTERESTED + posting+URL → happy path (200 expected)
        const postingValid = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `rfa-${tag}-valid`,
                company: "Pipeline Co",
                title: "Pipeline Engineer",
                sourceUrl: "https://example.invalid/jobs/pipeline",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });
        const appValid = await prisma.application.create({
            data: {
                userId,
                company: "Pipeline Co",
                normalizedCompany: `pipeline-co-${tag}`,
                role: "Pipeline Engineer",
                status: "INTERESTED",
                postingId: postingValid.id,
                lastUpdateAt: new Date(),
            },
        });
        applicationIds.push(appValid.id);

        // 2. APPLIED (non-INTERESTED) → 400 application-not-interested
        const postingApplied = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `rfa-${tag}-applied`,
                company: "Applied Co",
                title: "Applied Engineer",
                sourceUrl: "https://example.invalid/jobs/applied",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });
        const appApplied = await prisma.application.create({
            data: {
                userId,
                company: "Applied Co",
                normalizedCompany: `applied-co-${tag}`,
                role: "Applied Engineer",
                status: "APPLIED",
                postingId: postingApplied.id,
                lastUpdateAt: new Date(),
            },
        });
        applicationIds.push(appApplied.id);

        // 3. INTERESTED + posting with empty sourceUrl → 400 application-missing-url
        const postingUrlLess = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `rfa-${tag}-urlless`,
                company: "UrlLess Co",
                title: "UrlLess Engineer",
                sourceUrl: "",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });
        const appUrlLess = await prisma.application.create({
            data: {
                userId,
                company: "UrlLess Co",
                normalizedCompany: `urlless-co-${tag}`,
                role: "UrlLess Engineer",
                status: "INTERESTED",
                postingId: postingUrlLess.id,
                lastUpdateAt: new Date(),
            },
        });
        applicationIds.push(appUrlLess.id);

        // 4. Other user's app → 404 (cross-user)
        const otherWatchlist = await prisma.watchlist.create({
            data: {
                userId: otherUserId,
                name: `rfa smoke other ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({ kind: "careers-page", rootUrl: "https://example.invalid/other/", linkPattern: "/o/", companyName: "Other Co" }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(otherWatchlist.id);
        const otherPosting = await prisma.jobPosting.create({
            data: {
                watchlistId: otherWatchlist.id,
                externalId: `rfa-${tag}-other`,
                company: "Cross-User Co",
                title: "Cross-User Engineer",
                sourceUrl: "https://example.invalid/jobs/cross-user",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });
        const otherApp = await prisma.application.create({
            data: {
                userId: otherUserId,
                company: "Cross-User Co",
                normalizedCompany: `cross-user-co-${tag}`,
                role: "Cross-User Engineer",
                status: "INTERESTED",
                postingId: otherPosting.id,
                lastUpdateAt: new Date(),
            },
        });
        applicationIds.push(otherApp.id);

        // Set the mock session to the test user — all four paths run as `userId`.
        mockSessionUser = { id: userId, email: `rfa-smoke-${tag}@example.invalid` };

        // ─── Case 1: cross-user applicationId → 404 ───────────────────────
        const reqCrossUser = buildPostRequest({ posting: { applicationId: otherApp.id } });
        const resCrossUser = await POST(reqCrossUser);
        if (resCrossUser.status !== 404) {
            fail(`cross-user: expected 404, got ${resCrossUser.status}`);
            try { fail("  body:", await resCrossUser.json()); } catch { /* noop */ }
        } else {
            pass("cross-user: applicationId from another user → 404");
        }

        // Also verify no resume row was created for the wrong-user case.
        const wrongUserResumeCount = await prisma.generatedResume.count({ where: { userId } });
        if (wrongUserResumeCount !== 0) {
            fail(`cross-user: expected 0 resumes for our user after 404, got ${wrongUserResumeCount}`);
        } else {
            pass("cross-user: no GeneratedResume row created on 404");
        }

        // ─── Case 2: non-INTERESTED → 400 application-not-interested ─────
        const reqApplied = buildPostRequest({ posting: { applicationId: appApplied.id } });
        const resApplied = await POST(reqApplied);
        if (resApplied.status !== 400) {
            fail(`non-INTERESTED: expected 400, got ${resApplied.status}`);
        } else {
            const body = await resApplied.json();
            if (body.error !== "application-not-interested") {
                fail(`non-INTERESTED: expected error='application-not-interested', got ${JSON.stringify(body)}`);
            } else {
                pass("non-INTERESTED: 400 with error='application-not-interested'");
            }
            if (body.stage !== "input") fail(`non-INTERESTED: expected stage='input', got ${body.stage}`);
            else pass("non-INTERESTED: stage='input'");
        }

        // ─── Case 3: URL-less → 400 application-missing-url ──────────────
        const reqUrlLess = buildPostRequest({ posting: { applicationId: appUrlLess.id } });
        const resUrlLess = await POST(reqUrlLess);
        if (resUrlLess.status !== 400) {
            fail(`url-less: expected 400, got ${resUrlLess.status}`);
        } else {
            const body = await resUrlLess.json();
            if (body.error !== "application-missing-url") {
                fail(`url-less: expected error='application-missing-url', got ${JSON.stringify(body)}`);
            } else {
                pass("url-less: 400 with error='application-missing-url'");
            }
        }

        // ─── Case 4: happy path → 200 + GeneratedResume linked ───────────
        const reqHappy = buildPostRequest({ posting: { applicationId: appValid.id } });
        const resHappy = await POST(reqHappy);
        if (resHappy.status !== 200) {
            fail(`happy: expected 200, got ${resHappy.status}`);
            try { fail("  body:", await resHappy.json()); } catch { /* noop */ }
        } else {
            pass("happy: 200 OK with valid applicationId");

            // X-Resume-Id header should carry the new resume's id.
            const resumeIdHeader = resHappy.headers.get("X-Resume-Id");
            if (!resumeIdHeader) {
                fail("happy: X-Resume-Id header missing");
            } else {
                resumeIds.push(resumeIdHeader);
                pass(`happy: X-Resume-Id header present (${resumeIdHeader})`);

                // Verify the row was persisted with applicationId linked +
                // postingTitle + postingCompany set from the stub parse.
                const row = await prisma.generatedResume.findUnique({ where: { id: resumeIdHeader } });
                if (!row) {
                    fail("happy: GeneratedResume row not found after POST");
                } else {
                    if (row.applicationId !== appValid.id) {
                        fail(`happy: applicationId=${row.applicationId} expected ${appValid.id}`);
                    } else {
                        pass("happy: GeneratedResume.applicationId auto-linked to Pipeline App");
                    }
                    if (row.postingTitle !== "Mocked Title") {
                        fail(`happy: postingTitle=${row.postingTitle} expected 'Mocked Title'`);
                    } else {
                        pass("happy: GeneratedResume.postingTitle persisted from parsed posting");
                    }
                    if (row.postingCompany !== "Mocked Co") {
                        fail(`happy: postingCompany=${row.postingCompany} expected 'Mocked Co'`);
                    } else {
                        pass("happy: GeneratedResume.postingCompany persisted from parsed posting");
                    }
                    if (row.userId !== userId) {
                        fail(`happy: userId mismatch ${row.userId} vs ${userId}`);
                    } else {
                        pass("happy: GeneratedResume.userId matches session user");
                    }
                }
            }

            // X-Resume-Title / X-Resume-Company headers should also carry the
            // parsed metadata.
            if (resHappy.headers.get("X-Resume-Title") !== "Mocked Title") {
                fail(`happy: X-Resume-Title=${resHappy.headers.get("X-Resume-Title")} expected 'Mocked Title'`);
            } else {
                pass("happy: X-Resume-Title header set");
            }
            if (resHappy.headers.get("X-Resume-Company") !== "Mocked Co") {
                fail(`happy: X-Resume-Company=${resHappy.headers.get("X-Resume-Company")} expected 'Mocked Co'`);
            } else {
                pass("happy: X-Resume-Company header set");
            }
        }

        // ─── Case 5: bogus cuid (zod-validation level) → 400 ─────────────
        // This catches a regression where the route's posting.applicationId
        // refine is bypassed (the schema's .cuid() must reject non-cuid input).
        const reqBadCuid = buildPostRequest({ posting: { applicationId: "not-a-cuid" } });
        const resBadCuid = await POST(reqBadCuid);
        if (resBadCuid.status !== 400) {
            fail(`bad-cuid: expected 400 (zod rejection), got ${resBadCuid.status}`);
        } else {
            pass("bad-cuid: 400 on non-cuid applicationId (zod schema enforces format)");
        }
    } finally {
        for (const id of resumeIds) {
            await prisma.generatedResume.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of applicationIds) {
            await prisma.applicationEvent.deleteMany({ where: { applicationId: id } }).catch(() => undefined);
            await prisma.generatedResume.deleteMany({ where: { applicationId: id } }).catch(() => undefined);
            await prisma.application.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of profileIds) {
            await prisma.workRole.deleteMany({ where: { profileId: id } }).catch(() => undefined);
            await prisma.profile.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: otherUserId } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
