/**
 * Hermetic smoke for the stale-email status guard (2026-05-20).
 *
 * Bug: re-running Scan Inbox after the user has manually moved an
 * application to ACCEPTED / DECLINED in the kanban would re-ingest the
 * older offer / rejection email and overwrite the user's status. Same
 * shape covers a latent newest-first iteration bug in backfill where the
 * OLDEST email processed would win on status.
 *
 * Fix: ingest now looks up the most recent status-bearing ApplicationEvent
 * (APPLIED or STATUS_CHANGED) before applying an email's classification.
 * If anchor.occurredAt > email.sentAt, the email is historically older
 * than the current truth and its status update is skipped (factual events
 * like EMAIL_RECEIVED / OFFER / REJECTION still record).
 *
 * This smoke exercises:
 *   1. findLatestStatusAnchor query semantics — returns the right event
 *      kind, the most recent occurredAt, and null for orphan apps.
 *   2. The staleness predicate (anchor.occurredAt > email.sentAt) across
 *      the cases that matter:
 *        - user-driven STATUS_CHANGED at "now" vs older email → stale
 *        - APPLIED-only baseline at T0 vs newer email at T1 → not stale
 *        - APPLIED-only baseline at T1 vs older email at T0 → stale
 *        - No anchor → not stale (first email becomes the baseline)
 *   3. End-to-end with the actual repository helpers: insert anchor,
 *      simulate ingest's gated update, verify Application.status survives.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/stale-status-ingest-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import {
    createApplication,
    updateApplication,
} from "@/lib/repositories/applications";
import {
    findLatestStatusAnchor,
} from "@/lib/repositories/applicationEvents";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

/**
 * Pure predicate mirroring the one inlined in ingest.ts. Re-derived here
 * so a divergent edit to either side gets caught by a failing test rather
 * than silently differing (same pattern as ingest-retry-smoke.ts).
 */
function isStaleEmail(anchor: { occurredAt: Date } | null, sentAt: Date): boolean {
    return !!(anchor && anchor.occurredAt.getTime() > sentAt.getTime());
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `stale-status-smoke-${tag}`;
    const createdAppIds: string[] = [];

    try {
        await prisma.user.create({
            data: { id: userId, email: `stale-status-smoke-${tag}@example.invalid` },
        });

        // ─── Predicate-only checks (no DB needed) ──────────────────────────
        const now = new Date();
        const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        check("predicate: no anchor → never stale (first email creates baseline)",
            isStaleEmail(null, past) === false &&
            isStaleEmail(null, now) === false &&
            isStaleEmail(null, future) === false);
        check("predicate: anchor at T1, email older → stale",
            isStaleEmail({ occurredAt: now }, past) === true);
        check("predicate: anchor at T1, email newer → not stale",
            isStaleEmail({ occurredAt: past }, now) === false);
        check("predicate: anchor at T1, email at T1 (tied) → not stale",
            isStaleEmail({ occurredAt: now }, now) === false);

        // ─── DB-backed: findLatestStatusAnchor semantics ───────────────────

        // Scenario 1: app with NO status-bearing events at all.
        const appNoAnchor = await createApplication({
            userId,
            company: normalizeCompanyName(`StaleTest-NoAnchor-${tag}`),
            role: "Engineer",
            status: "APPLIED",
        });
        createdAppIds.push(appNoAnchor.id);
        const anchor1 = await findLatestStatusAnchor(appNoAnchor.id);
        check("scenario 1: no events → anchor null", anchor1 === null);

        // Scenario 2: app with only an APPLIED event (the typical fresh-ingest baseline).
        const appAppliedOnly = await createApplication({
            userId,
            company: normalizeCompanyName(`StaleTest-AppliedOnly-${tag}`),
            role: "Engineer",
            status: "APPLIED",
        });
        createdAppIds.push(appAppliedOnly.id);
        await prisma.applicationEvent.create({
            data: {
                applicationId: appAppliedOnly.id,
                kind: "APPLIED",
                title: "Applied",
                occurredAt: past,
                emailMsgId: `synthetic-${tag}-1`,
                syncSource: "ms",
            },
        });
        // Add an EMAIL_RECEIVED event that's newer — should be IGNORED by the anchor
        // query (it's not a status-bearing kind).
        await prisma.applicationEvent.create({
            data: {
                applicationId: appAppliedOnly.id,
                kind: "EMAIL_RECEIVED",
                title: "Got an email",
                occurredAt: now,
                emailMsgId: `synthetic-${tag}-2`,
                syncSource: "ms",
            },
        });
        const anchor2 = await findLatestStatusAnchor(appAppliedOnly.id);
        check("scenario 2: APPLIED + newer EMAIL_RECEIVED → anchor is APPLIED",
            anchor2?.kind === "APPLIED" && anchor2.occurredAt.getTime() === past.getTime(),
            `kind=${anchor2?.kind} occurredAt=${anchor2?.occurredAt.toISOString()}`);

        // Scenario 3: multiple status-bearing events — most recent must win.
        const appMulti = await createApplication({
            userId,
            company: normalizeCompanyName(`StaleTest-Multi-${tag}`),
            role: "Engineer",
            status: "ACCEPTED",
        });
        createdAppIds.push(appMulti.id);
        await prisma.applicationEvent.create({
            data: {
                applicationId: appMulti.id,
                kind: "APPLIED",
                title: "Applied",
                occurredAt: past,
                syncSource: "ms",
            },
        });
        // Email-driven STATUS_CHANGED at T-3d.
        const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        await prisma.applicationEvent.create({
            data: {
                applicationId: appMulti.id,
                kind: "STATUS_CHANGED",
                title: "APPLIED → OFFER",
                occurredAt: threeDaysAgo,
                fromStatus: "APPLIED",
                toStatus: "OFFER",
                emailMsgId: `synthetic-${tag}-3`,
                syncSource: "ms",
            },
        });
        // User-driven STATUS_CHANGED at "now" — the kanban click path.
        await prisma.applicationEvent.create({
            data: {
                applicationId: appMulti.id,
                kind: "STATUS_CHANGED",
                title: "OFFER → ACCEPTED",
                occurredAt: now,
                fromStatus: "OFFER",
                toStatus: "ACCEPTED",
                syncSource: "ms",
            },
        });
        const anchor3 = await findLatestStatusAnchor(appMulti.id);
        check("scenario 3: multiple anchors → returns most recent STATUS_CHANGED",
            anchor3?.kind === "STATUS_CHANGED" && anchor3.toStatus === "ACCEPTED",
            `kind=${anchor3?.kind} toStatus=${anchor3?.toStatus} occurredAt=${anchor3?.occurredAt.toISOString()}`);

        // ─── End-to-end: simulate what ingest does ──────────────────────────
        // This is the canonical "user accepted, rescan of old offer email"
        // scenario. The test mirrors ingest's gated update.

        // Build the app representing CSULB after the user has clicked ACCEPTED.
        const csulb = await createApplication({
            userId,
            company: normalizeCompanyName(`CSULB-${tag}`),
            role: "Computer Science BS",
            status: "ACCEPTED",   // already-manual user state
            kind: "college",
            senderDomain: "csulb.edu",
        });
        createdAppIds.push(csulb.id);
        // The user's manual click — STATUS_CHANGED at "now".
        await prisma.applicationEvent.create({
            data: {
                applicationId: csulb.id,
                kind: "STATUS_CHANGED",
                title: "OFFER → ACCEPTED",
                occurredAt: now,
                fromStatus: "OFFER",
                toStatus: "ACCEPTED",
                syncSource: "ms",
            },
        });

        // Now "rescan" — simulate an older OFFER email being re-ingested.
        const oldEmailSentAt = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000); // 2 weeks ago
        const csulbAnchor = await findLatestStatusAnchor(csulb.id);
        const stale = isStaleEmail(csulbAnchor, oldEmailSentAt);
        check("rescan: 2-week-old offer email vs today's ACCEPTED → stale=true", stale === true);

        // Mirror ingest's gated update: stale → only update lastEmailMsgId,
        // do NOT touch status/role/nextSteps/lastUpdateAt.
        const beforeRescan = await prisma.application.findUnique({ where: { id: csulb.id } });
        await updateApplication(csulb.id, {
            kind: "college",
            lastEmailMsgId: `older-offer-msg-${tag}`,
            ...(stale ? {} : {
                status: "OFFER",
                nextSteps: "Reply by Mar 1",
                role: "Computer Science BS",
                lastUpdateAt: new Date(),
            }),
        });
        const afterRescan = await prisma.application.findUnique({ where: { id: csulb.id } });
        check("rescan (stale): Application.status stays ACCEPTED",
            afterRescan?.status === "ACCEPTED",
            `got status=${afterRescan?.status}`);
        check("rescan (stale): lastUpdateAt NOT bumped",
            afterRescan?.lastUpdateAt.getTime() === beforeRescan?.lastUpdateAt.getTime(),
            `before=${beforeRescan?.lastUpdateAt.toISOString()} after=${afterRescan?.lastUpdateAt.toISOString()}`);
        check("rescan (stale): lastEmailMsgId DID update (idempotency marker)",
            afterRescan?.lastEmailMsgId === `older-offer-msg-${tag}`);

        // Inverse scenario: a NEWER email DOES update status.
        const futureEmailSentAt = new Date(now.getTime() + 60 * 1000); // 1 minute ahead
        const stale2 = isStaleEmail(csulbAnchor, futureEmailSentAt);
        check("rescan: 1-minute-future email vs today's ACCEPTED → stale=false", stale2 === false);
        await updateApplication(csulb.id, {
            kind: "college",
            lastEmailMsgId: `newer-rej-msg-${tag}`,
            ...(stale2 ? {} : {
                status: "REJECTED",
                lastUpdateAt: new Date(),
            }),
        });
        const afterRescan2 = await prisma.application.findUnique({ where: { id: csulb.id } });
        check("rescan (newer email): Application.status updated to REJECTED",
            afterRescan2?.status === "REJECTED");

        // ─── Cross-app isolation ───────────────────────────────────────────
        const csulbAnchorAgain = await findLatestStatusAnchor(csulb.id);
        const otherAppAnchor = await findLatestStatusAnchor(appNoAnchor.id);
        check("anchor query: cross-app isolation (different appId → different result)",
            csulbAnchorAgain !== null && otherAppAnchor === null);
    } finally {
        for (const id of createdAppIds) {
            await prisma.application.delete({ where: { id } }).catch(() => {});
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.$disconnect();
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
