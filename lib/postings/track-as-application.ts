import { prisma } from "@/lib/prisma";
import { broadcastEvent } from "@/lib/events";

// Story 20: convert a tracked posting into a draft Application.
//
// Pulled out of the route handler so hermetic smokes can exercise the full
// behavior without a session cookie. The route is now a thin auth wrapper.
//
// Idempotency: if an Application already exists with `postingId = <id>` for
// this user, return it untouched. Otherwise create one with status='INTERESTED'
// + posting's company/role, link via postingId, write a NOTE event anchoring
// the timeline to "Tracked from posting" (with sourceUrl in notes), and flip
// the posting to status='tracked'. All in one transaction.

export type TrackResult =
    | { ok: true; created: boolean; applicationId: string; postingStatus: string }
    | { ok: false; reason: "posting-not-found" };

export async function trackAsApplication(
    userId: string,
    postingId: string,
): Promise<TrackResult> {
    const posting = await prisma.jobPosting.findFirst({
        where: { id: postingId, watchlist: { userId } },
        select: { id: true, company: true, title: true, status: true, sourceUrl: true },
    });
    if (!posting) return { ok: false, reason: "posting-not-found" };

    // Defensive: pin existing-app lookup to userId too. Today ownership is
    // enforced transitively via watchlist.user; in the future a posting could
    // theoretically be shared across users.
    const existing = await prisma.application.findFirst({
        where: { postingId: posting.id, userId },
        select: { id: true },
    });
    if (existing) {
        return {
            ok: true,
            created: false,
            applicationId: existing.id,
            postingStatus: posting.status,
        };
    }

    const now = new Date();
    const { application, updatedPosting } = await prisma.$transaction(async (tx) => {
        const application = await tx.application.create({
            data: {
                userId,
                company: posting.company,
                role: posting.title,
                status: "INTERESTED",
                kind: "job",
                postingId: posting.id,
                lastUpdateAt: now,
            },
        });
        // Anchor the timeline so drill-in shows when/where this came from.
        // NOTE kind keeps the event-kind enum stable; sourceUrl lives in notes.
        await tx.applicationEvent.create({
            data: {
                applicationId: application.id,
                kind: "NOTE",
                title: `Tracked from ${posting.company} posting`,
                occurredAt: now,
                notes: posting.sourceUrl,
            },
        });
        const updatedPosting = await tx.jobPosting.update({
            where: { id: posting.id },
            data: { status: "tracked" },
            select: { id: true, status: true },
        });
        return { application, updatedPosting };
    });

    broadcastEvent({ model: "Application", action: "upsert", id: application.id, timestamp: Date.now() });
    broadcastEvent({ model: "Posting", action: "upsert", id: updatedPosting.id, timestamp: Date.now() });

    return {
        ok: true,
        created: true,
        applicationId: application.id,
        postingStatus: updatedPosting.status,
    };
}
