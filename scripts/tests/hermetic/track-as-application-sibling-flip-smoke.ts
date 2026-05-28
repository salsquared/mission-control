/**
 * Hermetic smoke: tracking a posting flips its discovery siblings.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/track-as-application-sibling-flip-smoke.ts
 *
 * Two related guarantees, both rooted in postingDedupKey (normalizedCompany +
 * normalizedRole):
 *
 *   Part A (no DB) — the key itself: collapses the same job across sourceUrl
 *   drift, title-punctuation drift, legal-suffix drift, and employment-modality
 *   noise; but keeps genuine multi-role postings (Studio vs Mall Patrol) and
 *   genuinely-different company strings distinct.
 *
 *   Part B (DB) — flip-the-siblings: N overlapping watchlists each store their
 *   own JobPosting row for one job (per-watchlist unique key). Tracking ONE
 *   must flip EVERY same-key sibling still in the feed to status='tracked' —
 *   even ones whose externalId differs (URL repost) — so the job leaves
 *   discovery wholesale. Scoped to the same track: a career-track row with the
 *   same company+role must NOT flip when a side-track posting is tracked.
 *
 * No HTTP, no PM2. Everything cleaned up in finally.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { trackAsApplication } from "@/lib/postings/track-as-application";
import { postingDedupKey } from "@/lib/postings/dedup-key";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `flip-smoke-user-${tag}`;
    const watchlistIds: string[] = [];
    const applicationIds: string[] = [];

    try {
        // ─── Part A: postingDedupKey identity rules (no DB) ───
        const base = postingDedupKey("Allied Universal", "Security Officer Studio Patrol");
        if (postingDedupKey("Allied Universal", "Security Officer - Studio Patrol") !== base)
            fail("key: title punctuation drift should collapse");
        else pass("key: 'Officer - Studio' == 'Officer Studio' (punctuation drift)");
        if (postingDedupKey("Allied Universal, Inc.", "Security Officer Studio Patrol") !== base)
            fail("key: legal-suffix drift should collapse");
        else pass("key: 'Allied Universal, Inc.' == 'Allied Universal' (suffix drift)");
        if (postingDedupKey("Allied Universal", "Security Officer Part Time Studio Patrol") !== base)
            fail("key: employment-modality noise should collapse");
        else pass("key: 'Part Time Studio Patrol' == 'Studio Patrol' (modality noise)");
        if (postingDedupKey("Allied Universal", "Security Officer Mall Patrol") === base)
            fail("key: distinct role 'Mall Patrol' must NOT collapse into 'Studio Patrol'");
        else pass("key: 'Mall Patrol' != 'Studio Patrol' (multi-role preserved)");
        if (postingDedupKey("Allied Universal Security Services", "Security Officer Studio Patrol") === base)
            fail("key: distinct company words must NOT collapse (no over-merge)");
        else pass("key: 'Allied Universal Security Services' != 'Allied Universal' (no over-merge)");

        // ─── Part B setup: one user, 3 overlapping side watchlists + 1 career ───
        await prisma.user.create({ data: { id: userId, email: `flip-smoke-${tag}@example.invalid` } });

        async function makeWatchlist(name: string, track: string): Promise<string> {
            const w = await prisma.watchlist.create({
                data: {
                    userId, name, kind: "linkedin", track,
                    config: JSON.stringify({ kind: "linkedin", keywords: "security officer", companyName: "n/a" }),
                    scheduleMinutes: 60,
                },
            });
            watchlistIds.push(w.id);
            return w.id;
        }
        const wlDowney = await makeWatchlist(`flip Downey ${tag}`, "side");
        const wlLA = await makeWatchlist(`flip LA ${tag}`, "side");
        const wlCA = await makeWatchlist(`flip CA ${tag}`, "side");
        const wlCareer = await makeWatchlist(`flip Career ${tag}`, "career");

        async function makePosting(watchlistId: string, externalId: string, company: string, title: string, url: string): Promise<string> {
            const p = await prisma.jobPosting.create({
                data: {
                    watchlistId, externalId, company, title,
                    sourceUrl: url, status: "new", raw: "{}",
                },
            });
            return p.id;
        }

        // Same underlying job in all 3 side watchlists — DIFFERENT externalId
        // (different sourceUrl) AND drifted company/title strings, to prove the
        // flip keys on the normalized identity, not externalId.
        const pDowney = await makePosting(wlDowney, `flip-${tag}-a`, "Allied Universal", "Security Officer Studio Patrol", `https://x.invalid/${tag}/a`);
        const pLA = await makePosting(wlLA, `flip-${tag}-b`, "Allied Universal", "Security Officer - Studio Patrol", `https://x.invalid/${tag}/b`);
        const pCA = await makePosting(wlCA, `flip-${tag}-c`, "Allied Universal, Inc.", "Security Officer Part Time Studio Patrol", `https://x.invalid/${tag}/c`);
        // A genuinely different role in an overlapping watchlist — must NOT flip.
        const pMall = await makePosting(wlLA, `flip-${tag}-d`, "Allied Universal", "Security Officer Mall Patrol", `https://x.invalid/${tag}/d`);
        // Same job, but career track — must NOT flip (cross-track isolation).
        const pCareer = await makePosting(wlCareer, `flip-${tag}-e`, "Allied Universal", "Security Officer Studio Patrol", `https://x.invalid/${tag}/e`);

        // Track the Downey row.
        const r = await trackAsApplication(userId, pDowney);
        if (!r.ok) return fail("track: posting-not-found unexpected", r);
        if (!r.created) fail("track: expected created=true on first track");
        else pass("track: created a new Application");
        applicationIds.push(r.applicationId);

        const status = async (id: string) => (await prisma.jobPosting.findUnique({ where: { id }, select: { status: true } }))?.status;

        if (await status(pDowney) !== "tracked") fail("clicked posting (Downey) should be tracked");
        else pass("clicked posting flipped to tracked");
        if (await status(pLA) !== "tracked") fail("LA sibling (title drift) should flip to tracked");
        else pass("sibling flipped: title-punctuation drift (LA)");
        if (await status(pCA) !== "tracked") fail("CA sibling (suffix + modality drift, diff externalId) should flip");
        else pass("sibling flipped: suffix + modality drift, different externalId (CA)");
        if (await status(pMall) !== "new") fail("Mall Patrol (distinct role) must stay new");
        else pass("distinct role NOT flipped (Mall Patrol stays new)");
        if (await status(pCareer) !== "new") fail("career-track row must stay new (cross-track isolation)");
        else pass("cross-track row NOT flipped (career stays new)");
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
