/**
 * Pillar C → A cascade (closed-jobs feature, 2026-06-09).
 *
 * A confirmed-closed JobPosting closes its linked kanban card the same way
 * email ingest drives application state. `Application.postingId` (@unique) links
 * one application back to the posting it was tracked from, so a confirmed-closed
 * posting id maps directly to its card.
 *
 * One helper, two callers (provenance via `source`):
 *   - probe (auto)          — scheduler/jobs/job-watcher.ts, after the close
 *                             updateMany, source:"probe".
 *   - manual posting-close  — app/api/postings/[id]/route.ts PATCH, source:"ms".
 *
 * Cascade eligibility is INTERESTED-only (OQ7): the "I was watching, never
 * applied, it closed" case. It deliberately does NOT touch APPLIED / ASSESSMENT
 * / INTERVIEW* / OFFER / terminal cards — a listing routinely closes AFTER
 * you're already in the pipeline, so auto-closing those would bury live
 * applications. Because INTERESTED cards carry no newer status anchor, this
 * sidesteps the stale-status ordering problem entirely — no guard needed.
 */
import { prisma } from "@/lib/prisma";
import { broadcastEvent } from "@/lib/events";

export async function closeApplicationsForClosedPostings(
    postingIds: string[],
    opts: { at: Date; source: string },
): Promise<{ closedAppIds: string[] }> {
    if (postingIds.length === 0) return { closedAppIds: [] };

    // INTERESTED-only (OQ7). Select the candidates first so we can write a
    // per-app STATUS_CHANGED event capturing the from-status (always
    // INTERESTED here, but mirror the manual PATCH shape for symmetry).
    const candidates = await prisma.application.findMany({
        where: { postingId: { in: postingIds }, status: "INTERESTED" },
        select: { id: true, status: true },
    });

    const closedAppIds: string[] = [];
    for (const app of candidates) {
        // Re-assert status='INTERESTED' in the WHERE so a concurrent user
        // action (drag-to-Applied, etc.) during the probe window wins. updateMany
        // returns count=0 if the card already moved — skip the event in that case.
        const res = await prisma.application.updateMany({
            where: { id: app.id, status: "INTERESTED" },
            data: { status: "CLOSED", lastUpdateAt: opts.at },
        });
        if (res.count === 0) continue;

        await prisma.applicationEvent.create({
            data: {
                applicationId: app.id,
                kind: "STATUS_CHANGED",
                title: `Status: ${app.status} → CLOSED`,
                occurredAt: opts.at,
                fromStatus: app.status,
                toStatus: "CLOSED",
                syncSource: opts.source,
            },
        });
        broadcastEvent({ model: "Application", action: "upsert", id: app.id, timestamp: Date.now() });
        closedAppIds.push(app.id);
    }

    return { closedAppIds };
}
