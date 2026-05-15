/**
 * Stale-application nudges (story 49, MA-f.4 / MB-3.2).
 *
 * Daily tick. Finds applications where:
 *   - status isn't terminal (REJECTED / OFFER — no point pinging the user
 *     about a rejected app, or asking them to follow up on something they
 *     already got)
 *   - lastUpdateAt < now - STALE_AFTER_DAYS (default 14)
 *   - no existing un-dismissed stale-nudge notification fired for this app
 *     in the last NUDGE_COOLDOWN_DAYS (default 7) — keeps the user from
 *     seeing the same nudge every day
 *
 * Dispatches via the central notification API (lib/notifications/dispatch.ts)
 * at tier='standard' kind='application' so the row shows up in the bell but
 * doesn't trigger an email (it'd be too noisy weekly).
 */
import { prisma } from "@/lib/prisma";
import { dispatchNotification } from "@/lib/notifications/dispatch";

const STALE_AFTER_DAYS = 14;
const NUDGE_COOLDOWN_DAYS = 7;
// Terminal statuses we never nudge for — the user already has closure.
const TERMINAL_STATUSES = ["REJECTED", "OFFER"];

export interface StaleNudgeRunResult {
    processed: number;
    nudged: number;
    skippedCooldown: number;
}

function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

export async function runStaleApplicationNudges(): Promise<StaleNudgeRunResult> {
    const staleCutoff = daysAgo(STALE_AFTER_DAYS);
    const cooldownCutoff = daysAgo(NUDGE_COOLDOWN_DAYS);

    const candidates = await prisma.application.findMany({
        where: {
            status: { notIn: TERMINAL_STATUSES },
            lastUpdateAt: { lt: staleCutoff },
        },
        select: {
            id: true,
            userId: true,
            company: true,
            role: true,
            lastUpdateAt: true,
        },
    });

    let nudged = 0;
    let skippedCooldown = 0;

    for (const app of candidates) {
        // Check cooldown: did we already nudge for this application recently?
        // payload.applicationId is a JSON field — fetch with a contains query
        // (SQLite JSON fields are stored as TEXT, so `contains` works on the
        // stringified payload).
        const recent = await prisma.notification.findFirst({
            where: {
                userId: app.userId,
                kind: "application",
                createdAt: { gte: cooldownCutoff },
                dismissedAt: null,
                AND: [
                    { payload: { contains: '"type":"stale-nudge"' } },
                    { payload: { contains: `"applicationId":"${app.id}"` } },
                ],
            },
            select: { id: true },
        });
        if (recent) {
            skippedCooldown++;
            continue;
        }

        const daysSinceUpdate = Math.floor(
            (Date.now() - app.lastUpdateAt.getTime()) / (24 * 60 * 60 * 1000),
        );
        const roleLabel = app.role ? `${app.role} at ${app.company}` : app.company;

        try {
            await dispatchNotification({
                userId: app.userId,
                tier: "standard",
                kind: "application",
                title: `No update from ${app.company} in ${daysSinceUpdate} days`,
                body: `Your application for ${roleLabel} hasn't moved in ${daysSinceUpdate} days. Consider drafting a follow-up.`,
                payload: {
                    applicationId: app.id,
                    type: "stale-nudge",
                    daysSinceUpdate,
                },
            });
            nudged++;
        } catch (e) {
            console.warn(`[stale-applications] dispatch failed for ${app.id}:`, e);
        }
    }

    return { processed: candidates.length, nudged, skippedCooldown };
}
