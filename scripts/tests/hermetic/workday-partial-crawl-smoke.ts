/**
 * Hermetic smoke for the Workday fetcher's crawl-completeness signal.
 *
 * Why this exists (2026-07-31): `fetchWorkday` only set `partial: true` when
 * pagination broke MID-crawl (a non-OK page after page 0). A crawl that ran out
 * of `maxPages` while every page was still full looked IDENTICAL to a crawl
 * that drained the listing — `partial` stayed false. job-watcher.ts:531 reads
 * that flag as "our view of the source is complete", so every posting past the
 * cap became a false-close candidate.
 *
 * Measured live: Blue Origin ingested 999 postings against a 1000-item cap
 * (maxPages 50 x PAGE_SIZE 20) — i.e. it hit the cap with a full final page and
 * still reported a complete crawl. The only reason that never mass-closed rows
 * is that the Workday liveness probes were all failing, so nothing ever reached
 * a "closed" verdict. Fixing the probes without this flag would have converted a
 * latent bug into ~600 false closes on the next tick.
 *
 * Asserts:
 *   1. Cap reached with full pages     → partial: true  (incomplete view)
 *   2. Short final page (listing ends) → partial: false (complete view)
 *   3. `total` reached on page 0       → partial: false (complete view)
 *   4. Non-OK page after page 0        → partial: true  (pre-existing contract)
 *
 * Pure logic — no DB writes, no real network.
 */
import { unlinkSync } from "node:fs";

// fetchWorkday records fetch outcomes; keep them out of the real telemetry DB.
const TMP_HEALTH_DB = `/tmp/workday-partial-smoke-health-${process.pid}-${Date.now()}.db`;
process.env.FETCHER_HEALTH_PATH = TMP_HEALTH_DB;
delete process.env.MC_SCHEDULER_TIER;

import { fetchWorkday } from "@/lib/fetchers/workday-fetcher";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const PAGE_SIZE = 20; // mirrors the fetcher's server-imposed cap

const CONFIG = {
    kind: "workday" as const,
    tenantHost: "example.wd5.myworkdayjobs.com",
    careerSite: "ExternalSite",
    companyName: "Example Corp",
};

function job(i: number) {
    return {
        title: `Engineer ${i}`,
        externalPath: `/job/Somewhere/Engineer-${i}_R${1000 + i}`,
        locationsText: "Somewhere",
        postedOn: "Posted Today",
        bulletFields: [`R${1000 + i}`],
    };
}

/**
 * Stub global fetch with a page server. `pageSizes(page)` returns how many jobs
 * that page yields, or a number < 0 to respond non-OK.
 */
function installPageServer(pageSizes: (page: number) => number, total?: number) {
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { offset?: number };
        const page = Math.floor((body.offset ?? 0) / PAGE_SIZE);
        call++;
        const n = pageSizes(page);
        if (n < 0) return new Response("upstream error", { status: 503 });
        return new Response(
            JSON.stringify({
                ...(page === 0 && total !== undefined ? { total } : {}),
                jobPostings: Array.from({ length: n }, (_, i) => job(page * PAGE_SIZE + i)),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as typeof fetch;
    return {
        callCount: () => call,
        restore: () => { globalThis.fetch = original; },
    };
}

async function testCapReachedIsPartial() {
    // Every page full, maxPages exhausted → we never saw the end of the listing.
    const maxPages = 5;
    const stub = installPageServer(() => PAGE_SIZE);
    const r = await fetchWorkday({ ...CONFIG, maxPages });
    stub.restore();
    if (!r.ok) { fail("cap-reached: fetch failed", r); return; }
    if (r.partial === true) {
        pass(`cap-reached with full pages → partial:true (${r.postings.length} postings over ${maxPages} pages)`);
    } else {
        fail(`cap-reached should be partial, got partial=${String(r.partial)} with ${r.postings.length} postings`);
    }
}

async function testShortPageIsComplete() {
    // Listing genuinely ends mid-page → complete view, safe to close on absence.
    const stub = installPageServer((page) => (page < 2 ? PAGE_SIZE : 7));
    const r = await fetchWorkday({ ...CONFIG, maxPages: 10 });
    stub.restore();
    if (!r.ok) { fail("short-page: fetch failed", r); return; }
    if (!r.partial && r.postings.length === PAGE_SIZE * 2 + 7) {
        pass(`short final page → partial:false (${r.postings.length} postings, listing drained)`);
    } else {
        fail(`short-page should be complete, got partial=${String(r.partial)} count=${r.postings.length}`);
    }
}

async function testTotalReachedIsComplete() {
    // Page 0 reports a `total` we've already met → complete view.
    const stub = installPageServer(() => PAGE_SIZE, PAGE_SIZE);
    const r = await fetchWorkday({ ...CONFIG, maxPages: 10 });
    stub.restore();
    if (!r.ok) { fail("total-reached: fetch failed", r); return; }
    if (!r.partial && r.postings.length === PAGE_SIZE) {
        pass(`total reached on page 0 → partial:false (${r.postings.length} postings)`);
    } else {
        fail(`total-reached should be complete, got partial=${String(r.partial)} count=${r.postings.length}`);
    }
}

async function testMidCrawlFailureIsPartial() {
    // Pre-existing contract: a non-OK page after page 0 returns what we have,
    // flagged partial.
    const stub = installPageServer((page) => (page < 2 ? PAGE_SIZE : -1));
    const r = await fetchWorkday({ ...CONFIG, maxPages: 10 });
    stub.restore();
    if (!r.ok) { fail("mid-crawl-failure: expected ok with partial results", r); return; }
    if (r.partial === true && r.postings.length === PAGE_SIZE * 2) {
        pass(`mid-crawl non-OK page → partial:true (kept ${r.postings.length} postings)`);
    } else {
        fail(`mid-crawl-failure should be partial, got partial=${String(r.partial)} count=${r.postings.length}`);
    }
}

function cleanup() {
    for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(`${TMP_HEALTH_DB}${suffix}`); } catch { /* may not exist */ }
    }
}

async function main() {
    await testCapReachedIsPartial();
    await testShortPageIsComplete();
    await testTotalReachedIsComplete();
    await testMidCrawlFailureIsPartial();

    cleanup();
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch((e) => {
    cleanup();
    console.error("Unhandled error:", e);
    process.exit(1);
});
