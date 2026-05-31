import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { broadcastEvent } from "@/lib/events";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";
import { normalizeRoleName } from "@/lib/applications/normalize-role";
import { postingDedupKey } from "@/lib/postings/dedup-key";
import {
    findApplicationByCompanyAndRole,
    findApplicationBySourceJobId,
} from "@/lib/repositories/applications";

// Story S5.5: convert a tracked posting into a draft Application.
//
// Pulled out of the route handler so hermetic smokes can exercise the full
// behavior without a session cookie. The route is now a thin auth wrapper.
//
// Dedup chain (most → least specific; 2026-05-27 multi-role-per-company):
//
//   1. Application.postingId == posting.id (the literal "same posting twice"
//      click). Idempotent return, no writes.
//
//   2. Application.sourceJobId == posting.externalId, same userId. The user
//      tracked the same job via a different posting row (e.g. scraped into
//      two different watchlists, or the prior posting was re-fetched with a
//      new internal id). Merge-link semantics — see below.
//
//   3. (userId, normalizedCompany, normalizedRole, watchlist.track) match.
//      The user has already opened an application for THIS role at THIS
//      company on THIS kanban — likely via a different posting URL or a
//      manual add. Merge-link semantics — see below.
//
//   4. No match → create a new Application with status='INTERESTED', link
//      via postingId, write a NOTE event anchoring the timeline to
//      "Tracked from posting" (sourceUrl in notes), flip posting → 'tracked'.
//      All in one transaction.
//
// Merge-link semantics (cases 2 and 3): we DO NOT overwrite the existing
// Application.postingId. If the existing app has no postingId, we set it
// to this posting (link). Either way we add a NOTE event referencing this
// posting's sourceUrl (so the timeline records "user saw posting X for
// this role") and flip the new posting to status='tracked' so it leaves
// discovery. Return created=false. The user can manually re-pick which
// posting they want as the primary linkage if needed.

export type TrackResult =
    | { ok: true; created: boolean; merged: boolean; applicationId: string; postingStatus: string }
    | { ok: false; reason: "posting-not-found" };

export async function trackAsApplication(
    userId: string,
    postingId: string,
): Promise<TrackResult> {
    const posting = await prisma.jobPosting.findFirst({
        where: { id: postingId, watchlist: { userId } },
        // MB Phase 4: pull the parent watchlist's track so the created
        // Application lands in the correct kanban. Side-track postings (from
        // keyword watchlists like "warehouse Los Angeles") become side-track
        // applications; career-track postings stay career.
        select: {
            id: true, company: true, title: true, status: true, sourceUrl: true, externalId: true,
            watchlist: { select: { track: true, canonId: true } },
        },
    });
    if (!posting) return { ok: false, reason: "posting-not-found" };

    // Case 1: same posting twice (postingId match). The findFirst is pinned
    // to userId; ownership today is transitive via watchlist.user but a
    // future cross-user share would still be safe.
    const sameposting = await prisma.application.findFirst({
        where: { postingId: posting.id, userId },
        select: { id: true },
    });
    if (sameposting) {
        return {
            ok: true,
            created: false,
            merged: false,
            applicationId: sameposting.id,
            postingStatus: posting.status,
        };
    }

    // Cases 2 + 3: high-precision sourceJobId match, then (company, role,
    // track) match. Both end in the merge-link branch below.
    let existing: { id: string; postingId: string | null } | null = null;
    if (posting.externalId) {
        const bySourceJob = await findApplicationBySourceJobId(userId, posting.externalId);
        if (bySourceJob) existing = { id: bySourceJob.id, postingId: bySourceJob.postingId };
    }
    if (!existing) {
        const byCompanyRole = await findApplicationByCompanyAndRole(
            userId,
            posting.company,
            posting.title,
            posting.watchlist.track,
        );
        if (byCompanyRole) existing = { id: byCompanyRole.id, postingId: byCompanyRole.postingId };
    }

    if (existing) {
        // Merge-link. Don't overwrite postingId if one's already set —
        // preserve the user's original linkage decision. Either way, log
        // the additional posting URL in the timeline so the merge is
        // discoverable, and flip the new posting to "tracked" so it leaves
        // discovery.
        const merged = await mergeLinkExistingApplication(
            existing,
            posting,
            userId,
        );
        broadcastEvent({ model: "Application", action: "upsert", id: merged.applicationId, timestamp: Date.now() });
        broadcastEvent({ model: "Posting", action: "upsert", id: merged.postingId, timestamp: Date.now() });
        return {
            ok: true,
            created: false,
            merged: true,
            applicationId: merged.applicationId,
            postingStatus: merged.postingStatus,
        };
    }

    // Case 4: brand-new application. Build the row, anchor the timeline,
    // flip the posting — all transactional. Race-recovery on P2002 (a
    // concurrent track-as-application + Gmail ingest colliding on the new
    // (userId, normalizedCompany, normalizedRole, track) unique) falls back
    // to the same merge-link branch above.
    const now = new Date();
    let application: { id: string };
    let updatedPosting: { id: string; status: string };
    try {
        const txResult = await prisma.$transaction(async (tx) => {
            const application = await tx.application.create({
                data: {
                    userId,
                    company: posting.company,
                    // 2026-05-27: write both normalized keys inline. The
                    // createApplication helper would do this automatically,
                    // but we're inside tx.application.create to keep the
                    // posting flip + event insert atomic, so we mirror it
                    // here. Missing either key would defeat dedup.
                    normalizedCompany: normalizeCompanyName(posting.company),
                    normalizedRole: normalizeRoleName(posting.title),
                    role: posting.title,
                    status: "INTERESTED",
                    kind: "job",
                    track: posting.watchlist.track,
                    // §6 Q4 — inherit the feeding watchlist's canon tag, if set,
                    // so jobs from a role-watchlist land on the right canon.
                    canonId: posting.watchlist.canonId ?? null,
                    postingId: posting.id,
                    // High-precision dedup hint for "same job, different
                    // posting row" — populated from the source ATS's stable
                    // identifier.
                    sourceJobId: posting.externalId ?? null,
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
            await flipSiblingPostings(tx, userId, {
                id: posting.id,
                company: posting.company,
                title: posting.title,
                track: posting.watchlist.track,
            });
            return { application, updatedPosting };
        });
        application = txResult.application;
        updatedPosting = txResult.updatedPosting;
    } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === "P2002") {
            // Two race possibilities:
            //  (a) Application.postingId unique — concurrent track of the
            //      same posting. Resolve to that winner's row (case 1).
            //  (b) (userId, normalizedCompany, normalizedRole, track) unique
            //      — concurrent track of a different posting that just got
            //      created in parallel, OR an ingest race. Resolve via the
            //      merge-link branch on the existing row.
            const postingHit = await prisma.application.findFirst({
                where: { postingId: posting.id, userId },
                select: { id: true, postingId: true },
            });
            if (postingHit) {
                const postingNow = await prisma.jobPosting.findUnique({
                    where: { id: posting.id },
                    select: { status: true },
                });
                return {
                    ok: true,
                    created: false,
                    merged: false,
                    applicationId: postingHit.id,
                    postingStatus: postingNow?.status ?? posting.status,
                };
            }
            const raceLoser = await findApplicationByCompanyAndRole(
                userId,
                posting.company,
                posting.title,
                posting.watchlist.track,
            );
            if (raceLoser) {
                const merged = await mergeLinkExistingApplication(
                    { id: raceLoser.id, postingId: raceLoser.postingId },
                    posting,
                    userId,
                );
                broadcastEvent({ model: "Application", action: "upsert", id: merged.applicationId, timestamp: Date.now() });
                broadcastEvent({ model: "Posting", action: "upsert", id: merged.postingId, timestamp: Date.now() });
                return {
                    ok: true,
                    created: false,
                    merged: true,
                    applicationId: merged.applicationId,
                    postingStatus: merged.postingStatus,
                };
            }
        }
        throw e;
    }

    broadcastEvent({ model: "Application", action: "upsert", id: application.id, timestamp: Date.now() });
    broadcastEvent({ model: "Posting", action: "upsert", id: updatedPosting.id, timestamp: Date.now() });

    return {
        ok: true,
        created: true,
        merged: false,
        applicationId: application.id,
        postingStatus: updatedPosting.status,
    };
}

async function mergeLinkExistingApplication(
    existing: { id: string; postingId: string | null },
    posting: { id: string; company: string; title: string; sourceUrl: string | null; externalId: string | null; watchlist: { track: string } },
    userId: string,
): Promise<{ applicationId: string; postingId: string; postingStatus: string }> {
    const now = new Date();
    const linkable = existing.postingId == null;
    const noteTitle = linkable
        ? `Tracked from ${posting.company} posting`
        : `Also saw ${posting.company} posting`;

    const txResult = await prisma.$transaction(async (tx) => {
        if (linkable) {
            await tx.application.update({
                where: { id: existing.id },
                data: {
                    postingId: posting.id,
                    ...(posting.externalId ? { sourceJobId: posting.externalId } : {}),
                },
            });
        }
        await tx.applicationEvent.create({
            data: {
                applicationId: existing.id,
                kind: "NOTE",
                title: noteTitle,
                occurredAt: now,
                notes: posting.sourceUrl,
            },
        });
        const updatedPosting = await tx.jobPosting.update({
            where: { id: posting.id },
            data: { status: "tracked" },
            select: { id: true, status: true },
        });
        await flipSiblingPostings(tx, userId, {
            id: posting.id,
            company: posting.company,
            title: posting.title,
            track: posting.watchlist.track,
        });
        return { updatedPosting };
    });

    return {
        applicationId: existing.id,
        postingId: txResult.updatedPosting.id,
        postingStatus: txResult.updatedPosting.status,
    };
}

// Flip the siblings. JobPosting's unique key is per-watchlist
// (@@unique([watchlistId, externalId])), so N overlapping watchlists store N
// SEPARATE rows for the same underlying job. Example: "security officer —
// Downey, CA" ⊂ "— Los Angeles" ⊂ "— California" → an LA job lands a row in all
// three. Tracking the clicked row leaves the rest sitting in discovery as
// status="new" — the "I already applied for this but it's still showing"
// duplicate. This is deliberately a set operation, not a pairwise "twin" flip:
// it flips EVERY sibling still in the feed, so the whole job leaves discovery
// no matter how many watchlists surfaced it.
//
// Siblings are matched on postingDedupKey (normalizedCompany + normalizedRole),
// the SAME key the feed collapses on — not externalId — so a job reposted under
// a different sourceUrl (different externalId) is still pulled out of the feed.
// Scoped to the same track + userId so it mirrors the per-track feed and the
// per-track Application unique key. JobPosting stores raw company/title (the
// normalized key isn't a column), so we can't express the match in SQL: fetch
// the bounded "new" set for this track and filter in JS. The discovery feed is
// capped, so this is at most a few hundred small rows.
async function flipSiblingPostings(
    tx: Prisma.TransactionClient,
    userId: string,
    posting: { id: string; company: string; title: string; track: string },
): Promise<void> {
    const key = postingDedupKey(posting.company, posting.title);
    const candidates = await tx.jobPosting.findMany({
        where: {
            id: { not: posting.id },
            status: "new",
            watchlist: { userId, track: posting.track },
        },
        select: { id: true, company: true, title: true },
    });
    const siblingIds = candidates
        .filter(c => postingDedupKey(c.company, c.title) === key)
        .map(c => c.id);
    if (siblingIds.length === 0) return;
    await tx.jobPosting.updateMany({
        where: { id: { in: siblingIds } },
        data: { status: "tracked" },
    });
}
