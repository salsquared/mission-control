/**
 * Hermetic regression for Bug E (commit 4f1854d) — LinkedIn + Workday
 * fetchers handled pagination failures with `if (page > 0) break` and
 * returned `ok: true` without flagging the result as partial. Combined
 * with Bug C's fix (close-detection now actually runs for big watchlists),
 * a flaky page-2 would have let close-detection mass-close legitimate
 * postings that just happened to fall in the un-fetched portion.
 *
 * Fix: FetcherResult.partial?: boolean. Both LinkedIn and Workday set it
 * on the page-break-on-error paths. job-watcher's close-detection skips
 * when fetchResult.partial is truthy.
 *
 * This test stubs globalThis.fetch to simulate "page 0 ok, page 1 fails"
 * for both LinkedIn and Workday, then asserts the returned FetcherResult
 * carries `partial: true` along with the page-0 postings.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/fetcher-partial-regression-smoke.ts
 *
 * Doesn't touch the DB (pure fetcher unit-tests) but kept in hermetic/
 * so the pre-push gate exercises it.
 */
import { fetchLinkedin } from "@/lib/fetchers/linkedin-fetcher";
import { fetchWorkday } from "@/lib/fetchers/workday-fetcher";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// Fixture HTML for the LinkedIn guest endpoint — needs the right cheerio
// selectors (.base-card / .base-search-card__title / a.base-card__full-link)
// so the fetcher actually extracts postings. PAGE_SIZE is 25 in the fetcher;
// we return 25 cards on page 0 so the early-exit `pageCount < PAGE_SIZE`
// doesn't trigger, forcing the loop to try page 1.
function linkedinFullPageHtml(): string {
    const cards = Array.from({ length: 25 }, (_, i) => `
        <li class="base-card">
            <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${1000 + i}?refId=abc">
                <span class="sr-only">Stub Title ${i}</span>
            </a>
            <h3 class="base-search-card__title">Stub Title ${i}</h3>
            <h4 class="base-search-card__subtitle">Stub Co ${i}</h4>
            <span class="job-search-card__location">Remote</span>
        </li>`).join("");
    return `<ul>${cards}</ul>`;
}

// Workday: POST endpoint returns JSON envelope with `jobPostings: []` and
// `total`. Page 0 returns a full page (PAGE_SIZE=20 in the fetcher) so the
// loop attempts page 1.
function workdayFullPageJson(): string {
    const jobs = Array.from({ length: 20 }, (_, i) => ({
        title: `Stub Title ${i}`,
        externalPath: `/job/${1000 + i}`,
        locationsText: "Remote",
        postedOn: "Today",
        remoteType: "Remote",
    }));
    return JSON.stringify({ jobPostings: jobs, total: 100 });
}

interface MockHandler {
    matches: (url: string, method: string) => boolean;
    respond: () => Response;
}

function installFetchMock(handlers: MockHandler[]) {
    const original = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        for (const h of handlers) {
            if (h.matches(url, method)) return h.respond();
        }
        throw new Error(`unstubbed fetch: ${method} ${url}`);
    }) as typeof fetch;
    return {
        callCount: () => callCount,
        restore: () => { globalThis.fetch = original; },
    };
}

async function testLinkedinPartialFlag() {
    // Stub: page 0 returns full HTML (25 cards), page 1 returns HTTP 500 →
    // fetcher should set partial=true and return only page-0 postings.
    let requestN = 0;
    const stub = installFetchMock([{
        matches: (url) => url.includes("linkedin.com/jobs-guest"),
        respond: () => {
            requestN++;
            if (requestN === 1) {
                return new Response(linkedinFullPageHtml(), { status: 200, headers: { "content-type": "text/html" } });
            }
            // Page 1 — flake.
            return new Response("upstream error", { status: 500 });
        },
    }]);

    try {
        const result = await fetchLinkedin({
            kind: "linkedin",
            keywords: "engineer",
            location: "Remote",
            companyName: "LinkedIn Test",
            timeRange: "24h",
        });
        if (!result.ok) {
            return fail(`linkedin: returned ok=false (${result.error}) — expected ok=true with partial flag`);
        }
        if (result.postings.length !== 25) {
            fail(`linkedin: expected 25 postings (page 0), got ${result.postings.length}`);
        } else {
            pass("linkedin: returned page-0 postings (25 cards)");
        }
        if (result.partial !== true) {
            fail(`linkedin: result.partial=${result.partial} — Bug E regressed (should be true after page-1 500)`);
        } else {
            pass("linkedin: result.partial=true on page-1 failure");
        }
        if (stub.callCount() < 2) {
            fail(`linkedin: expected ≥2 fetch calls (page 0 + retry on page 1), got ${stub.callCount()}`);
        } else {
            pass(`linkedin: attempted page 1 (${stub.callCount()} fetches)`);
        }
    } finally {
        stub.restore();
    }
}

async function testWorkdayPartialFlag() {
    // Same shape: page 0 ok, page 1 returns 500 → partial:true expected.
    let requestN = 0;
    const stub = installFetchMock([{
        matches: (url, method) => method === "POST" && url.includes("/wday/cxs/"),
        respond: () => {
            requestN++;
            if (requestN === 1) {
                return new Response(workdayFullPageJson(), { status: 200, headers: { "content-type": "application/json" } });
            }
            return new Response("upstream error", { status: 500 });
        },
    }]);

    try {
        const result = await fetchWorkday({
            kind: "workday",
            tenantHost: "boeing.wd1.myworkdayjobs.com",
            careerSite: "EXTERNAL_CAREERS",
            companyName: "Workday Test",
        });
        if (!result.ok) {
            return fail(`workday: returned ok=false (${result.error}) — expected ok=true with partial flag`);
        }
        if (result.postings.length !== 20) {
            fail(`workday: expected 20 postings (page 0), got ${result.postings.length}`);
        } else {
            pass("workday: returned page-0 postings (20 jobs)");
        }
        if (result.partial !== true) {
            fail(`workday: result.partial=${result.partial} — Bug E regressed (should be true after page-1 500)`);
        } else {
            pass("workday: result.partial=true on page-1 failure");
        }
    } finally {
        stub.restore();
    }
}

async function testHappyPathLeavesPartialUnset() {
    // Sanity: when no pagination failure happens, partial must be absent
    // (or undefined) so close-detection runs normally on clean crawls.
    const stub = installFetchMock([{
        matches: (url) => url.includes("linkedin.com/jobs-guest"),
        respond: () => {
            // Return only 5 cards — under PAGE_SIZE=25 so the loop breaks
            // via the natural "page exhausted" path, not the error path.
            const cards = Array.from({ length: 5 }, (_, i) => `
                <li class="base-card">
                    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${2000 + i}?refId=xyz">
                        <span class="sr-only">Clean Title ${i}</span>
                    </a>
                    <h3 class="base-search-card__title">Clean Title ${i}</h3>
                    <h4 class="base-search-card__subtitle">Clean Co</h4>
                </li>`).join("");
            return new Response(`<ul>${cards}</ul>`, { status: 200, headers: { "content-type": "text/html" } });
        },
    }]);

    try {
        const result = await fetchLinkedin({
            kind: "linkedin",
            keywords: "engineer",
            companyName: "Clean LinkedIn",
            timeRange: "24h",
        });
        if (!result.ok) return fail(`happy-path: returned ok=false (${result.error})`);
        if (result.partial) {
            fail(`happy-path: result.partial=${result.partial} — must be unset/false on clean crawls`);
        } else {
            pass("happy-path: result.partial is undefined on a clean (non-paginated-error) crawl");
        }
    } finally {
        stub.restore();
    }
}

async function main() {
    await testLinkedinPartialFlag();
    await testWorkdayPartialFlag();
    await testHappyPathLeavesPartialUnset();
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch((e) => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
