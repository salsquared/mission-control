/**
 * Lockstep employment-type classifier — batches every JobPosting whose
 * employmentType is still NULL across every watchlist into a single sweep.
 *
 * Companion to scheduler/jobs/job-watcher.ts: that job only runs the
 * classifier inline on a watchlist's FIRST crawl (so newly-added watchlists
 * feel responsive). Every subsequent crawl writes new postings with
 * employmentType=null and leaves them for this job to pick up.
 *
 * Win: instead of N scattered Gemini Flash batches (one per watchlist whose
 * 10-min tick happened to find new postings), every null row across the
 * fleet gets consolidated into one sweep — same 50-item batch size, but
 * 100% cross-watchlist reuse (we dedupe by externalId before sending).
 *
 * Bounded: SWEEP_CAP caps how many distinct externalIds are classified per
 * run. Anything beyond gets picked up next tick. Default 1000 = ≤20 batches
 * = ~2 min worst case after the Gemini rate-limit (12 req/min) throttles.
 */
import { prisma } from "@/lib/prisma";
import {
    classifyEmploymentTypes,
    type ChatJSONFn,
    type ClassifyInput,
} from "@/lib/ai/classify-employment-type";
import { compileNegativeFiltersFromArray, matchesNegativeFilters } from "@/lib/postings/negative-filters";
import { findGlobalSetting, parseGlobalSetting } from "@/lib/repositories/settings";

const SWEEP_CAP = 1_000;

export interface SweepResult {
    /** Distinct externalIds considered (capped at SWEEP_CAP). */
    distinct: number;
    /** Distinct externalIds the model decided a non-null type for. */
    classified: number;
    /** JobPosting rows updated (≥ classified — a single externalId can map to multiple rows across watchlists). */
    rowsUpdated: number;
}

export async function runClassifyPendingEmploymentTypes(
    chatFn?: ChatJSONFn,
): Promise<SweepResult> {
    // Pull every pending row (across all watchlists, all users) up to the
    // sweep cap. Order by firstSeenAt so the oldest unclassified postings
    // get worked off first when the queue exceeds the cap.
    const pending = await prisma.jobPosting.findMany({
        where: {
            employmentType: null,
            status: { notIn: ["closed", "hidden"] },
        },
        select: {
            externalId: true,
            company: true,
            title: true,
            snippet: true,
            location: true,
        },
        orderBy: { firstSeenAt: "asc" },
        take: SWEEP_CAP * 4, // headroom so dedupe still yields up to SWEEP_CAP distinct ids
    });

    if (pending.length === 0) {
        return { distinct: 0, classified: 0, rowsUpdated: 0 };
    }

    // Dedupe by externalId — same (company|title|sourceUrl) hash across
    // watchlists is the same posting, classify once and apply to all rows.
    // Global negative-filter gate (defense-in-depth, 2026-05-29). The
    // job-watcher ingestion drop stops NEW blacklisted postings from being
    // stored, but legacy rows created before that landed can still be NULL +
    // blacklisted. Skip them here so they never reach Gemini. A global match
    // means the posting is hidden on every watchlist, so excluding the whole
    // externalId is safe. (Per-watchlist filters are read-time only — not
    // applied here, matching scope.) One cheap singleton query per sweep.
    const globalSettingRow = await findGlobalSetting();
    const globalNegativeRegexes = compileNegativeFiltersFromArray(
        globalSettingRow ? parseGlobalSetting(globalSettingRow).negativeFilters : [],
    );

    const byExternalId = new Map<string, ClassifyInput>();
    const filteredIds = new Set<string>();
    for (const p of pending) {
        if (byExternalId.has(p.externalId) || filteredIds.has(p.externalId)) continue;
        if (globalNegativeRegexes.length > 0 && matchesNegativeFilters(p, globalNegativeRegexes)) {
            filteredIds.add(p.externalId);
            continue;
        }
        byExternalId.set(p.externalId, {
            id: p.externalId,
            company: p.company,
            title: p.title,
            snippet: p.snippet,
            location: p.location,
        });
        if (byExternalId.size >= SWEEP_CAP) break;
    }
    if (filteredIds.size > 0) {
        console.info(`[classify-pending-employment-types] skipped ${filteredIds.size} distinct posting(s) via global negative filter — not sent to Gemini`);
    }

    const inputs = Array.from(byExternalId.values());
    const result = chatFn
        ? await classifyEmploymentTypes(inputs, chatFn)
        : await classifyEmploymentTypes(inputs);

    let classified = 0;
    let rowsUpdated = 0;
    for (const [externalId, type] of result) {
        if (type == null) continue;
        classified++;
        // updateMany across every row matching this externalId — postings
        // shared across watchlists all get the same classification in one
        // statement. Keep the null-employmentType guard so a concurrent
        // job-watcher tick that just classified this externalId inline
        // (e.g. first-run on a new watchlist surfacing an existing posting)
        // doesn't get its value overwritten — also harmless if it does.
        const u = await prisma.jobPosting.updateMany({
            where: { externalId, employmentType: null },
            data: { employmentType: type },
        });
        rowsUpdated += u.count;
    }

    return { distinct: inputs.length, classified, rowsUpdated };
}
