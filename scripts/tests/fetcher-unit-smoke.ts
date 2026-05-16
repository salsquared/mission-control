/**
 * Hermetic unit tests for the four watchlist fetchers.
 *
 *   npx tsx scripts/tests/fetcher-unit-smoke.ts
 *
 * Overrides globalThis.fetch with a per-test mock so no external network calls
 * are made. Each fetcher gets a happy-path test plus a handful of edge cases.
 */
import { fetchGreenhouse } from "@/lib/fetchers/greenhouse-fetcher";
import { fetchLever } from "@/lib/fetchers/lever-fetcher";
import { fetchAshby } from "@/lib/fetchers/ashby-fetcher";
import { fetchCareersPage } from "@/lib/fetchers/careers-page-fetcher";
import { fetchGithubRepoMetrics } from "@/lib/fetchers/github-public-fetcher";
import { fetchWorkday } from "@/lib/fetchers/workday-fetcher";
import { fetchLinkedin } from "@/lib/fetchers/linkedin-fetcher";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

type MockSpec =
    | { kind: "json"; status?: number; body: unknown; headers?: Record<string, string> }
    | { kind: "text"; status?: number; body: string; headers?: Record<string, string> }
    | { kind: "throw"; error: Error };

const realFetch = globalThis.fetch;
const responseQueue: MockSpec[] = [];
let lastRequestURL: string | null = null;

// Single-shot semantics: clear the queue first. Tests where the fetcher
// might early-return before calling fetch (invalid input, SSRF guard, etc.)
// would otherwise leak the unused mock into the next test.
function mockNext(spec: MockSpec) { responseQueue.length = 0; responseQueue.push(spec); }
// Multi-shot: replaces the queue with the given sequence (so leaked items
// from a previous test still get cleared).
function mockSequence(specs: MockSpec[]) { responseQueue.length = 0; responseQueue.push(...specs); }
function resetMocks() { responseQueue.length = 0; }

globalThis.fetch = (async (input: RequestInfo | URL) => {
    lastRequestURL = typeof input === "string" ? input : input.toString();
    const spec = responseQueue.shift();
    if (!spec) throw new Error(`Unexpected fetch (no mock set) to ${lastRequestURL}`);
    if (spec.kind === "throw") throw spec.error;
    const status = spec.status ?? 200;
    const body = spec.kind === "json" ? JSON.stringify(spec.body) : spec.body;
    return new Response(body, {
        status,
        headers: {
            "content-type": spec.kind === "json" ? "application/json" : "text/html",
            ...(spec.headers ?? {}),
        },
    }) as unknown as Response;
}) as typeof fetch;

// ─── Greenhouse ──────────────────────────────────────────────────────────

async function testGreenhouse() {
    // Happy
    mockNext({ kind: "json", body: { jobs: [
        { id: 1, title: "Senior Engineer", absolute_url: "https://example.com/jobs/1", location: { name: "Remote" }, departments: [{ name: "Engineering" }] },
        { id: 2, title: "Designer", absolute_url: "https://example.com/jobs/2", location: { name: "NYC" } },
    ] } });
    const r = await fetchGreenhouse({ kind: "greenhouse", boardSlug: "acme", companyName: "Acme" });
    if (!r.ok) { fail("greenhouse happy: result not ok", r); }
    else if (r.postings.length !== 2) { fail(`greenhouse happy: expected 2 postings, got ${r.postings.length}`); }
    else if (r.postings[0].title !== "Senior Engineer") { fail("greenhouse happy: title mismatch", r.postings[0]); }
    else if (r.postings[0].location !== "Remote") { fail("greenhouse happy: location mismatch"); }
    else if (r.postings[0].company !== "Acme") { fail("greenhouse happy: company mismatch"); }
    else pass("greenhouse happy path");
    if (lastRequestURL !== "https://boards-api.greenhouse.io/v1/boards/acme/jobs") fail(`greenhouse URL: ${lastRequestURL}`);
    else pass("greenhouse URL constructed correctly");

    // 404 board
    mockNext({ kind: "json", status: 404, body: { error: "Board not found" } });
    const r2 = await fetchGreenhouse({ kind: "greenhouse", boardSlug: "nope", companyName: "Nope" });
    if (r2.ok) fail("greenhouse 404: should not be ok");
    else if (!r2.error.includes("404")) fail("greenhouse 404: error missing status", r2.error);
    else pass("greenhouse 404 → error");

    // Malformed JSON shape
    mockNext({ kind: "json", body: { not_jobs: "garbage" } });
    const r3 = await fetchGreenhouse({ kind: "greenhouse", boardSlug: "broken", companyName: "Broken" });
    if (r3.ok) fail("greenhouse malformed: should not be ok");
    else pass("greenhouse malformed JSON → error");

    // Empty jobs array
    mockNext({ kind: "json", body: { jobs: [] } });
    const r4 = await fetchGreenhouse({ kind: "greenhouse", boardSlug: "empty", companyName: "Empty" });
    if (!r4.ok) fail("greenhouse empty: should be ok with empty postings");
    else if (r4.postings.length !== 0) fail(`greenhouse empty: expected 0 postings, got ${r4.postings.length}`);
    else pass("greenhouse empty jobs[] → ok with no postings");

    // Missing location
    mockNext({ kind: "json", body: { jobs: [{ id: 1, title: "X", absolute_url: "https://e.com/1" }] } });
    const r5 = await fetchGreenhouse({ kind: "greenhouse", boardSlug: "x", companyName: "X" });
    if (!r5.ok || r5.postings[0].location !== null) fail("greenhouse missing-location: should default to null");
    else pass("greenhouse missing location → null");
}

// ─── Lever ───────────────────────────────────────────────────────────────

async function testLever() {
    // Happy
    mockNext({ kind: "json", body: [
        { id: "a", text: "Senior Engineer", hostedUrl: "https://jobs.lever.co/acme/a", categories: { location: "Remote", department: "Eng", team: "Core", commitment: "Full-time" } },
        { id: "b", text: "Designer", hostedUrl: "https://jobs.lever.co/acme/b", categories: { location: "NYC" } },
    ] });
    const r = await fetchLever({ kind: "lever", boardSlug: "acme", companyName: "Acme" });
    if (!r.ok) fail("lever happy: not ok", r);
    else if (r.postings.length !== 2) fail(`lever happy: expected 2, got ${r.postings.length}`);
    else if (r.postings[0].snippet !== "Eng · Core · Full-time") fail(`lever happy: snippet mismatch (${r.postings[0].snippet})`);
    else pass("lever happy path");

    // The Netflix-shape bug: HTTP 200 but rows have null text/hostedUrl
    mockNext({ kind: "json", body: [
        { id: null, text: null, hostedUrl: null, categories: null },
        { id: "real", text: "Real Job", hostedUrl: "https://jobs.lever.co/acme/real", categories: { location: "SF" } },
    ] });
    const r2 = await fetchLever({ kind: "lever", boardSlug: "acme", companyName: "Acme" });
    if (!r2.ok) fail("lever null-rows: not ok", r2);
    else if (r2.postings.length !== 1) fail(`lever null-rows: expected 1 valid posting, got ${r2.postings.length}`);
    else if (r2.postings[0].title !== "Real Job") fail("lever null-rows: wrong row survived");
    else pass("lever null-only rows filtered out");

    // The 200-with-error-object bug
    mockNext({ kind: "json", body: { ok: false, error: "Document not found" } });
    const r3 = await fetchLever({ kind: "lever", boardSlug: "missing", companyName: "Missing" });
    if (r3.ok) fail("lever 200-error: should not be ok");
    else if (!r3.error.toLowerCase().includes("not found")) fail("lever 200-error: error not surfaced", r3.error);
    else pass("lever 200-with-error-object surfaced");

    // Empty array
    mockNext({ kind: "json", body: [] });
    const r4 = await fetchLever({ kind: "lever", boardSlug: "empty", companyName: "Empty" });
    if (!r4.ok || r4.postings.length !== 0) fail("lever empty: should be ok with 0 postings");
    else pass("lever empty → ok with 0");

    // HTTP 500
    mockNext({ kind: "json", status: 500, body: { error: "Internal" } });
    const r5 = await fetchLever({ kind: "lever", boardSlug: "down", companyName: "Down" });
    if (r5.ok) fail("lever 500: should not be ok");
    else if (!r5.error.includes("500")) fail("lever 500: status missing from error");
    else pass("lever 500 → error");
}

// ─── Ashby ───────────────────────────────────────────────────────────────

async function testAshby() {
    // Happy
    mockNext({ kind: "json", body: { jobs: [
        { id: "a", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/acme/a", locationName: "Remote", departmentName: "Eng", employmentType: "FT" },
        { id: "b", title: "PM", jobUrl: "https://jobs.ashbyhq.com/acme/b" },
    ] } });
    const r = await fetchAshby({ kind: "ashby", boardSlug: "acme", companyName: "Acme" });
    if (!r.ok) fail("ashby happy: not ok", r);
    else if (r.postings.length !== 2) fail(`ashby happy: expected 2, got ${r.postings.length}`);
    else if (r.postings[0].snippet !== "Eng · FT") fail(`ashby happy: snippet mismatch (${r.postings[0].snippet})`);
    else if (r.postings[1].snippet !== null) fail("ashby happy: empty snippet should be null");
    else pass("ashby happy path");

    // Empty jobs
    mockNext({ kind: "json", body: { jobs: [] } });
    const r2 = await fetchAshby({ kind: "ashby", boardSlug: "empty", companyName: "Empty" });
    if (!r2.ok || r2.postings.length !== 0) fail("ashby empty: should be ok with 0 postings");
    else pass("ashby empty → ok with 0");

    // Malformed
    mockNext({ kind: "json", body: { notJobs: [] } });
    const r3 = await fetchAshby({ kind: "ashby", boardSlug: "broken", companyName: "Broken" });
    if (r3.ok) fail("ashby malformed: should not be ok");
    else pass("ashby malformed shape → error");
}

// ─── Careers-page ────────────────────────────────────────────────────────

async function testCareersPage() {
    // Happy
    const html = `
      <html><body>
        <h1>Careers</h1>
        <a href="/careers/jobs/123">Senior Engineer</a>
        <p>Some text</p>
        <a href="/careers/jobs/456">Designer</a>
        <a href="/about">About</a>
        <a href="/careers/jobs/123">Senior Engineer</a> <!-- duplicate -->
      </body></html>`;
    mockNext({ kind: "text", body: html });
    const r = await fetchCareersPage({
        kind: "careers-page",
        rootUrl: "https://example.com/careers/",
        linkPattern: "/careers/jobs/",
        companyName: "Example",
    });
    if (!r.ok) fail("careers-page happy: not ok", r);
    else if (r.postings.length !== 2) fail(`careers-page happy: expected 2 unique postings, got ${r.postings.length}`);
    else if (r.postings[0].sourceUrl !== "https://example.com/careers/jobs/123") fail(`careers-page happy: URL not resolved (${r.postings[0].sourceUrl})`);
    else pass("careers-page happy + dedup duplicates");

    // Invalid regex
    mockNext({ kind: "text", body: "<a>nope</a>" });
    const r2 = await fetchCareersPage({
        kind: "careers-page",
        rootUrl: "https://example.com/careers/",
        linkPattern: "[", // invalid regex
        companyName: "Example",
    });
    if (r2.ok) fail("careers-page invalid-regex: should not be ok");
    else if (!r2.error.toLowerCase().includes("regex")) fail("careers-page invalid-regex: error not surfaced");
    else pass("careers-page invalid regex → error");

    // No matches → empty
    mockNext({ kind: "text", body: "<a href='/about'>About</a><a href='/help'>Help</a>" });
    const r3 = await fetchCareersPage({
        kind: "careers-page",
        rootUrl: "https://example.com/careers/",
        linkPattern: "/careers/jobs/",
        companyName: "Example",
    });
    if (!r3.ok) fail("careers-page no-matches: should be ok", r3);
    else if (r3.postings.length !== 0) fail(`careers-page no-matches: expected 0, got ${r3.postings.length}`);
    else pass("careers-page no matches → ok with 0");

    // HTTP 404
    mockNext({ kind: "text", status: 404, body: "Not found" });
    const r4 = await fetchCareersPage({
        kind: "careers-page",
        rootUrl: "https://example.com/careers/",
        linkPattern: "/careers/jobs/",
        companyName: "Example",
    });
    if (r4.ok) fail("careers-page 404: should not be ok");
    else if (!r4.error.includes("404")) fail("careers-page 404: error missing status");
    else pass("careers-page 404 → error");

    // SPA stub (no anchors at all)
    mockNext({ kind: "text", body: "<html><body><div id='app'></div></body></html>" });
    const r5 = await fetchCareersPage({
        kind: "careers-page",
        rootUrl: "https://example.com/careers/",
        linkPattern: "/careers/jobs/",
        companyName: "Example",
    });
    if (!r5.ok) fail("careers-page SPA: should be ok (just empty)", r5);
    else if (r5.postings.length !== 0) fail(`careers-page SPA: expected 0, got ${r5.postings.length}`);
    else pass("careers-page SPA stub → ok with 0 postings");

    // Fetch throws (network error / DNS failure)
    mockNext({ kind: "throw", error: new Error("ENOTFOUND example.com") });
    const r6 = await fetchCareersPage({
        kind: "careers-page",
        rootUrl: "https://example.com/careers/",
        linkPattern: "/careers/jobs/",
        companyName: "Example",
    });
    if (r6.ok) fail("careers-page DNS-fail: should not be ok");
    else if (!r6.error.toLowerCase().includes("enotfound")) fail("careers-page DNS-fail: error not surfaced");
    else pass("careers-page DNS failure → error");
}

// ─── GitHub public-API ───────────────────────────────────────────────────

async function testGithub() {
    // Happy: 3 calls (repo, languages, commits) returning a complete metrics object
    mockSequence([
        { kind: "json", body: { stargazers_count: 142, language: "Go", created_at: "2023-01-01T00:00:00Z", pushed_at: "2026-05-10T12:00:00Z" } },
        { kind: "json", body: { Go: 50000, TypeScript: 12000, Python: 3000 } },
        {
            kind: "json",
            body: [{ commit: { author: { date: "2026-05-10T12:00:00Z" } } }],
            // Synthetic link header that GitHub uses to indicate "page 2300 is the last"
            headers: { link: '<https://api.github.com/repositories/1/commits?per_page=1&page=2300>; rel="last"' },
        },
    ]);
    const r = await fetchGithubRepoMetrics("owner/repo");
    if (!r.ok) { fail("github happy: not ok", r); }
    else {
        if (r.metrics.stars !== 142) fail(`stars=${r.metrics.stars}, expected 142`);
        else pass("github: stars parsed");
        if (r.metrics.primaryLanguage !== "Go") fail("primaryLanguage wrong");
        else pass("github: primaryLanguage parsed");
        if (Object.keys(r.metrics.languageMix).length !== 3) fail("languageMix size wrong");
        else pass("github: languageMix parsed (3 languages)");
        if (r.metrics.commitsTotal !== 2300) fail(`commitsTotal=${r.metrics.commitsTotal}, expected 2300 from link header`);
        else pass("github: commitsTotal extracted from link rel=last");
        if (r.metrics.lastCommitAt !== "2026-05-10T12:00:00Z") fail("lastCommitAt wrong");
        else pass("github: lastCommitAt parsed");
        if (typeof r.metrics.ageDays !== "number" || r.metrics.ageDays < 365) fail(`ageDays=${r.metrics.ageDays}, expected >365`);
        else pass("github: ageDays computed from created_at");
    }

    // Invalid owner/repo format
    resetMocks();
    const r2 = await fetchGithubRepoMetrics("not-a-valid-repo");
    if (r2.ok) fail("github invalid repo: should not be ok");
    else if (!r2.error.includes("Invalid owner/repo")) fail("github invalid: wrong error", r2.error);
    else pass("github: invalid owner/repo rejected");

    // 404 on first call
    mockNext({ kind: "json", status: 404, body: { message: "Not Found" } });
    const r3 = await fetchGithubRepoMetrics("ghost/repo");
    if (r3.ok) fail("github 404: should not be ok");
    else if (!r3.error.includes("404")) fail("github 404: error missing status");
    else pass("github: 404 → error");

    // Malformed repo response
    mockNext({ kind: "json", body: { not_what_we_expected: true } });
    const r4 = await fetchGithubRepoMetrics("owner/repo");
    if (r4.ok) fail("github malformed: should not be ok");
    else pass("github: malformed repo shape → error");

    // Repo OK, languages call 500s — fetcher bails out (matches current behavior)
    mockSequence([
        { kind: "json", body: { stargazers_count: 5, language: "Rust", created_at: "2025-01-01T00:00:00Z" } },
        { kind: "json", status: 500, body: { message: "internal" } },
    ]);
    const r5 = await fetchGithubRepoMetrics("owner/repo");
    if (r5.ok) fail("github languages-500: should not be ok");
    else if (!r5.error.includes("500")) fail("github languages-500: error missing status");
    else pass("github: languages 500 → surfaced as error");

    // Repo + languages OK, commits call missing link header — commitsTotal=null but result still ok
    mockSequence([
        { kind: "json", body: { stargazers_count: 0, language: null, created_at: "2025-06-01T00:00:00Z" } },
        { kind: "json", body: {} },
        { kind: "json", body: [{ commit: { author: { date: "2025-06-15T00:00:00Z" } } }] }, // no link header
    ]);
    const r6 = await fetchGithubRepoMetrics("owner/repo");
    if (!r6.ok) fail("github no-link-header: should still be ok", r6);
    else {
        if (r6.metrics.commitsTotal !== null) fail("commitsTotal should be null without link header");
        else pass("github: missing link header → commitsTotal=null (not crash)");
        if (r6.metrics.lastCommitAt !== "2025-06-15T00:00:00Z") fail("lastCommitAt should come from commits payload");
        else pass("github: lastCommitAt extracted from commits payload");
    }

    // SSRF-style URL — fetcher rejects via the URL guard (no env override here)
    delete process.env.MC_ALLOW_PRIVATE_FETCH;
    // Note: the fetcher hard-codes api.github.com so this can't actually trigger;
    // include for documentation only.
}

// ─── Workday ─────────────────────────────────────────────────────────────

async function testWorkday() {
    // Happy — one page of postings, fewer than PAGE_SIZE so the fetcher stops
    mockNext({ kind: "json", body: {
        total: 2,
        jobPostings: [
            { title: "Senior Engineer", externalPath: "/job/USA-WA/Senior-Engineer_JR1", locationsText: "Seattle, WA", postedOn: "Posted Today", remoteType: "Onsite", bulletFields: ["JR1"] },
            { title: "Staff PM", externalPath: "/job/Remote/Staff-PM_JR2", locationsText: "Remote", postedOn: "Posted 2 Days Ago", remoteType: "Remote" },
        ],
    } });
    const r = await fetchWorkday({
        kind: "workday",
        tenantHost: "boeing.wd1.myworkdayjobs.com",
        careerSite: "EXTERNAL_CAREERS",
        companyName: "Boeing",
    });
    if (!r.ok) { fail("workday happy: not ok", r); }
    else {
        if (r.postings.length !== 2) fail(`workday happy: expected 2 postings, got ${r.postings.length}`);
        else pass("workday happy: 2 postings");
        if (r.postings[0].sourceUrl !== "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/USA-WA/Senior-Engineer_JR1") {
            fail(`workday: sourceUrl wrong (${r.postings[0].sourceUrl})`);
        } else {
            pass("workday: sourceUrl constructed from tenantHost + careerSite + externalPath");
        }
        if (r.postings[0].company !== "Boeing") fail("workday: company not from config");
        else pass("workday: company from config");
        if (r.postings[1].location !== "Remote") fail("workday: location not extracted");
        else pass("workday: location extracted");
    }
    if (lastRequestURL !== "https://boeing.wd1.myworkdayjobs.com/wday/cxs/boeing/EXTERNAL_CAREERS/jobs") {
        fail(`workday: endpoint wrong (${lastRequestURL})`);
    } else {
        pass("workday: endpoint URL derived from tenantHost + careerSite");
    }

    // Malformed body
    mockNext({ kind: "json", body: { not_what_workday_returns: true } });
    const r2 = await fetchWorkday({ kind: "workday", tenantHost: "x.wd1.myworkdayjobs.com", careerSite: "X", companyName: "X" });
    if (r2.ok) fail("workday malformed: should not be ok");
    else pass("workday: malformed → error");

    // HTTP 404 on first page
    mockNext({ kind: "json", status: 404, body: { error: "Not Found" } });
    const r3 = await fetchWorkday({ kind: "workday", tenantHost: "x.wd1.myworkdayjobs.com", careerSite: "MISSING", companyName: "X" });
    if (r3.ok) fail("workday 404: should not be ok");
    else if (!r3.error.includes("404")) fail("workday 404: missing status in error");
    else pass("workday 404 → error");

    // Empty jobPostings array (legitimate empty board)
    mockNext({ kind: "json", body: { total: 0, jobPostings: [] } });
    const r4 = await fetchWorkday({ kind: "workday", tenantHost: "x.wd1.myworkdayjobs.com", careerSite: "X", companyName: "X" });
    if (!r4.ok) fail("workday empty: should be ok with 0 postings");
    else if (r4.postings.length !== 0) fail(`workday empty: expected 0, got ${r4.postings.length}`);
    else pass("workday empty board → ok with 0");
}

// ─── LinkedIn ────────────────────────────────────────────────────────────

async function testLinkedin() {
    // Synthetic LinkedIn guest-page chunk. Real HTML is much messier but the
    // selectors we use are stable.
    const linkedinHtml = `
      <li>
        <div class="base-card base-search-card">
          <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/software-engineer-at-acme-123?refId=xxx&trackingId=yyy">
            <span class="sr-only">Software Engineer</span>
          </a>
          <h3 class="base-search-card__title">Software Engineer</h3>
          <h4 class="base-search-card__subtitle">Acme Inc</h4>
          <span class="job-search-card__location">San Francisco, CA</span>
          <time datetime="2026-05-15">2 days ago</time>
        </div>
      </li>
      <li>
        <div class="base-card base-search-card">
          <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/senior-pm-at-other-456?refId=zzz">
            <span class="sr-only">Senior PM</span>
          </a>
          <h3 class="base-search-card__title">Senior PM</h3>
          <h4 class="base-search-card__subtitle">Other Co</h4>
          <span class="job-search-card__location">Remote</span>
        </div>
      </li>
      <li>
        <div class="not-a-job-card"><a href="/feed/">Not a job</a></div>
      </li>`;

    // Happy path
    mockSequence([
        { kind: "text", body: linkedinHtml },
        { kind: "text", body: "" }, // empty 2nd page — fetcher should stop
    ]);
    const r = await fetchLinkedin({ kind: "linkedin", keywords: "software engineer", companyName: "LinkedIn search" });
    if (!r.ok) { fail("linkedin happy: not ok", r); }
    else {
        if (r.postings.length !== 2) fail(`linkedin happy: expected 2 postings, got ${r.postings.length}`);
        else pass("linkedin happy: 2 postings parsed from synthetic chunk");
        if (r.postings[0].title !== "Software Engineer") fail(`linkedin: title wrong (${r.postings[0].title})`);
        else pass("linkedin: title extracted");
        if (!r.postings[0].sourceUrl.includes("/jobs/view/software-engineer-at-acme-123")) fail("linkedin: sourceUrl wrong");
        else pass("linkedin: sourceUrl canonical (no tracking params)");
        if (r.postings[0].sourceUrl.includes("refId=")) fail("linkedin: tracking params not stripped");
        else pass("linkedin: tracking params stripped");
        if (r.postings[0].company !== "Acme Inc") fail(`linkedin: company should be per-posting subtitle (${r.postings[0].company})`);
        else pass("linkedin: company from per-posting subtitle (not watchlist name)");
        if (r.postings[1].location !== "Remote") fail("linkedin: 2nd posting location wrong");
        else pass("linkedin: location extracted");
    }

    // 429 rate-limit → explicit error
    mockNext({ kind: "text", status: 429, body: "" });
    const r2 = await fetchLinkedin({ kind: "linkedin", keywords: "x", companyName: "x" });
    if (r2.ok) fail("linkedin 429: should not be ok");
    else if (!r2.error.toLowerCase().includes("rate")) fail("linkedin 429: error should mention rate limit");
    else pass("linkedin 429 → rate-limit error");

    // Empty body = no more results
    mockNext({ kind: "text", body: "" });
    const r3 = await fetchLinkedin({ kind: "linkedin", keywords: "nonexistent", companyName: "x" });
    if (!r3.ok) fail("linkedin empty: should be ok");
    else if (r3.postings.length !== 0) fail(`linkedin empty: expected 0, got ${r3.postings.length}`);
    else pass("linkedin empty body → ok with 0");
}

async function main() {
    try {
        await testGreenhouse();
        await testLever();
        await testAshby();
        await testCareersPage();
        await testGithub();
        await testWorkday();
        await testLinkedin();
    } finally {
        globalThis.fetch = realFetch;
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
