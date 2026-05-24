/**
 * Decision-deadline nudges (story S6.3 — last remaining piece).
 *
 * Daily tick. Finds applications where:
 *   - status isn't terminal (REJECTED / OFFER — the decision is already made)
 *   - decisionDeadline is set
 *   - decisionDeadline is within the next DEADLINE_WINDOW_DAYS (3) — including
 *     deadlines that have just passed within the last 24h (so a user who set
 *     a deadline at 11pm yesterday still gets one final nudge today)
 *   - no existing un-dismissed deadline-nudge notification for this app fired
 *     in the last NUDGE_COOLDOWN_DAYS (2 — these are time-sensitive, so the
 *     cooldown is shorter than stale-nudge's 7-day window)
 *
 * Dispatches at tier='standard' kind='application'. Standard tier surfaces in
 * the bell with prominence; channels default to in-app + email (the user is
 * about to miss a deadline — worth flagging strongly).
 */
import { prisma } from "@/lib/prisma";
import { dispatchNotification, utcDateBucket } from "@/lib/notifications/dispatch";

const DEADLINE_WINDOW_DAYS = 3;
const NUDGE_COOLDOWN_DAYS = 2;
const PAST_GRACE_DAYS = 1;
const TERMINAL_STATUSES = ["REJECTED", "OFFER", "ACCEPTED", "DECLINED"];
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeadlineNudgeRunResult {
    processed: number;
    nudged: number;
    skippedCooldown: number;
}

function daysAgo(n: number): Date {
    return new Date(Date.now() - n * DAY_MS);
}
function daysFromNow(n: number): Date {
    return new Date(Date.now() + n * DAY_MS);
}

export async function runDeadlineNudges(): Promise<DeadlineNudgeRunResult> {
    const cooldownCutoff = daysAgo(NUDGE_COOLDOWN_DAYS);
    const lowerBound = daysAgo(PAST_GRACE_DAYS);
    const upperBound = daysFromNow(DEADLINE_WINDOW_DAYS);

    const candidates = await prisma.application.findMany({
        where: {
            status: { notIn: TERMINAL_STATUSES },
            decisionDeadline: {
                not: null,
                gte: lowerBound,
                lte: upperBound,
            },
        },
        select: {
            id: true, userId: true, company: true, role: true, decisionDeadline: true,
        },
    });

    let nudged = 0;
    let skippedCooldown = 0;

    for (const app of candidates) {
        if (!app.decisionDeadline) continue; // narrowing — the where already filtered

        // Cooldown holds even if the user dismissed the prior nudge — the
        // dismiss means "I saw it," not "send me another tomorrow."
        const recent = await prisma.notification.findFirst({
            where: {
                userId: app.userId,
                kind: "application",
                createdAt: { gte: cooldownCutoff },
                AND: [
                    { payload: { contains: '"type":"deadline-approaching"' } },
                    { payload: { contains: `"applicationId":"${app.id}"` } },
                ],
            },
            select: { id: true },
        });
        if (recent) {
            skippedCooldown++;
            continue;
        }

        const msUntil = app.decisionDeadline.getTime() - Date.now();
        const daysUntil = Math.round(msUntil / DAY_MS);
        const roleLabel = app.role ? `${app.role} at ${app.company}` : app.company;
        let title: string;
        if (daysUntil < 0) {
            title = `Decision deadline for ${app.company} passed ${Math.abs(daysUntil)}d ago`;
        } else if (daysUntil === 0) {
            title = `Decision deadline for ${app.company} is today`;
        } else {
            title = `Decision deadline for ${app.company} in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
        }

        try {
            const result = await dispatchNotification({
                userId: app.userId,
                tier: "standard",
                kind: "application",
                title,
                body: `Decision on ${roleLabel} is due ${app.decisionDeadline.toISOString().slice(0, 10)}.`,
                payload: {
                    applicationId: app.id,
                    type: "deadline-approaching",
                    decisionDeadline: app.decisionDeadline.toISOString(),
                    daysUntil,
                },
                dedupKey: `deadline:${app.id}:${utcDateBucket()}`,
            });
            if (result) nudged++;
            else skippedCooldown++;
        } catch (e) {
            console.warn(`[deadline-nudges] dispatch failed for ${app.id}:`, e);
        }
    }

    return { processed: candidates.length, nudged, skippedCooldown };
}
