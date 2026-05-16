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
    const runAt = new Date();
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
            select: { id: true, company: true, title: true, location: true },
        });

        if (postings.length > 0) {
            const preview = postings.slice(0, BODY_PREVIEW_LIMIT)
                .map(p => `• ${p.company} — ${p.title}${p.location ? ` (${p.location})` : ""}`)
                .join("\n");
            const more = postings.length > BODY_PREVIEW_LIMIT
                ? `\n…and ${postings.length - BODY_PREVIEW_LIMIT} more`
                : "";

            try {
                await dispatchNotification({
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
                });
                summarized++;
                totalPostings += postings.length;
            } catch (e) {
                console.warn(`[posting-digest] dispatch failed for watchlist ${w.id}:`, e);
            }
        }

        // Always slide the window forward, even if zero postings — otherwise
        // an empty day would let the next run re-count yesterday's window.
        await prisma.watchlist.update({
            where: { id: w.id },
            data: { lastDigestAt: runAt },
        }).catch(e => console.warn(`[posting-digest] failed to update lastDigestAt for ${w.id}:`, e));
    }

    return { processed: watchlists.length, summarized, totalPostings };
}
