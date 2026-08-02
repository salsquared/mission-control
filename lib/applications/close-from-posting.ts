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
 *
 * `postingIds` is a REQUEST, not a licence (2026-08-02). Every caller checks
 * the posting's own state before calling — the two job-watcher call sites pass
 * the ids they *asked* to confirm closed, and the PATCH route flips the row
 * first — but the ids a caller asked about and the postings that are ACTUALLY
 * closed are not the same set. job-watcher's confirm `updateMany` re-asserts
 * `status notIn [closed, hidden]` and the OQ5a time window in its WHERE, so a
 * concurrent run (web tier vs scheduler — the per-watchlist mutex is
 * per-process) clearing the pending stamp on alive evidence, or the user
 * clicking "Hide" mid-probe-round, correctly leaves the posting OPEN and
 * reports `closed = 0`. But it then passes the UNFILTERED id list here. So the
 * posting's status is re-read below rather than trusted from the argument:
 * without it the kanban card moved INTERESTED → CLOSED off a close that never
 * happened — silently, since the summary notification is gated on `closed > 0`.
 * Same guard `reconcileClosedPostingCascade` already applies to its sweep.
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
    // `userId` is selected purely to scope the SSE broadcast below. It is NOT
    // threaded in as a parameter, because `postingIds` is not guaranteed to
    // belong to one user — the manual PATCH caller passes a single posting, but
    // the probe caller passes a batch — so the owner has to be read per row.
    //
    // `posting: { is: { status: "closed" } }` is the confirm guard (see the
    // header): only a posting that is closed RIGHT NOW cascades, whoever asked.
    // The relation is nullable (`Application.postingId String?`), and on a
    // nullable to-one an `is` filter matches nothing when the FK is null — but
    // no legitimate row is dropped, because `postingId: { in: postingIds }`
    // already excludes null-FK rows by construction. Fixing it here rather than
    // at the two job-watcher call sites also covers the manual PATCH path
    // (app/api/postings/[id]/route.ts, which flips the row to "closed" before
    // calling and so still matches) in one place.
    const candidates = await prisma.application.findMany({
        where: {
            postingId: { in: postingIds },
            status: "INTERESTED",
            posting: { is: { status: "closed" } },
        },
        select: { id: true, status: true, userId: true },
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
        broadcastEvent({ model: "Application", action: "upsert", id: app.id, userId: app.userId, timestamp: Date.now() });
        closedAppIds.push(app.id);
    }

    return { closedAppIds };
}
