/**
 * Hermetic unit tests for the four watchlist fetchers.
 *
 *   npx tsx scripts/tests/hermetic/fetcher-unit-smoke.ts
 *
 * Overrides globalThis.fetch with a per-test mock so no external network calls
 * are made. Each fetcher gets a happy-path test plus a handful of edge cases.
 */
import { fetchGreenhouse } from "@/lib/fetchers/greenhouse-fetcher";
import { fetchLever } from "@/lib/fetchers/lever-fetcher";
import { fetchAshby } from "@/lib/fetchers/ashby-fetcher";
import { fetchCareersPage } from "@/lib/fetchers/careers-page-fetcher";
import { fetchWorkday } from "@/lib/fetchers/workday-fetcher";
import { fetchSmartRecruiters } from "@/lib/fetchers/smartrecruiters-fetcher";
import { fetchWorkable } from "@/lib/fetchers/workable-fetcher";
import { fetchRecruitee } from "@/lib/fetchers/recruitee-fetcher";
import { fetchPersonio } from "@/lib/fetchers/personio-fetcher";
import { fetchClearCompany } from "@/lib/fetchers/clearcompany-fetcher";
import { fetchLinkedin } from "@/lib/fetchers/linkedin-fetcher";
import { fetchIndeed } from "@/lib/fetchers/indeed-fetcher";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// Captured before any test patches globalThis.setTimeout, so watchdogs can
// still schedule in real wall-clock time. See testClearCompany.
const REAL_SET_TIMEOUT = globalThis.setTimeout;

type MockSpec =
    | { kind: "json"; status?: number; body: unknown; headers?: Record<string, string> }
    | { kind: "text"; status?: number; body: string; headers?: Record<string, string> }
    | { kind: "throw"; error: Error }
    // Headers resolve normally; the BODY never completes. Emulates undici's
    // wiring of the request signal to the response stream, so `res.json()`
    // rejects if and only if the signal is still armed after headers. This is
    // what distinguishes a timeout that covers the body read from one that was
    // cleared as soon as headers arrived.
    | { kind: "hang" };

const realFetch = globalThis.fetch;
const responseQueue: MockSpec[] = [];
let lastRequestURL: string | null = null;
// The `init` the fetcher passed. Needed to assert on AbortSignal wiring — see
// the timeout case in testClearCompany.
let lastRequestInit: RequestInit | undefined;

// Single-shot semantics: clear the queue first. Tests where the fetcher
// might early-return before calling fetch (invalid input, SSRF guard, etc.)
// would otherwise leak the unused mock into the next test.
function mockNext(spec: MockSpec) { responseQueue.length = 0; responseQueue.push(spec); }
// Multi-shot: replaces the queue with the given sequence (so leaked items
// from a previous test still get cleared).
function mockSequence(specs: MockSpec[]) { responseQueue.length = 0; responseQueue.push(...specs); }
function resetMocks() { responseQueue.length = 0; }

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastRequestURL = typeof input === "string" ? input : input.toString();
    lastRequestInit = init;
    const spec = responseQueue.shift();
    if (!spec) throw new Error(`Unexpected fetch (no mock set) to ${lastRequestURL}`);
    if (spec.kind === "throw") throw spec.error;
    if (spec.kind === "hang") {
        const signal = init?.signal;
        // A body stream that never enqueues. It errors only when the request
        // signal aborts — exactly undici's behaviour. With no signal (or one
        // already cleared by the caller) it stays pending forever, which the
        // caller's watchdog turns into a clean failure.
        const body = new ReadableStream({
            start(controller) {
                if (!signal) return;
                const onAbort = () => controller.error(new Error("This operation was aborted"));
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
            },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } }) as unknown as Response;
    }
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
    if (lastRequestURL !== "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true") fail(`greenhouse URL: ${lastRequestURL}`);
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

    // Mixed page: some valid entries + some missing required fields. The
    // fetcher should skip malformed entries (with a warn log) and ingest the
    // valid ones rather than aborting the whole crawl. Regression guard for
    // 2026-05-19 Boeing failure where one malformed row in a 1,170-job
    // pagination killed the entire run.
    mockNext({ kind: "json", body: {
        total: 4,
        jobPostings: [
            { title: "Valid Engineer", externalPath: "/job/valid-1_JR1", locationsText: "Seattle" },
            { externalPath: "/job/missing-title_JR2" }, // missing title
            { title: "Missing Path" },                  // missing externalPath
            { title: "Another Valid", externalPath: "/job/valid-2_JR3" },
        ],
    } });
    const r5 = await fetchWorkday({ kind: "workday", tenantHost: "x.wd1.myworkdayjobs.com", careerSite: "X", companyName: "X" });
    if (!r5.ok) fail(`workday mixed: should be ok despite malformed rows, got error: ${r5.error}`);
    else if (r5.postings.length !== 2) fail(`workday mixed: expected 2 ingested, got ${r5.postings.length}`);
    else if (r5.postings[0].title !== "Valid Engineer" || r5.postings[1].title !== "Another Valid") {
        fail(`workday mixed: wrong postings ingested — ${r5.postings.map(p => p.title).join(", ")}`);
    } else pass("workday mixed page: skips malformed rows, ingests valid ones");
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

// ─── Indeed ──────────────────────────────────────────────────────────────

async function testIndeed() {
    // Synthetic Indeed search-page chunk. The fetcher anchors on `data-jk`
    // (stable since 2018) and `data-testid` attributes for within-card lookup.
    const indeedHtml = `
      <div class="cardOutline job_seen_beacon">
        <a class="jcs-JobTitle" data-jk="abc123" href="/rc/clk?jk=abc123&fccid=xxx&vjs=3">
          <h2 data-testid="jobTitle">Software Engineer</h2>
        </a>
        <span data-testid="company-name">Acme Inc</span>
        <div data-testid="text-location">San Francisco, CA</div>
        <span data-testid="myJobsStateDate">2 days ago</span>
        <div data-testid="job-snippet">Build cool things in Rust.</div>
      </div>
      <div class="cardOutline job_seen_beacon">
        <a class="jcs-JobTitle" data-jk="def456" href="/viewjob?jk=def456">
          <h2 data-testid="jobTitle">Senior PM</h2>
        </a>
        <span data-testid="company-name">Other Co</span>
        <div data-testid="text-location">Remote</div>
      </div>
      <div class="cardOutline job_seen_beacon">
        <a class="jcs-JobTitle" data-jk="abc123" href="/viewjob?jk=abc123">
          <h2 data-testid="jobTitle">Dup of first</h2>
        </a>
      </div>
      <div class="not-a-card">
        <p>Just some chrome — no data-jk here, fetcher should skip.</p>
      </div>`;

    // Happy path
    mockSequence([
        { kind: "text", body: indeedHtml },
        { kind: "text", body: "" }, // empty 2nd page — fetcher should stop
    ]);
    const r = await fetchIndeed({ kind: "indeed", keywords: "software engineer", companyName: "Indeed search" });
    if (!r.ok) { fail("indeed happy: not ok", r); }
    else {
        if (r.postings.length !== 2) fail(`indeed happy: expected 2 postings (dup data-jk should collapse), got ${r.postings.length}`);
        else pass("indeed happy: 2 postings parsed, duplicate data-jk deduped");
        if (r.postings[0].title !== "Software Engineer") fail(`indeed: title wrong (${r.postings[0].title})`);
        else pass("indeed: title from data-testid=jobTitle");
        if (r.postings[0].sourceUrl !== "https://www.indeed.com/viewjob?jk=abc123") fail(`indeed: sourceUrl should reconstruct to /viewjob?jk=… regardless of original href shape (got ${r.postings[0].sourceUrl})`);
        else pass("indeed: sourceUrl canonical (/viewjob?jk=…, not /rc/clk)");
        if (r.postings[0].company !== "Acme Inc") fail(`indeed: company should come from per-card data-testid (got ${r.postings[0].company})`);
        else pass("indeed: company from per-card data-testid (not watchlist name)");
        if (r.postings[0].location !== "San Francisco, CA") fail(`indeed: location wrong (${r.postings[0].location})`);
        else pass("indeed: location from data-testid=text-location");
        if (!r.postings[0].snippet || !r.postings[0].snippet.includes("2 days ago") || !r.postings[0].snippet.includes("Build cool things in Rust.")) fail(`indeed: snippet should fold date + text (${r.postings[0].snippet})`);
        else pass("indeed: snippet folds date + text");
        if (r.postings[1].location !== "Remote") fail("indeed: 2nd posting location wrong");
        else pass("indeed: 2nd posting location extracted");
    }

    // URL contains the search params (sanity: we built the URL correctly).
    // The multi-word phrase is quoted by buildSearchQuery at fetch time, so
    // `q` is the URL-encoded `"software engineer"` (%22…%22), not a bare phrase.
    if (lastRequestURL && lastRequestURL.includes("q=%22software+engineer%22") && lastRequestURL.includes("fromage=1") && lastRequestURL.includes("sort=date")) {
        pass("indeed: search URL composed (quoted q=, fromage=, sort=)");
    } else {
        fail(`indeed: last URL missing expected params (${lastRequestURL})`);
    }

    // 429 → rate-limit error
    mockNext({ kind: "text", status: 429, body: "" });
    const r2 = await fetchIndeed({ kind: "indeed", keywords: "x", companyName: "x" });
    if (r2.ok) fail("indeed 429: should not be ok");
    else if (!r2.error.toLowerCase().includes("rate")) fail("indeed 429: error should mention rate limit");
    else pass("indeed 429 → rate-limit error");

    // 403 → blocked error
    mockNext({ kind: "text", status: 403, body: "" });
    const r3 = await fetchIndeed({ kind: "indeed", keywords: "x", companyName: "x" });
    if (r3.ok) fail("indeed 403: should not be ok");
    else if (!/cloudflare|block/i.test(r3.error)) fail(`indeed 403: error should mention blocked / cloudflare (${r3.error})`);
    else pass("indeed 403 → blocked error");

    // Cloudflare challenge body → explicit error (200 OK but not real results)
    mockNext({ kind: "text", body: "<html><body><h1>Just a moment...</h1><script>cf-challenge</script></body></html>" });
    const r4 = await fetchIndeed({ kind: "indeed", keywords: "x", companyName: "x" });
    if (r4.ok) fail("indeed cloudflare challenge: should detect challenge body and fail loudly, not silently return 0");
    else if (!/cloudflare|challenge/i.test(r4.error)) fail(`indeed challenge: error should mention cloudflare/challenge (${r4.error})`);
    else pass("indeed cloudflare challenge → explicit error (not silent 0)");

    // Empty body — past the last page
    mockNext({ kind: "text", body: "" });
    const r5 = await fetchIndeed({ kind: "indeed", keywords: "nonexistent", companyName: "x" });
    if (!r5.ok) fail("indeed empty: should be ok");
    else if (r5.postings.length !== 0) fail(`indeed empty: expected 0, got ${r5.postings.length}`);
    else pass("indeed empty body → ok with 0");

    // Optional location → goes into the `l` URL param
    mockSequence([
        { kind: "text", body: indeedHtml },
        { kind: "text", body: "" },
    ]);
    await fetchIndeed({ kind: "indeed", keywords: "engineer", location: "Remote, US", companyName: "x" });
    if (lastRequestURL && /[?&]l=Remote%2C\+US/.test(lastRequestURL)) pass("indeed: location passed via l= param");
    else fail(`indeed: location not in URL (${lastRequestURL})`);

    // timeRange "any" → omits fromage entirely
    resetMocks();
    mockSequence([
        { kind: "text", body: indeedHtml },
        { kind: "text", body: "" },
    ]);
    await fetchIndeed({ kind: "indeed", keywords: "engineer", timeRange: "any", companyName: "x" });
    if (lastRequestURL && !lastRequestURL.includes("fromage=")) pass("indeed: timeRange=any omits fromage");
    else fail(`indeed: timeRange=any should omit fromage (${lastRequestURL})`);
}

// ─── SmartRecruiters ────────────────────────────────────────────────────

async function testSmartRecruiters() {
    // Happy single-page (totalFound matches content.length so the loop stops).
    mockNext({ kind: "json", body: {
        offset: 0, limit: 100, totalFound: 2, content: [
            { id: "744000111", name: "Sr. SW Engineer", location: { fullLocation: "Austin, TX, United States", remote: false, hybrid: true }, department: { label: "Engineering" }, function: { label: "IT" }, typeOfEmployment: { label: "Full-time" } },
            { id: "744000222", name: "Software Engineering Intern", location: { city: "Foster City", region: "CA", country: "us" }, function: { label: "IT" }, typeOfEmployment: { label: "Internship" } },
        ],
    } });
    const r = await fetchSmartRecruiters({ kind: "smartrecruiters", boardSlug: "Visa", companyName: "Visa" });
    if (!r.ok) fail("smartrecruiters happy: not ok", r);
    else if (r.postings.length !== 2) fail(`smartrecruiters happy: expected 2, got ${r.postings.length}`);
    else if (r.postings[0].sourceUrl !== "https://jobs.smartrecruiters.com/Visa/744000111") fail(`smartrecruiters: URL mismatch (${r.postings[0].sourceUrl})`);
    else if (r.postings[0].location !== "Austin, TX, United States") fail(`smartrecruiters: fullLocation should win (${r.postings[0].location})`);
    else if (r.postings[1].location !== "Foster City, CA, us") fail(`smartrecruiters: composed fallback (${r.postings[1].location})`);
    else if (r.postings[1].employmentType !== "internship") fail(`smartrecruiters: typeOfEmployment internship not classified (${r.postings[1].employmentType})`);
    else pass("smartrecruiters happy: 2 postings, URL composed, location & type derived");

    // Case-sensitive slug shows up in the URL — verify lowercase is preserved (no auto-cap).
    if (lastRequestURL && lastRequestURL.includes("/companies/Visa/")) pass("smartrecruiters: slug case preserved in URL");
    else fail(`smartrecruiters: slug case lost (${lastRequestURL})`);

    // Empty board
    mockNext({ kind: "json", body: { offset: 0, limit: 100, totalFound: 0, content: [] } });
    const r2 = await fetchSmartRecruiters({ kind: "smartrecruiters", boardSlug: "empty", companyName: "Empty" });
    if (!r2.ok || r2.postings.length !== 0) fail("smartrecruiters empty: should be ok with 0");
    else pass("smartrecruiters empty → ok with 0");

    // Pagination — first page full, second page tail. Tests offset advance + early stop.
    mockSequence([
        { kind: "json", body: { offset: 0, limit: 100, totalFound: 101, content: Array.from({length:100}, (_,i) => ({ id: `p${i}`, name: `Job ${i}`, location: { fullLocation: "Remote" } })) } },
        { kind: "json", body: { offset: 100, limit: 100, totalFound: 101, content: [{ id: "p100", name: "Last One" }] } },
    ]);
    const r3 = await fetchSmartRecruiters({ kind: "smartrecruiters", boardSlug: "Big", companyName: "Big" });
    if (!r3.ok) fail("smartrecruiters paginated: not ok", r3);
    else if (r3.postings.length !== 101) fail(`smartrecruiters paginated: expected 101, got ${r3.postings.length}`);
    else pass("smartrecruiters paginated: drains 2 pages, stops on totalFound");

    // Non-OK response
    resetMocks();
    mockNext({ kind: "text", status: 404, body: "Not Found" });
    const r4 = await fetchSmartRecruiters({ kind: "smartrecruiters", boardSlug: "missing", companyName: "x" });
    if (r4.ok) fail("smartrecruiters 404: should not be ok");
    else if (!r4.error.includes("404")) fail(`smartrecruiters 404: wrong error (${r4.error})`);
    else pass("smartrecruiters 404 → error");
}

// ─── Workable ───────────────────────────────────────────────────────────

async function testWorkable() {
    // Happy
    mockNext({ kind: "json", body: { name: "Workable", description: null, jobs: [
        { title: "Enterprise AE", shortcode: "39441A01CA", code: null, employment_type: "Full-time", telecommuting: false, department: "Revenue", url: "https://apply.workable.com/j/39441A01CA", application_url: "https://apply.workable.com/j/39441A01CA/apply", country: "United Kingdom", city: "London", state: "" },
        { title: "SRE Intern", shortcode: "ABC123", employment_type: "Internship", telecommuting: true, department: "Engineering", url: "https://apply.workable.com/j/ABC123", city: null, state: null, country: null },
    ] } });
    const r = await fetchWorkable({ kind: "workable", boardSlug: "careers", companyName: "Workable" });
    if (!r.ok) fail("workable happy: not ok", r);
    else if (r.postings.length !== 2) fail(`workable happy: expected 2, got ${r.postings.length}`);
    else if (r.postings[0].location !== "London, United Kingdom") fail(`workable: location join (${r.postings[0].location})`);
    else if (r.postings[1].location !== "Remote") fail(`workable: telecommuting → Remote (${r.postings[1].location})`);
    else if (r.postings[1].employmentType !== "internship") fail(`workable: intern classification (${r.postings[1].employmentType})`);
    else pass("workable happy: 2 postings, location/remote/type derived");

    // Empty jobs
    mockNext({ kind: "json", body: { name: "x", description: null, jobs: [] } });
    const r2 = await fetchWorkable({ kind: "workable", boardSlug: "empty", companyName: "x" });
    if (!r2.ok || r2.postings.length !== 0) fail("workable empty: should be ok with 0");
    else pass("workable empty → ok with 0");

    // Missing url → fallback constructed from shortcode
    mockNext({ kind: "json", body: { name: "x", description: null, jobs: [
        { title: "X", shortcode: "ZZZ", employment_type: "Full-time" },
    ] } });
    const r3 = await fetchWorkable({ kind: "workable", boardSlug: "x", companyName: "x" });
    if (!r3.ok) fail("workable shortcode-only: not ok", r3);
    else if (r3.postings[0].sourceUrl !== "https://apply.workable.com/j/ZZZ") fail(`workable: shortcode fallback URL (${r3.postings[0].sourceUrl})`);
    else pass("workable: sourceUrl falls back to shortcode permalink");

    // Malformed
    mockNext({ kind: "json", body: { notJobs: [] } });
    const r4 = await fetchWorkable({ kind: "workable", boardSlug: "broken", companyName: "x" });
    if (r4.ok) fail("workable malformed: should not be ok");
    else pass("workable malformed → error");
}

// ─── Recruitee ──────────────────────────────────────────────────────────

async function testRecruitee() {
    // Happy
    mockNext({ kind: "json", body: { offers: [
        { id: 2431127, title: "Senior Marketer", slug: "senior-marketer", careers_url: "https://jet.recruitee.com/o/senior-marketer", location: "Amsterdam, Noord-Holland, Netherlands", city: "Amsterdam", country: "Netherlands", remote: false, hybrid: false, employment_type_code: "fulltime_permanent", department: null },
        { id: 99, title: "Engineering Intern", slug: "eng-intern", careers_url: "https://jet.recruitee.com/o/eng-intern", location: null, city: "Berlin", country: "Germany", remote: true, employment_type_code: "internship" },
    ] } });
    const r = await fetchRecruitee({ kind: "recruitee", boardSlug: "jet", companyName: "Jet" });
    if (!r.ok) fail("recruitee happy: not ok", r);
    else if (r.postings.length !== 2) fail(`recruitee happy: expected 2, got ${r.postings.length}`);
    else if (r.postings[0].location !== "Amsterdam, Noord-Holland, Netherlands") fail(`recruitee: location pass-through (${r.postings[0].location})`);
    else if (r.postings[0].employmentType !== "full-time") fail(`recruitee: fulltime_permanent → full-time (${r.postings[0].employmentType})`);
    else if (r.postings[1].location !== "Berlin, Germany") fail(`recruitee: city+country fallback (${r.postings[1].location})`);
    else if (r.postings[1].employmentType !== "internship") fail(`recruitee: internship classification (${r.postings[1].employmentType})`);
    else if (!r.postings[1].snippet?.includes("Remote")) fail(`recruitee: snippet should include Remote (${r.postings[1].snippet})`);
    else pass("recruitee happy: 2 postings, types + location derived");

    // Missing careers_url falls back to slug permalink
    mockNext({ kind: "json", body: { offers: [
        { id: 1, title: "X", slug: "x-job", employment_type_code: "fulltime_permanent" },
    ] } });
    const r2 = await fetchRecruitee({ kind: "recruitee", boardSlug: "co", companyName: "Co" });
    if (!r2.ok) fail("recruitee slug-only: not ok", r2);
    else if (r2.postings[0].sourceUrl !== "https://co.recruitee.com/o/x-job") fail(`recruitee: slug fallback URL (${r2.postings[0].sourceUrl})`);
    else pass("recruitee: sourceUrl falls back to slug permalink");

    // Malformed
    mockNext({ kind: "json", body: { notOffers: [] } });
    const r3 = await fetchRecruitee({ kind: "recruitee", boardSlug: "x", companyName: "x" });
    if (r3.ok) fail("recruitee malformed: should not be ok");
    else pass("recruitee malformed → error");
}

// ─── Personio ───────────────────────────────────────────────────────────

async function testPersonio() {
    // Happy — synthetic but structurally faithful to a real Personio xml.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>1834171</id>
    <office>Munich</office>
    <additionalOffices><office>Berlin</office></additionalOffices>
    <department>Product and Tech</department>
    <name>Staff Software Engineer</name>
    <employmentType>permanent</employmentType>
    <schedule>full-time</schedule>
    <seniority>experienced</seniority>
</position>
<position>
    <id>1834172</id>
    <office>Dublin</office>
    <department>Engineering</department>
    <name>Software Engineering Intern</name>
    <schedule>internship</schedule>
</position>
</workzag-jobs>`;
    mockNext({ kind: "text", body: xml, headers: { "content-type": "application/xml" } });
    const r = await fetchPersonio({ kind: "personio", boardSlug: "personio", companyName: "Personio" });
    if (!r.ok) fail("personio happy: not ok", r);
    else if (r.postings.length !== 2) fail(`personio happy: expected 2, got ${r.postings.length}`);
    else if (r.postings[0].sourceUrl !== "https://personio.jobs.personio.com/job/1834171") fail(`personio: URL composed (${r.postings[0].sourceUrl})`);
    else if (r.postings[0].location !== "Munich / Berlin") fail(`personio: location join (${r.postings[0].location})`);
    else if (r.postings[0].employmentType !== "full-time") fail(`personio: schedule full-time → full-time (${r.postings[0].employmentType})`);
    else if (r.postings[1].employmentType !== "internship") fail(`personio: schedule internship → internship (${r.postings[1].employmentType})`);
    else pass("personio happy: 2 positions parsed, URL + location + type derived");

    // Empty positions
    mockNext({ kind: "text", body: `<?xml version="1.0"?><workzag-jobs></workzag-jobs>` });
    const r2 = await fetchPersonio({ kind: "personio", boardSlug: "empty", companyName: "x" });
    if (!r2.ok || r2.postings.length !== 0) fail("personio empty: should be ok with 0");
    else pass("personio empty → ok with 0");

    // Malformed root
    mockNext({ kind: "text", body: `<?xml version="1.0"?><not-personio></not-personio>` });
    const r3 = await fetchPersonio({ kind: "personio", boardSlug: "x", companyName: "x" });
    if (r3.ok) fail("personio bad root: should not be ok");
    else if (!r3.error.includes("workzag-jobs")) fail(`personio bad root: error should mention root (${r3.error})`);
    else pass("personio missing root → error");

    // Position with no id or name is skipped
    mockNext({ kind: "text", body: `<?xml version="1.0"?><workzag-jobs><position><id>1</id></position><position><name>X</name></position><position><id>2</id><name>Real</name></position></workzag-jobs>` });
    const r4 = await fetchPersonio({ kind: "personio", boardSlug: "x", companyName: "x" });
    if (!r4.ok) fail("personio partial: not ok", r4);
    else if (r4.postings.length !== 1) fail(`personio partial: incomplete positions should be skipped, expected 1, got ${r4.postings.length}`);
    else pass("personio: positions missing id or name are dropped");
}

// ─── ClearCompany ───────────────────────────────────────────────────────

/**
 * ClearCompany paginates UNCONDITIONALLY as of 2026-08-02. Firefly's board is
 * 181 postings and the old unpaginated response was 1,351,175 bytes, which did
 * not reliably complete — `Watchlist.lastError` in prod read
 * `Fetch failed: terminated`. Worse, the old code's paginated fallback was
 * unreachable in exactly that case: the one-shot fetch `return`ed on failure
 * before the fallback loop was entered. These cases pin the new shape:
 * every page (including page 0) goes through identical retry + failure
 * handling, a truncated first page can never yield a partial-but-successful
 * result, and an incomplete crawl is flagged `partial` so job-watcher's
 * SAFETY 2 skips close-detection.
 */
function ccPage(rows: number, totalCount: number, idPrefix: string, pageIndex = 0) {
    return {
        kind: "json" as const,
        body: {
            results: Array.from({ length: rows }, (_, i) => ({
                id: `${idPrefix}-${i}`,
                positionTitle: `Job ${idPrefix}-${i}`,
                applyLink: `https://x.com/${idPrefix}-${i}`,
            })),
            currentPageIndex: pageIndex,
            currentPageCount: rows,
            totalCount,
        },
    };
}

async function testClearCompany() {
    // The fetcher paces itself (PAGE_DELAY_MS between pages, RETRY_DELAY_MS
    // before a retry) because probeClearCompany shares its host. Honoured
    // literally, these cases cost ~8s of pure sleeping. Collapse the clock for
    // the duration instead of adding an env-var seam to production: an env
    // knob like MC_PAGE_DELAY_MS=0 could silently defeat politeness in a real
    // .env, whereas this patch has a blast radius of one function.
    //
    // Delays still elapse (real setTimeout, 0ms) so async ordering is
    // unchanged. AbortSignal.timeout does NOT route through globalThis
    // .setTimeout — it uses an internal timer — so the fetch-timeout path is
    // untouched by this. That asymmetry is load-bearing for the timeout case
    // below.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...a: never[]) => void, _ms?: number, ...args: never[]) =>
        realSetTimeout(fn, 0, ...args)) as unknown as typeof globalThis.setTimeout;
    try {
        await clearCompanyCases();
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
}

async function clearCompanyCases() {
    // Happy single-page (totalCount matches results length so the loop exits).
    mockNext({ kind: "json", body: {
        results: [
            { id: "abc-1", positionTitle: "Senior Software Engineer", departmentName: "Engineering", officeName: "HQ", location: "Cedar Park TX", locations: [{ city: "Cedar Park", subdivision: "TX", country: "US", isRemote: false }], applyLink: "https://example.clearcompany.com/careers/jobs/abc-1", postedDate: "2026-05-11T00:00:00" },
            { id: "abc-2", positionTitle: "GNC Internship", departmentName: "GNC", location: null, locations: [{ city: "Austin", subdivision: "TX", country: "US", isRemote: true }], applyLink: "https://example.clearcompany.com/careers/jobs/abc-2", postedDate: "2026-05-10T00:00:00" },
        ],
        currentPageIndex: 0, currentPageCount: 2, totalCount: 2,
    } });
    const r = await fetchClearCompany({ kind: "clearcompany", boardSlug: "00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5", companyName: "Firefly" });
    if (!r.ok) fail("clearcompany happy: not ok", r);
    else if (r.postings.length !== 2) fail(`clearcompany happy: expected 2, got ${r.postings.length}`);
    else if (r.postings[0].location !== "Cedar Park TX") fail(`clearcompany: flat location should win (${r.postings[0].location})`);
    else if (r.postings[1].location !== "Austin, TX, US") fail(`clearcompany: structured fallback (${r.postings[1].location})`);
    else if (r.postings[1].employmentType !== "internship") fail(`clearcompany: title-inferred internship (${r.postings[1].employmentType})`);
    else if (!r.postings[1].snippet?.includes("Remote")) fail(`clearcompany: remote tag in snippet (${r.postings[1].snippet})`);
    else if (r.partial) fail("clearcompany happy: a drained board must not be flagged partial");
    else pass("clearcompany happy: 2 postings, locations + type derived");

    // Even a single-page board is requested WITH pagination params — page 0 is
    // inside the loop, not a special unparameterized pre-flight.
    if (lastRequestURL && lastRequestURL.includes("?pageIndex=0&pageSize=50")) {
        pass("clearcompany: page 0 is a paginated request (no unpaginated one-shot)");
    } else {
        fail(`clearcompany: page 0 should carry pageIndex/pageSize (${lastRequestURL})`);
    }

    // Pagination — drains across pages and stops on totalCount.
    resetMocks();
    mockSequence([
        // pageIndex=0 — returns 1 of 3
        { kind: "json", body: {
            results: [{ id: "p0", positionTitle: "Job 0", applyLink: "https://x.com/0" }],
            currentPageIndex: 0, currentPageCount: 1, totalCount: 3,
        } },
        // pageIndex=1 — returns 1 more, plus a repeat of p0 to exercise dedup
        { kind: "json", body: {
            results: [
                { id: "p0", positionTitle: "Job 0", applyLink: "https://x.com/0" },
                { id: "p1", positionTitle: "Job 1", applyLink: "https://x.com/1" },
            ],
            currentPageIndex: 1, currentPageCount: 2, totalCount: 3,
        } },
        // pageIndex=2 — returns last 1
        { kind: "json", body: {
            results: [{ id: "p2", positionTitle: "Job 2", applyLink: "https://x.com/2" }],
            currentPageIndex: 2, currentPageCount: 1, totalCount: 3,
        } },
    ]);
    const r2 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "site-uuid-here-needs-20", companyName: "X" });
    if (!r2.ok) fail("clearcompany paginated: not ok", r2);
    else if (r2.postings.length !== 3) fail(`clearcompany paginated: expected 3 (cross-page dup collapses), got ${r2.postings.length}`);
    else if (r2.partial) fail("clearcompany paginated: totalCount reached = drained, must not be partial");
    else pass("clearcompany paginated: drains across pages, dedups by id");

    // Empty board
    mockNext({ kind: "json", body: { results: [], currentPageIndex: 0, currentPageCount: 0, totalCount: 0 } });
    const r3 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "empty-uuid-12345678901234", companyName: "x" });
    if (!r3.ok || r3.postings.length !== 0) fail("clearcompany empty: should be ok with 0");
    else pass("clearcompany empty → ok with 0");

    // Malformed response
    mockNext({ kind: "json", body: { notResults: [] } });
    const r4 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "broken-uuid-1234567890123", companyName: "x" });
    if (r4.ok) fail("clearcompany malformed: should not be ok");
    else pass("clearcompany malformed → error");

    // Postings without applyLink are filtered out (defensive — applyLink is
    // marked optional in the schema since other ClearCompany tenants may
    // disable per-job apply links).
    mockNext({ kind: "json", body: {
        results: [
            { id: "x1", positionTitle: "Has apply", applyLink: "https://x.com/1" },
            { id: "x2", positionTitle: "No apply", applyLink: null },
        ],
        currentPageIndex: 0, currentPageCount: 2, totalCount: 2,
    } });
    const r5 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "partial-uuid-1234567890", companyName: "x" });
    if (!r5.ok) fail("clearcompany filter: not ok", r5);
    else if (r5.postings.length !== 1) fail(`clearcompany filter: expected 1 (apply-link required), got ${r5.postings.length}`);
    else pass("clearcompany: postings without applyLink are dropped");

    // ── Firefly-shaped drain: the regression test for the real bug ──────────
    // 50 + 50 + 50 + 31 = 181 = totalCount, exactly as measured live on
    // 2026-08-02. Four ~380 KB pages instead of one 1,351,175-byte response.
    resetMocks();
    mockSequence([
        ccPage(50, 181, "a", 0),
        ccPage(50, 181, "b", 1),
        ccPage(50, 181, "c", 2),
        ccPage(31, 181, "d", 3),
    ]);
    const r6 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5", companyName: "Firefly" });
    if (!r6.ok) fail("clearcompany firefly-shape: not ok", r6);
    else if (r6.postings.length !== 181) fail(`clearcompany firefly-shape: expected 181, got ${r6.postings.length}`);
    else if (r6.partial) fail("clearcompany firefly-shape: full drain must not be partial");
    else if (responseQueue.length !== 0) fail(`clearcompany firefly-shape: should consume exactly 4 pages, ${responseQueue.length} mock(s) left`);
    else pass("clearcompany: 181-posting board drains in 4 pages, stops on totalCount");

    // ── Truncated FIRST page must NOT yield a partial-but-successful result ──
    // This is the shape the old code could not reach its own fallback for: the
    // one-shot fetch failed and returned before the paginated loop. A body that
    // stops mid-JSON throws in res.json(); after the single bounded retry also
    // fails, the whole crawl must abort with ok:false so the failure lands in
    // Watchlist.lastError instead of being recorded as a healthy run.
    resetMocks();
    mockSequence([
        { kind: "text", body: '{"results":[{"id":"a-1","positionTitle":"Trunc' }, // attempt 1: truncated
        { kind: "text", body: '{"results":[{"id":"a-1","positionTitle":"Trunc' }, // retry: truncated too
    ]);
    const r7 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "trunc-uuid-12345678901234", companyName: "x" });
    if (r7.ok) fail(`clearcompany truncated-first-page: must be ok:false, got ${r7.postings.length} postings (partial=${r7.partial})`);
    else if (!r7.error.includes("pageIndex=0")) fail(`clearcompany truncated-first-page: error should name the page (${r7.error})`);
    else pass("clearcompany: truncated first page → ok:false (never a silent partial success)");

    // Same, via undici's real-world symptom: a thrown `terminated`.
    resetMocks();
    mockSequence([
        { kind: "throw", error: new Error("terminated") },
        { kind: "throw", error: new Error("terminated") },
    ]);
    const r8 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "term-uuid-123456789012345", companyName: "x" });
    if (r8.ok) fail("clearcompany terminated: must be ok:false");
    else if (!r8.error.toLowerCase().includes("terminated")) fail(`clearcompany terminated: error not surfaced (${r8.error})`);
    else pass("clearcompany: connection terminated mid-body → ok:false");

    // ── The single bounded retry actually recovers a transient page ─────────
    resetMocks();
    mockSequence([
        { kind: "throw", error: new Error("terminated") }, // attempt 1 fails
        ccPage(2, 2, "r", 0),                              // retry succeeds
    ]);
    const r9 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "retry-uuid-12345678901234", companyName: "x" });
    if (!r9.ok) fail("clearcompany retry: transient page should recover", r9);
    else if (r9.postings.length !== 2) fail(`clearcompany retry: expected 2, got ${r9.postings.length}`);
    else if (r9.partial) fail("clearcompany retry: recovered drain must not be partial");
    else pass("clearcompany: one bounded retry recovers a transient network failure");

    // ── A mid-drain failure aborts rather than returning what it has ────────
    // Returning ok:true+partial here would clear Watchlist.lastError and bump
    // lastSuccessAt (job-watcher.ts:961), recording a truncating board as
    // healthy. See the rationale comment in the fetcher.
    resetMocks();
    mockSequence([
        ccPage(50, 100, "m", 0),                           // page 0 fine
        { kind: "throw", error: new Error("terminated") }, // page 1 attempt 1
        { kind: "throw", error: new Error("terminated") }, // page 1 retry
    ]);
    const r10 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "mid-uuid-1234567890123456", companyName: "x" });
    if (r10.ok) fail(`clearcompany mid-drain failure: must abort, got ok with ${r10.postings.length} postings`);
    else if (!r10.error.includes("pageIndex=1")) fail(`clearcompany mid-drain: error should name the failing page (${r10.error})`);
    else pass("clearcompany: mid-drain page failure aborts the crawl (no partial success)");

    // ── Non-network failures are NOT retried ───────────────────────────────
    // A trailing good-page mock is left in the queue; if the fetcher had
    // retried, it would have been consumed.
    resetMocks();
    mockSequence([
        { kind: "json", body: { notResults: [] } }, // deterministic shape failure
        ccPage(1, 1, "unused", 0),                  // must survive untouched
    ]);
    const r11 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "shape-uuid-123456789012", companyName: "x" });
    if (r11.ok) fail("clearcompany shape failure: should not be ok");
    else if (responseQueue.length !== 1) fail("clearcompany shape failure: must not be retried (retry consumed the spare mock)");
    else pass("clearcompany: 200-with-bad-shape fails immediately, no retry");

    resetMocks();
    mockSequence([
        { kind: "json", status: 503, body: { error: "unavailable" } },
        ccPage(1, 1, "unused", 0), // must survive untouched
    ]);
    const r12 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "http-uuid-1234567890123", companyName: "x" });
    if (r12.ok) fail("clearcompany 503: should not be ok");
    else if (!r12.error.includes("503")) fail(`clearcompany 503: status missing from error (${r12.error})`);
    else if (responseQueue.length !== 1) fail("clearcompany 503: must not be retried (retry consumed the spare mock)");
    else pass("clearcompany: HTTP error fails immediately, no retry");

    // ── Termination: over-reported totalCount drains on the empty page ──────
    // There is deliberately no "short page ⇒ drained" rule (a short page that
    // hasn't reached totalCount is ambiguous), so an inflated totalCount costs
    // one extra request, plus one more to CONFIRM the empty page, and then
    // resolves unambiguously as drained.
    resetMocks();
    mockSequence([
        ccPage(2, 5, "o", 0),  // claims 5, gives 2
        ccPage(0, 5, "o", 1),  // nothing left
        ccPage(0, 5, "o", 1),  // empty-page confirmation — still nothing
    ]);
    const r13 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "over-uuid-1234567890123", companyName: "x" });
    if (!r13.ok) fail("clearcompany over-reported total: not ok", r13);
    else if (r13.postings.length !== 2) fail(`clearcompany over-reported total: expected 2, got ${r13.postings.length}`);
    else if (r13.partial) fail("clearcompany over-reported total: confirmed empty page = drained, not partial");
    else if (responseQueue.length !== 0) fail("clearcompany over-reported total: empty page should be confirmed with one extra request");
    else pass("clearcompany: over-reported totalCount drains on a CONFIRMED empty page (not partial)");

    // ── A TRANSIENT empty page must not truncate the crawl ─────────────────
    // A valid-JSON `results: []` from a cache/backend hiccup mid-board used to
    // set drained=true / partial=false, so close-detection would run against a
    // 50-of-181 view. job-watcher's SAFETY 1 does NOT catch this: it gates on
    // `fetchResult.postings.length > 0`, which a 50-of-181 crawl passes. The
    // confirmation request recovers the real page and the crawl continues.
    resetMocks();
    mockSequence([
        ccPage(50, 181, "a", 0),
        { kind: "json", body: { results: [], currentPageIndex: 1, currentPageCount: 0, totalCount: 181 } }, // hiccup
        ccPage(50, 181, "b", 1), // confirmation returns the real page
        ccPage(50, 181, "c", 2),
        ccPage(31, 181, "d", 3),
    ]);
    const r16 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "hiccup-uuid-123456789012", companyName: "x" });
    if (!r16.ok) fail("clearcompany transient-empty: not ok", r16);
    else if (r16.postings.length !== 181) fail(`clearcompany transient-empty: a hiccup must not truncate the board — expected 181, got ${r16.postings.length}`);
    else if (r16.partial) fail("clearcompany transient-empty: recovered crawl reached totalCount, must not be partial");
    else pass("clearcompany: transient empty page is confirmed, recovers, and does not truncate the crawl");

    // A failed CONFIRMATION is two stacked anomalies — abort visibly rather
    // than guessing drained-vs-truncated.
    resetMocks();
    mockSequence([
        ccPage(50, 181, "a", 0),
        { kind: "json", body: { results: [], currentPageIndex: 1, currentPageCount: 0, totalCount: 181 } },
        { kind: "throw", error: new Error("terminated") }, // confirm attempt 1
        { kind: "throw", error: new Error("terminated") }, // confirm retry
    ]);
    const r17 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "hicfail-uuid-12345678901", companyName: "x" });
    if (r17.ok) fail(`clearcompany empty-confirm failure: must abort, got ok with ${r17.postings.length} postings`);
    else if (!r17.error.includes("confirming empty pageIndex=1")) fail(`clearcompany empty-confirm failure: error should name the confirmation (${r17.error})`);
    else pass("clearcompany: a failed empty-page confirmation aborts the crawl");

    // ── totalCount is a high-water mark, not the current page's value ───────
    // One page reporting a stale/low count must not short-circuit the crawl.
    // Page 1 below claims totalCount=1 while page 0 said 4; reading the current
    // page would satisfy `all.length (3) >= 1` and drain at 3 of 4.
    resetMocks();
    mockSequence([
        ccPage(2, 4, "h", 0),
        ccPage(1, 1, "i", 1), // stale/low count
        ccPage(1, 4, "j", 2),
    ]);
    const r18 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "hwm-uuid-12345678901234", companyName: "x" });
    if (!r18.ok) fail("clearcompany totalCount high-water mark: not ok", r18);
    else if (r18.postings.length !== 4) fail(`clearcompany totalCount high-water mark: a stale low count must not end the crawl — expected 4, got ${r18.postings.length}`);
    else if (r18.partial) fail("clearcompany totalCount high-water mark: reached the true total, must not be partial");
    else pass("clearcompany: totalCount tracked as a monotonic high-water mark");

    // ── The timeout must cover the BODY read, not just the headers ─────────
    // The original code armed an AbortController with setTimeout and called
    // clearTimeout as soon as loggedFetch resolved — i.e. at HEADERS — leaving
    // `await res.json()` completely untimed. That is precisely where this
    // endpoint fails (a 1.35 MB body that stops streaming), so a stalled read
    // would hang indefinitely rather than failing at FETCH_TIMEOUT_MS. The fix
    // is AbortSignal.timeout, which stays armed through the body read.
    //
    // The `hang` mock resolves headers and then never completes the body,
    // erroring only when the request signal aborts. So:
    //   - signal still armed after headers (AbortSignal.timeout) => res.json()
    //     rejects => `network` failure => one retry => ok:false. ~40ms.
    //   - signal cleared at headers (the old shape) => res.json() never settles
    //     => the watchdog below fires and this FAILS loudly instead of hanging.
    //
    // AbortSignal.timeout is patched down to 20ms for this case only, for the
    // same reason globalThis.setTimeout is collapsed for the whole function:
    // honouring FETCH_TIMEOUT_MS literally would cost 8s x 2 attempts.
    // NOTE a bare presence/aborted assertion on `init.signal` does NOT
    // discriminate here — verified: the old shape's clearTimeout wins the
    // microtask race against a 0ms timer, so the signal looks live in both
    // shapes. Only actually stalling the body read tells them apart.
    {
        const realAbortTimeout = AbortSignal.timeout;
        const patchTarget = AbortSignal as unknown as { timeout: (ms: number) => AbortSignal };
        patchTarget.timeout = () => realAbortTimeout.call(AbortSignal, 20);
        try {
            resetMocks();
            mockSequence([{ kind: "hang" }, { kind: "hang" }]); // first attempt + its retry
            // Cleared as soon as the race settles — an unfired 2s timer would
            // otherwise keep the event loop alive and add 2s to the suite.
            let watchdog: ReturnType<typeof REAL_SET_TIMEOUT> | undefined;
            const outcome = await Promise.race([
                fetchClearCompany({ kind: "clearcompany", boardSlug: "hang-uuid-123456789012345", companyName: "x" })
                    .then(r => ({ hung: false as const, r })),
                // Real wall-clock timer: globalThis.setTimeout is collapsed to
                // 0ms inside testClearCompany and would fire instantly.
                new Promise<{ hung: true }>(resolve => { watchdog = REAL_SET_TIMEOUT(() => resolve({ hung: true }), 2000); }),
            ]);
            clearTimeout(watchdog);
            if (outcome.hung) {
                fail("clearcompany: a stalled response BODY never timed out — the fetch timeout is not armed through res.json() (regression to controller + clearTimeout at headers)");
            } else if (outcome.r.ok) {
                fail("clearcompany: a stalled body should abort into ok:false");
            } else if (!/abort/i.test(outcome.r.error)) {
                fail(`clearcompany: stalled body should surface as an abort (${outcome.r.error})`);
            } else {
                pass("clearcompany: fetch timeout stays armed through the body read (stalled body aborts, not hangs)");
            }
            if (lastRequestInit?.signal) pass("clearcompany: request carries an AbortSignal");
            else fail("clearcompany: no AbortSignal passed to fetch — the request is untimed");
        } finally {
            patchTarget.timeout = realAbortTimeout;
        }
    }

    // ── Termination: a server that repeats a page stops and flags partial ───
    resetMocks();
    mockSequence([
        ccPage(50, 500, "rep", 0),
        ccPage(50, 500, "rep", 1), // identical ids — 0 new
    ]);
    const r14 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "rep-uuid-12345678901234", companyName: "x" });
    if (!r14.ok) fail("clearcompany repeating page: not ok", r14);
    else if (r14.postings.length !== 50) fail(`clearcompany repeating page: expected 50, got ${r14.postings.length}`);
    else if (!r14.partial) fail("clearcompany repeating page: incomplete view must be flagged partial");
    else if (responseQueue.length !== 0) fail("clearcompany repeating page: should stop after the repeat");
    else pass("clearcompany: repeated page stops the crawl and flags partial");

    // ── Termination: MAX_PAGES cap → partial (never a claimed-complete crawl) ─
    // 20 pages x 50 = 1,000-posting cap. Firefly is 181, so ~5.5x headroom —
    // but a board past the cap must not look COMPLETE to close-detection, or
    // every posting beyond it becomes a false-close candidate (the lesson from
    // workday-fetcher's `drained` flag).
    resetMocks();
    mockSequence(Array.from({ length: 20 }, (_, i) => ccPage(50, 9999, `cap${i}`, i)));
    const r15 = await fetchClearCompany({ kind: "clearcompany", boardSlug: "cap-uuid-12345678901234", companyName: "x" });
    if (!r15.ok) fail("clearcompany cap: not ok", r15);
    else if (r15.postings.length !== 1000) fail(`clearcompany cap: expected 1000 (20 x 50), got ${r15.postings.length}`);
    else if (!r15.partial) fail("clearcompany cap: exhausting MAX_PAGES must flag partial");
    else if (responseQueue.length !== 0) fail(`clearcompany cap: should request exactly 20 pages, ${responseQueue.length} left`);
    else pass("clearcompany: MAX_PAGES cap stops at 20 pages and flags partial");
}

async function main() {
    try {
        await testGreenhouse();
        await testLever();
        await testAshby();
        await testCareersPage();
        await testWorkday();
        await testSmartRecruiters();
        await testWorkable();
        await testRecruitee();
        await testPersonio();
        await testClearCompany();
        await testLinkedin();
        await testIndeed();
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
