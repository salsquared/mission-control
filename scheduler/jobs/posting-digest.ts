/**
 * Posting-digest scheduler job (story S6.2).
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
import {
    compileNegativeFilters,
    compileNegativeFiltersFromArray,
    matchesNegativeFilters,
} from "@/lib/postings/negative-filters";
import { findGlobalSettingForUser, parseGlobalSetting } from "@/lib/repositories/settings";

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
            negativeFilters: true,
        },
    });

    let summarized = 0;
    let totalPostings = 0;

    for (const w of watchlists) {
        // Global negative-filter parity with /api/postings GET and job-watcher
        // per-posting dispatch — read for THIS watchlist's owner (P2.3.3), which
        // is why it sits inside the loop instead of being hoisted above it.
        // Applying one user's filters to another's watchlist doesn't merely
        // produce a wrong digest: the `culledOnly` advance at the bottom of this
        // loop would push lastDigestAt past a posting that the owner's own
        // config never culled, and the watermark only ever moves forward — so
        // the posting is never digested at all. Lost, not deferred.
        //
        // One indexed findUnique per digest watchlist, on a daily job that
        // already runs a findMany per watchlist. Both regex sets are compiled
        // per iteration and cached by JSON identity in negative-filters.ts.
        const globalSettingRow = await findGlobalSettingForUser(w.userId);
        const globalNegativeRegexes = compileNegativeFiltersFromArray(
            globalSettingRow ? parseGlobalSetting(globalSettingRow).negativeFilters : [],
        );

        // Window: postings first-seen since the last digest, or since the
        // watchlist was created if no prior digest. Using firstSeenAt (not
        // createdAt) so a re-surfaced posting doesn't fire a digest.
        //
        // The first-run bound is INCLUSIVE (gte): w.createdAt was never
        // itself a dispatched posting's watermark, so there's no double-
        // count risk, and on fast back-to-back writes a posting's
        // firstSeenAt can land in the exact same millisecond as its
        // watchlist's createdAt — an exclusive bound there silently and
        // PERMANENTLY drops that posting, since the watermark only ever
        // advances forward. A post-dispatch watermark (lastDigestAt, set
        // below to maxIncluded) DOES equal an already-summarized posting's
        // firstSeenAt, so that case stays exclusive (PB-2) to avoid
        // re-summarizing it.
        const isInitialWindow = w.lastDigestAt === null;
        const since = w.lastDigestAt ?? w.createdAt;
        const postings = await prisma.jobPosting.findMany({
            where: {
                watchlistId: w.id,
                firstSeenAt: isInitialWindow ? { gte: since } : { gt: since },
                status: { notIn: ["hidden", "closed"] },
            },
            orderBy: { firstSeenAt: "desc" },
            select: { id: true, company: true, title: true, location: true, snippet: true, firstSeenAt: true },
        });

        // Cull postings the user has chosen to ignore via negative filters
        // (global + per-watchlist). Filtered postings stay in the JobPosting
        // table so the user can resurface them by toggling the filter off;
        // they're only excluded from this digest dispatch.
        const watchlistNegativeRegexes = compileNegativeFilters(w.negativeFilters);
        const filteredPostings = postings.filter(p =>
            !matchesNegativeFilters(p, globalNegativeRegexes) &&
            !matchesNegativeFilters(p, watchlistNegativeRegexes)
        );

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
        if (filteredPostings.length > 0) {
            const preview = filteredPostings.slice(0, BODY_PREVIEW_LIMIT)
                .map(p => `• ${p.company} — ${p.title}${p.location ? ` (${p.location})` : ""}`)
                .join("\n");
            const more = filteredPostings.length > BODY_PREVIEW_LIMIT
                ? `\n…and ${filteredPostings.length - BODY_PREVIEW_LIMIT} more`
                : "";

            try {
                const result = await dispatchNotification({
                    userId: w.userId,
                    tier: "low",
                    kind: "posting",
                    title: `${w.name} — ${filteredPostings.length} new posting${filteredPostings.length === 1 ? "" : "s"}`,
                    body: `${preview}${more}`,
                    payload: {
                        watchlistId: w.id,
                        type: "posting-digest",
                        count: filteredPostings.length,
                        postingIds: filteredPostings.map(p => p.id),
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
                    totalPostings += filteredPostings.length;
                }
            } catch (e) {
                console.warn(`[posting-digest] dispatch failed for watchlist ${w.id}:`, e);
            }
        }

        // Advance the watermark when (a) we successfully dispatched, OR (b) the
        // window had postings but every one was culled by negative filters —
        // those have been "considered and rejected", and we don't want to keep
        // re-evaluating the same culled set forever. Don't advance on dispatch
        // failure (PB-3): the transient error should retry next tick.
        //
        // (b) is why the settings read above MUST be this watchlist's owner
        // (P2.3.3): "considered and rejected" is only true if the config that
        // rejected the posting was the owner's own. Under a foreign filter this
        // branch silently retires a posting the owner never saw.
        const culledOnly = postings.length > 0 && filteredPostings.length === 0;
        if ((dispatchedOk || culledOnly) && maxIncluded !== null) {
            await prisma.watchlist.update({
                where: { id: w.id },
                data: { lastDigestAt: maxIncluded },
            }).catch(e => console.warn(`[posting-digest] failed to update lastDigestAt for ${w.id}:`, e));
        }
    }

    return { processed: watchlists.length, summarized, totalPostings };
}
