/**
 * Posting-digest scheduler job (story 26).
 *
 * Daily-ish tick. For each active watchlist with notificationMode='digest':
 *   - find postings created since the last digest checkpoint (lastDigestAt,
 *     or the watchlist's createdAt for the first run)
 *   - if any, dispatch ONE summary Notification grouping them
 *   - update lastDigestAt to runAt regardless (so the window slides forward
 *     even on empty days — we never re-summarize old postings)
 *
 * Notifications fire at tier='low' to match per-posting dispatch (in-app
 * only). Watchlists in modes 'each' or 'silent' are ignored.
 */
import { prisma } from "@/lib/prisma";
import { dispatchNotification } from "@/lib/notifications/dispatch";

// Don't summarize more than this many postings inline in the body — we still
// store all of them; the bell just shows the first N and a "+M more".
const BODY_PREVIEW_LIMIT = 5;

export interface PostingDigestRunResult {
    processed: number;
    summarized: number;
    totalPostings: number;
}

export async function runPostingDigest(): Promise<PostingDigestRunResult> {
    const watchlists = await prisma.watchlist.findMany({
        where: { notificationMode: "digest", active: true },
        select: {
            id: true, userId: true, name: true,
            lastDigestAt: true, createdAt: true,
        },
    });

    let summarized = 0;
    let totalPostings = 0;

    for (const w of watchlists) {
        // Window: postings first-seen since the last digest, or since the
        // watchlist was created if no prior digest. Using firstSeenAt (not
        // createdAt) so a re-surfaced posting doesn't fire a digest.
        const since = w.lastDigestAt ?? w.createdAt;
        const postings = await prisma.jobPosting.findMany({
            where: {
                watchlistId: w.id,
                firstSeenAt: { gt: since },
                status: { notIn: ["hidden", "closed"] },
            },
            orderBy: { firstSeenAt: "desc" },
            select: { id: true, company: true, title: true, location: true, firstSeenAt: true },
        });

        // PB-2 (was RAH-2): advance the watermark to the MAX firstSeenAt actually
        // included in this run — not to runAt. Two postings inserted in the
        // same millisecond (rare but real, especially under load) need the
        // strict `gt: since` filter to not skip the second one. Advancing to
        // maxIncluded keeps `gt: maxIncluded` strictly past everything we
        // already dispatched, while a posting created in the SELECT-UPDATE
        // window has firstSeenAt > maxIncluded by construction (clock is
        // monotonic within a single Node process) and gets picked up next run.
        //
        // PB-3 (was RAH-3): only advance when dispatch actually succeeded. On empty
        // windows we leave the watermark alone — re-scanning an empty window
        // next run is a cheap SELECT returning 0 rows, and not advancing
        // avoids any boundary collision when a new posting lands with the
        // same millisecond as the would-be advanced watermark.
        const maxIncluded = postings.length > 0
            ? postings.reduce(
                (acc, p) => (p.firstSeenAt > acc ? p.firstSeenAt : acc),
                postings[0].firstSeenAt,
            )
            : null;

        let dispatchedOk = false;
        if (postings.length > 0) {
            const preview = postings.slice(0, BODY_PREVIEW_LIMIT)
                .map(p => `• ${p.company} — ${p.title}${p.location ? ` (${p.location})` : ""}`)
                .join("\n");
            const more = postings.length > BODY_PREVIEW_LIMIT
                ? `\n…and ${postings.length - BODY_PREVIEW_LIMIT} more`
                : "";

            try {
                const result = await dispatchNotification({
                    userId: w.userId,
                    tier: "low",
                    kind: "posting",
                    title: `${w.name} — ${postings.length} new posting${postings.length === 1 ? "" : "s"}`,
                    body: `${preview}${more}`,
                    payload: {
                        watchlistId: w.id,
                        type: "posting-digest",
                        count: postings.length,
                        postingIds: postings.map(p => p.id),
                    },
                    // PB-8: key on the BATCH watermark (maxIncluded) rather
                    // than the calendar day. Two concurrent ticks of this job
                    // computing the same maxIncluded race on the constraint —
                    // exactly one wins. A LATER tick whose maxIncluded has
                    // advanced (new postings arrived) gets a fresh key and
                    // fires normally, preserving the "second cohort same day"
                    // behavior the design intends.
                    dedupKey: `posting-digest:${w.id}:${maxIncluded!.toISOString()}`,
                });
                // result === null means a concurrent dispatcher won the race;
                // treat that the same as a successful dispatch for watermark
                // purposes — the postings were "delivered" via the other tick.
                dispatchedOk = true;
                if (result) {
                    summarized++;
                    totalPostings += postings.length;
                }
            } catch (e) {
                console.warn(`[posting-digest] dispatch failed for watchlist ${w.id}:`, e);
            }
        }

        if (dispatchedOk && maxIncluded !== null) {
            await prisma.watchlist.update({
                where: { id: w.id },
                data: { lastDigestAt: maxIncluded },
            }).catch(e => console.warn(`[posting-digest] failed to update lastDigestAt for ${w.id}:`, e));
        }
    }

    return { processed: watchlists.length, summarized, totalPostings };
}
