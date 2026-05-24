/**
 * Hermetic smoke for deadline-nudges (story S6.3 — decision-deadline piece).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/deadline-nudge-smoke.ts
 *
 * Creates a scratch user + several Applications with various decisionDeadline
 * values, runs `runDeadlineNudges()`, asserts:
 *   - app with deadline today → nudge fired
 *   - app with deadline +2d → nudge fired
 *   - app with deadline +30d (outside window) → no nudge
 *   - app with deadline -2d (past grace) → no nudge
 *   - app with no decisionDeadline → no nudge
 *   - app in OFFER status → no nudge (terminal)
 *   - app in REJECTED status → no nudge (terminal)
 *   - re-run inside the cooldown window → no duplicate nudge
 *
 * No HTTP / no session.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { runDeadlineNudges } from "@/scheduler/jobs/deadline-nudges";

const prisma = new PrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;
let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function daysFromNow(n: number): Date { return new Date(Date.now() + n * DAY_MS); }

async function nudgeCountForApp(userId: string, appId: string): Promise<number> {
    return prisma.notification.count({
        where: {
            userId,
            kind: "application",
            AND: [
                { payload: { contains: '"type":"deadline-approaching"' } },
                { payload: { contains: `"applicationId":"${appId}"` } },
            ],
        },
    });
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `deadline-smoke-user-${tag}`;
    const appIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `deadline-smoke-${tag}@example.invalid` } });

        const mk = async (label: string, deadline: Date | null, status: string) => {
            const a = await prisma.application.create({
                data: {
                    userId, company: `Co-${label}`, role: "Engineer",
                    status, kind: "job",
                    decisionDeadline: deadline,
                },
            });
            appIds.push(a.id);
            return a.id;
        };

        const idToday = await mk("today", new Date(), "APPLIED");
        const idIn2 = await mk("in2", daysFromNow(2), "INTERVIEW");
        const idIn30 = await mk("in30", daysFromNow(30), "APPLIED");
        const idPast = await mk("past", daysFromNow(-2), "APPLIED");
        const idNoDeadline = await mk("none", null, "APPLIED");
        const idOffer = await mk("offer", daysFromNow(1), "OFFER");
        const idRejected = await mk("rejected", daysFromNow(1), "REJECTED");

        // ─── First run ───
        const r1 = await runDeadlineNudges();
        if (r1.nudged < 2) fail(`first run: expected ≥ 2 nudged (today + in2d), got ${r1.nudged}`);
        else pass(`first run: nudged ${r1.nudged} app(s)`);

        if ((await nudgeCountForApp(userId, idToday)) !== 1) fail("today: expected 1 nudge");
        else pass("deadline=today → nudge fired");
        if ((await nudgeCountForApp(userId, idIn2)) !== 1) fail("in2d: expected 1 nudge");
        else pass("deadline=+2d → nudge fired");
        if ((await nudgeCountForApp(userId, idIn30)) !== 0) fail("in30d: expected 0 nudges (outside 3d window)");
        else pass("deadline=+30d → no nudge (outside 3d window)");
        if ((await nudgeCountForApp(userId, idPast)) !== 0) fail("past: expected 0 nudges (outside 1d grace)");
        else pass("deadline=-2d → no nudge (past 1d grace)");
        if ((await nudgeCountForApp(userId, idNoDeadline)) !== 0) fail("none: expected 0 nudges (no deadline set)");
        else pass("no decisionDeadline → no nudge");
        if ((await nudgeCountForApp(userId, idOffer)) !== 0) fail("offer: expected 0 nudges (terminal)");
        else pass("status=OFFER → no nudge (terminal)");
        if ((await nudgeCountForApp(userId, idRejected)) !== 0) fail("rejected: expected 0 nudges (terminal)");
        else pass("status=REJECTED → no nudge (terminal)");

        // ─── Second run: cooldown ───
        const r2 = await runDeadlineNudges();
        if (r2.nudged !== 0) fail(`second run: expected 0 nudged, got ${r2.nudged}`);
        else pass("second run inside cooldown: 0 new nudges");
        if ((await nudgeCountForApp(userId, idToday)) !== 1) fail("today: cooldown broke — duplicate nudge");
        else pass("cooldown holds: today still has exactly 1 nudge");

        // ─── Past nudge title sanity-check (regression for the "passed Nd ago" branch) ───
        const titleToday = (await prisma.notification.findFirst({
            where: { userId, kind: "application", AND: [{ payload: { contains: '"type":"deadline-approaching"' } }, { payload: { contains: `"applicationId":"${idToday}"` } }] },
            select: { title: true },
        }))?.title;
        if (!titleToday?.toLowerCase().includes("today")) fail(`today nudge title doesn't mention "today": ${titleToday}`);
        else pass("today nudge title contains 'today'");

        const titleIn2 = (await prisma.notification.findFirst({
            where: { userId, kind: "application", AND: [{ payload: { contains: '"type":"deadline-approaching"' } }, { payload: { contains: `"applicationId":"${idIn2}"` } }] },
            select: { title: true, id: true },
        }));
        if (!titleIn2?.title?.includes("2 days") && !titleIn2?.title?.includes("1 day") && !titleIn2?.title?.includes("3 days")) {
            fail(`in2d nudge title doesn't reflect days-out: ${titleIn2?.title}`);
        } else pass("in2d nudge title reflects days-out");

        // ─── Dismissed cooldown regression (review bug #5) ───
        // Pre-fix, the cooldown query filtered dismissedAt: null, so
        // dismissing the nudge would let it re-fire on the next daily run.
        // Post-fix, the cooldown holds regardless of dismiss state. Simulate
        // by marking the existing nudge dismissed and re-running.
        if (titleIn2?.id) {
            await prisma.notification.update({
                where: { id: titleIn2.id },
                data: { dismissedAt: new Date() },
            });
            const r3 = await runDeadlineNudges();
            if (r3.nudged !== 0) fail(`dismissed cooldown: expected 0 new nudges, got ${r3.nudged}`);
            else pass("dismissed cooldown: dismiss does NOT reset the cooldown");
            if ((await nudgeCountForApp(userId, idIn2)) !== 1) fail("dismissed cooldown: duplicate nudge created");
            else pass("dismissed cooldown: still exactly 1 nudge in DB");
        }
    } finally {
        await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
        for (const id of appIds) {
            await prisma.applicationEvent.deleteMany({ where: { applicationId: id } }).catch(() => undefined);
            await prisma.application.delete({ where: { id } }).catch(() => undefined);
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
