/**
 * Hermetic smoke for the Pipeline picker repository helper (M8.4.4, story S8.12).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/pipeline-picker-smoke.ts
 *
 * Exercises `findInterestedWithPostingForUser(userId)` directly — that helper
 * is what `app/api/applications/pipeline-picker/route.ts:GET` projects from.
 * Then re-runs the projection logic from the route to verify the wire shape.
 *
 * Setup: one user with four Apps to cover the inclusion/exclusion matrix:
 *   - APPLIED + posting+url        → excluded (wrong status)
 *   - INTERESTED + posting+url     → INCLUDED (the only valid row)
 *   - INTERESTED, no postingId     → excluded (manual-add / cold-email; Decision 6.4)
 *   - INTERESTED + posting, sourceUrl="" → excluded (URL-less defensive filter)
 * Plus a second user with a valid INTERESTED+url App → must NOT leak across
 * users.
 *
 * No HTTP, no PM2. Everything cleaned up in finally.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { findInterestedWithPostingForUser } from "@/lib/repositories/applications";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// State that lives across try / finally so cleanup can find what to delete.
const tag = randomBytes(4).toString("hex");
const userId = `pp-smoke-user-${tag}`;
const otherUserId = `pp-smoke-other-${tag}`;
const watchlistIds: string[] = [];
const applicationIds: string[] = [];

async function main() {
    try {
        await prisma.user.create({ data: { id: userId, email: `pp-smoke-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `pp-smoke-other-${tag}@example.invalid` } });

        const watchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `Pipeline-picker smoke ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: "https://example.invalid/careers/",
                    linkPattern: "/careers/jobs/",
                    companyName: "Smoke Co",
                }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(watchlist.id);

        const otherWatchlist = await prisma.watchlist.create({
            data: {
                userId: otherUserId,
                name: `Pipeline-picker smoke other ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: "https://example.invalid/other/",
                    linkPattern: "/other/jobs/",
                    companyName: "Other Co",
                }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(otherWatchlist.id);

        // Posting A: has sourceUrl, used by the INTERESTED+url App (INCLUDED).
        const postingValid = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `pp-${tag}-valid`,
                company: "Valid Co",
                title: "Senior Engineer",
                sourceUrl: "https://example.invalid/jobs/valid",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });

        // Posting B: paired with the APPLIED row — excluded by status, not URL.
        const postingApplied = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `pp-${tag}-applied`,
                company: "Applied Co",
                title: "Mid Engineer",
                sourceUrl: "https://example.invalid/jobs/applied",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });

        // Posting C: empty sourceUrl — the URL-less defensive filter case.
        // Schema has sourceUrl as non-null String, so we model "url-less" as
        // a zero-length string. The route's post-filter checks for length>0,
        // so this row is excluded.
        const postingUrlLess = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `pp-${tag}-urlless`,
                company: "UrlLess Co",
                title: "Junior Engineer",
                sourceUrl: "",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });

        // Cross-user posting, used by the other user's valid INTERESTED row.
        const otherUserPosting = await prisma.jobPosting.create({
            data: {
                watchlistId: otherWatchlist.id,
                externalId: `pp-${tag}-other`,
                company: "Other-User Co",
                title: "Should Not Appear",
                sourceUrl: "https://example.invalid/jobs/other-user",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });

        // App 1: APPLIED + posting+url → excluded
        const appApplied = await prisma.application.create({
            data: {
                userId,
                company: "Applied Co",
                normalizedCompany: `applied-co-${tag}`,
                role: "Mid Engineer",
                status: "APPLIED",
                track: "career",
                postingId: postingApplied.id,
                lastUpdateAt: new Date("2026-05-20T12:00:00Z"),
            },
        });
        applicationIds.push(appApplied.id);

        // App 2: INTERESTED + posting+url → INCLUDED (the only valid row).
        const appValid = await prisma.application.create({
            data: {
                userId,
                company: "Valid Co",
                normalizedCompany: `valid-co-${tag}`,
                role: "Senior Engineer",
                status: "INTERESTED",
                track: "career",
                postingId: postingValid.id,
                lastUpdateAt: new Date("2026-05-23T12:00:00Z"),
            },
        });
        applicationIds.push(appValid.id);

        // App 3: INTERESTED, no postingId → excluded (manual-add / cold-email)
        const appNoPosting = await prisma.application.create({
            data: {
                userId,
                company: "NoPosting Co",
                normalizedCompany: `noposting-co-${tag}`,
                role: "Engineer",
                status: "INTERESTED",
                track: "career",
                postingId: null,
                lastUpdateAt: new Date("2026-05-22T12:00:00Z"),
            },
        });
        applicationIds.push(appNoPosting.id);

        // App 4: INTERESTED + posting, sourceUrl="" → excluded
        const appUrlLess = await prisma.application.create({
            data: {
                userId,
                company: "UrlLess Co",
                normalizedCompany: `urlless-co-${tag}`,
                role: "Junior Engineer",
                status: "INTERESTED",
                track: "career",
                postingId: postingUrlLess.id,
                lastUpdateAt: new Date("2026-05-21T12:00:00Z"),
            },
        });
        applicationIds.push(appUrlLess.id);

        // Other user's INTERESTED+url App → excluded by user scope.
        const otherUserApp = await prisma.application.create({
            data: {
                userId: otherUserId,
                company: "Other-User Co",
                normalizedCompany: `other-user-co-${tag}`,
                role: "Should Not Appear",
                status: "INTERESTED",
                track: "career",
                postingId: otherUserPosting.id,
                lastUpdateAt: new Date("2026-05-24T12:00:00Z"),
            },
        });
        applicationIds.push(otherUserApp.id);

        // ─── Exercise the repo helper ─────────────────────────────────────
        const rawRows = await findInterestedWithPostingForUser(userId);
        // Helper returns rows with status=INTERESTED and a non-null postingId.
        // The route then post-filters for sourceUrl > 0.
        const repoExpected = new Set([appValid.id, appUrlLess.id]);
        const repoIds = new Set(rawRows.map(r => r.id));
        if (repoIds.size !== repoExpected.size || [...repoExpected].some(id => !repoIds.has(id))) {
            fail(`repo: expected ${[...repoExpected].join(",")}, got ${[...repoIds].join(",")}`);
        } else {
            pass("repo: returns exactly the two INTERESTED rows with a postingId (filters APPLIED + null-postingId + cross-user)");
        }

        // Each returned row should carry the posting projection (sourceUrl/title).
        let missingPosting = false;
        for (const r of rawRows) {
            if (!Object.prototype.hasOwnProperty.call(r, "posting")) {
                fail(`repo: row ${r.id} missing posting include`);
                missingPosting = true;
            }
        }
        if (!missingPosting) pass("repo: every row has the posting relation included");

        // ─── Route projection (mirrors GET /api/applications/pipeline-picker) ─
        const items = rawRows
            .filter(r => typeof r.posting?.sourceUrl === "string" && r.posting.sourceUrl.length > 0)
            .map(r => {
                const postingTitleRaw = r.posting?.title ?? "";
                const postingTitle = postingTitleRaw.trim().length > 0 ? postingTitleRaw : (r.role ?? "");
                return {
                    id: r.id,
                    company: r.company,
                    role: r.role,
                    postingUrl: r.posting!.sourceUrl,
                    postingTitle,
                    track: r.track,
                };
            });

        if (items.length !== 1) fail(`projection: expected exactly 1 item, got ${items.length}`);
        else pass("projection: exactly 1 item after URL-less filter");

        const only = items[0];
        if (only?.id !== appValid.id) fail(`projection: wrong item id ${only?.id}, expected ${appValid.id}`);
        else pass("projection: only item is the valid INTERESTED+url App");

        if (only?.postingUrl !== postingValid.sourceUrl) {
            fail(`projection: postingUrl=${only?.postingUrl} expected ${postingValid.sourceUrl}`);
        } else {
            pass("projection: postingUrl carried from posting.sourceUrl");
        }

        if (only?.postingTitle !== postingValid.title) {
            fail(`projection: postingTitle=${only?.postingTitle} expected ${postingValid.title}`);
        } else {
            pass("projection: postingTitle carried from posting.title (not falling back to role)");
        }

        if (only?.company !== appValid.company) {
            fail(`projection: company=${only?.company} expected ${appValid.company}`);
        } else {
            pass("projection: company carried from application");
        }

        // Track is surfaced so the client-side track filter (Career/Side/Both)
        // can pivot without a second roundtrip. Application.track defaults to
        // "career" — the row was created without specifying track.
        if (only?.track !== "career") {
            fail(`projection: track=${only?.track} expected "career" (schema default)`);
        } else {
            pass("projection: track carried from application (schema default 'career')");
        }

        // ─── Title-fallback case: posting.title is empty → fall back to app.role ─
        await prisma.jobPosting.update({
            where: { id: postingValid.id },
            data: { title: "" },
        });
        const rowsForFallback = await findInterestedWithPostingForUser(userId);
        const itemsFallback = rowsForFallback
            .filter(r => typeof r.posting?.sourceUrl === "string" && r.posting.sourceUrl.length > 0)
            .map(r => {
                const postingTitleRaw = r.posting?.title ?? "";
                const postingTitle = postingTitleRaw.trim().length > 0 ? postingTitleRaw : (r.role ?? "");
                return { id: r.id, postingTitle };
            });
        const fallbackItem = itemsFallback.find(i => i.id === appValid.id);
        if (fallbackItem?.postingTitle !== appValid.role) {
            fail(`fallback: postingTitle=${fallbackItem?.postingTitle} expected ${appValid.role}`);
        } else {
            pass("projection: empty posting.title falls back to application.role");
        }
        // Restore for the ordering test.
        await prisma.jobPosting.update({
            where: { id: postingValid.id },
            data: { title: "Senior Engineer" },
        });

        // ─── Ordering by lastUpdateAt desc ─────────────────────────────────
        // Add a SECOND valid INTERESTED+url row with a more-recent
        // lastUpdateAt so we can confirm it sorts above the existing one.
        const postingNewer = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `pp-${tag}-newer`,
                company: "Newer Co",
                title: "Newer Title",
                sourceUrl: "https://example.invalid/jobs/newer",
                status: "tracked",
                raw: JSON.stringify({}),
            },
        });
        const appNewer = await prisma.application.create({
            data: {
                userId,
                company: "Newer Co",
                normalizedCompany: `newer-co-${tag}`,
                role: "Newer Title",
                status: "INTERESTED",
                postingId: postingNewer.id,
                // Track override so the projection surfaces both "career" and
                // "side" — gives the client-side track filter (Career/Side/Both)
                // a real two-track dataset to exercise.
                track: "side",
                lastUpdateAt: new Date("2026-05-25T12:00:00Z"),
            },
        });
        applicationIds.push(appNewer.id);

        const orderedRows = await findInterestedWithPostingForUser(userId);
        const orderedItems = orderedRows
            .filter(r => typeof r.posting?.sourceUrl === "string" && r.posting.sourceUrl.length > 0);
        if (orderedItems.length !== 2) {
            fail(`ordering: expected 2 items, got ${orderedItems.length}`);
        } else if (orderedItems[0].id !== appNewer.id || orderedItems[1].id !== appValid.id) {
            fail(`ordering: expected [${appNewer.id}, ${appValid.id}], got [${orderedItems[0].id}, ${orderedItems[1].id}]`);
        } else {
            pass("ordering: rows sorted by lastUpdateAt desc (newest first)");
        }

        // Both tracks surface through the projection — what the Career/Side/Both
        // client-side filter operates on.
        const trackSet = new Set(orderedItems.map(r => r.track));
        if (trackSet.size !== 2 || !trackSet.has("career") || !trackSet.has("side")) {
            fail(`track coexistence: expected both career + side in projection, got ${[...trackSet].join(",")}`);
        } else {
            pass("track coexistence: career + side both present in projection (client-side filter has real data to slice)");
        }

        // ─── Cross-user isolation (defense-in-depth) ───────────────────────
        const otherRows = await findInterestedWithPostingForUser(otherUserId);
        const otherIds = otherRows.map(r => r.id);
        if (otherIds.includes(appValid.id) || otherIds.includes(appNewer.id)) {
            fail(`cross-user: other user can see our app ids: ${otherIds.join(",")}`);
        } else {
            pass("cross-user: other user's query does NOT include our valid apps");
        }
        if (otherIds.length !== 1 || otherIds[0] !== otherUserApp.id) {
            fail(`cross-user: other user's results unexpected: ${otherIds.join(",")}`);
        } else {
            pass("cross-user: other user sees only their own row");
        }
    } finally {
        for (const id of applicationIds) {
            await prisma.applicationEvent.deleteMany({ where: { applicationId: id } }).catch(() => undefined);
            await prisma.application.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
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
