/**
 * Hermetic-ish smoke for the stale-application nudge job.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/stale-nudge-smoke.ts
 *
 * Seeds a few applications with controlled lastUpdateAt timestamps, runs the
 * nudge job, and verifies the right ones got nudged (and the right ones
 * didn't). Cleans up after itself.
 */
import { PrismaClient } from "@prisma/client";
import { runStaleApplicationNudges } from "@/scheduler/jobs/stale-applications";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) { console.error("No user — log in first."); process.exit(1); }
    console.log(`Using user ${user.email}`);

    const createdAppIds: string[] = [];
    const createdNotifIds: string[] = [];

    try {
        // 1. Stale + non-terminal → SHOULD nudge
        const stale = await prisma.application.create({
            data: {
                userId: user.id, company: "Stale Co", role: "Engineer",
                status: "APPLIED", kind: "job",
                lastUpdateAt: daysAgo(20), // > 14 day threshold
            },
        });
        createdAppIds.push(stale.id);

        // 2. Stale + REJECTED → should NOT nudge (terminal)
        const rejected = await prisma.application.create({
            data: {
                userId: user.id, company: "Rejected Co", role: "Engineer",
                status: "REJECTED", kind: "job",
                lastUpdateAt: daysAgo(30),
            },
        });
        createdAppIds.push(rejected.id);

        // 3. Stale + OFFER → should NOT nudge (terminal)
        const offered = await prisma.application.create({
            data: {
                userId: user.id, company: "Offer Co", role: "Engineer",
                status: "OFFER", kind: "job",
                lastUpdateAt: daysAgo(30),
            },
        });
        createdAppIds.push(offered.id);

        // 4. Recent + non-terminal → should NOT nudge (not stale)
        const recent = await prisma.application.create({
            data: {
                userId: user.id, company: "Recent Co", role: "Engineer",
                status: "INTERVIEW", kind: "job",
                lastUpdateAt: daysAgo(3),
            },
        });
        createdAppIds.push(recent.id);

        // 5. Stale + already-nudged-recently → should NOT nudge (cooldown)
        const cooledDown = await prisma.application.create({
            data: {
                userId: user.id, company: "Cooled Co", role: "Engineer",
                status: "APPLIED", kind: "job",
                lastUpdateAt: daysAgo(20),
            },
        });
        createdAppIds.push(cooledDown.id);

        // Plant a recent stale-nudge notification for the cooled-down app
        const cooledNotif = await prisma.notification.create({
            data: {
                userId: user.id,
                kind: "application",
                tier: "standard",
                title: "Pre-existing nudge",
                body: null,
                payload: JSON.stringify({ applicationId: cooledDown.id, type: "stale-nudge" }),
                channels: "in_app",
                createdAt: daysAgo(3),
            },
        });
        createdNotifIds.push(cooledNotif.id);

        // Run the job
        const result = await runStaleApplicationNudges();
        console.log(`[run] processed=${result.processed} nudged=${result.nudged} cooled=${result.skippedCooldown}`);

        // Inspect what got nudged
        const nudges = await prisma.notification.findMany({
            where: {
                userId: user.id,
                kind: "application",
                payload: { contains: '"type":"stale-nudge"' },
                createdAt: { gt: daysAgo(0.001) }, // within the last few seconds
            },
        });
        for (const n of nudges) createdNotifIds.push(n.id);

        const nudgedAppIds = new Set<string>(
            nudges.map(n => {
                try {
                    const p = JSON.parse(n.payload) as { applicationId?: string };
                    return p.applicationId ?? "";
                } catch { return ""; }
            }),
        );

        // Assert: stale-non-terminal got nudged
        if (!nudgedAppIds.has(stale.id)) fail("stale non-terminal app should have been nudged");
        else pass("stale non-terminal app nudged");

        // Assert: rejected didn't
        if (nudgedAppIds.has(rejected.id)) fail("REJECTED app should NOT be nudged");
        else pass("REJECTED app skipped");

        // Assert: offered didn't
        if (nudgedAppIds.has(offered.id)) fail("OFFER app should NOT be nudged");
        else pass("OFFER app skipped");

        // Assert: recent didn't
        if (nudgedAppIds.has(recent.id)) fail("recent app should NOT be nudged");
        else pass("recent (< 14d) app skipped");

        // Assert: cooled-down didn't (and skippedCooldown > 0)
        if (nudgedAppIds.has(cooledDown.id)) fail("cooled-down app should NOT be re-nudged");
        else pass("cooled-down app skipped (cooldown working)");
        if (result.skippedCooldown < 1) fail("expected at least one cooldown skip");
        else pass(`cooldown counter = ${result.skippedCooldown}`);

        // Tier + dispatch shape sanity
        const realNudge = nudges.find(n => {
            try {
                return (JSON.parse(n.payload) as { applicationId?: string }).applicationId === stale.id;
            } catch { return false; }
        });
        if (!realNudge) return; // already failed above
        if (realNudge.tier !== "standard") fail(`nudge tier=${realNudge.tier}, expected 'standard'`);
        else pass("nudge has tier='standard'");
        if (realNudge.channels !== "in_app") fail(`nudge channels=${realNudge.channels}, expected 'in_app' (no email)`);
        else pass("nudge channels='in_app' (no email — too noisy weekly)");
    } finally {
        if (createdNotifIds.length > 0) {
            await prisma.notification.deleteMany({ where: { id: { in: createdNotifIds } } }).catch(() => undefined);
        }
        if (createdAppIds.length > 0) {
            await prisma.application.deleteMany({ where: { id: { in: createdAppIds } } }).catch(() => undefined);
        }
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => { console.error("Unhandled:", e); process.exit(2); });
