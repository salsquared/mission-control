/**
 * Hermetic smoke for the SPA / embedded-JSON posting-text fallback in
 * lib/resumes/posting.ts:extractPostingTextFromHtml.
 *
 * Client-rendered ATS portals (Dayforce HCM, Next.js boards, schema.org
 * JobPosting emitters) ship a near-empty <body> and serialize the real posting
 * into a <script> blob. The DOM-only scrape returned 0 chars on those pages, so
 * parsePosting threw "empty or too short". This smoke asserts the fallback:
 *
 *   - server-rendered HTML still returns the rendered DOM text (no regression)
 *   - rendered DOM text wins even when an embedded blob is also present
 *   - Dayforce-style __NEXT_DATA__ (jobTitle + jobPostingContent) is recovered
 *   - schema.org JSON-LD JobPosting (plain + @graph-wrapped) is recovered,
 *     with HTML tags stripped and entities decoded
 *   - the i18n string dictionary these blobs carry is NOT mistaken for a job
 *   - a truly empty SPA (no recognizable blob) returns "" (parse then throws)
 *
 *   npx tsx scripts/tests/hermetic/posting-spa-extract-smoke.ts
 */

import { extractPostingTextFromHtml } from "@/lib/resumes/posting";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ── Fixtures ───────────────────────────────────────────────────────────────

const SERVER_RENDERED = `<!doctype html><html><body><main>
  Senior Backend Engineer at Acme Corp. Build distributed systems in TypeScript
  and Postgres. Five years experience required. Apply today to join the team.
</main></body></html>`;

// Dayforce-style: empty <body>, posting nested deep inside __NEXT_DATA__ under a
// node with jobTitle + jobPostingContent. Description fields carry HTML.
const dayforceJson = {
    props: {
        pageProps: {
            dehydratedState: {
                queries: [
                    { state: { data: { irrelevant: "wrapper" } } },
                    {
                        state: {
                            data: {
                                jobPosting: {
                                    jobTitle: "Security Guard (Part Time)",
                                    jobPostingContent: {
                                        jobDescriptionHeader: "<p>Cosm brings experiences to life in <b>immersive environments</b>.</p>",
                                        jobDescription: "<ul><li>Patrol the venue and monitor entry points</li><li>Respond to incidents &amp; write reports</li></ul>",
                                        jobDescriptionFooter: "Cosm is an equal opportunity employer.",
                                    },
                                },
                            },
                        },
                    },
                ],
            },
        },
    },
};
const DAYFORCE_SPA = `<!doctype html><html><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(dayforceJson)}</script>
</body></html>`;

// schema.org JSON-LD JobPosting (the LinkedIn/Greenhouse-style carrier).
const jsonLd = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Data Scientist",
    hiringOrganization: { "@type": "Organization", name: "Globex R&amp;D" },
    description: "<p>Work on <strong>ML pipelines</strong> in Python &amp; Spark. PhD preferred.</p>",
};
const JSONLD_SPA = `<!doctype html><html><body><div id="root"></div>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</body></html>`;

// JSON-LD wrapped in an @graph array (also common).
const JSONLD_GRAPH = `<!doctype html><html><body><div id="root"></div>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "Careers" }, jsonLd] })}</script>
</body></html>`;

// __NEXT_DATA__ that ONLY contains the i18n string dictionary — no job node.
// The looser "grab any description" heuristic would wrongly return "Description".
const I18N_ONLY = `<!doctype html><html><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { messages: { description: "Description", "disable-all": "Disable All", apply: "Apply" } } },
})}</script>
</body></html>`;

// Pure SPA — empty body, no recognizable embedded posting.
const EMPTY_SPA = `<!doctype html><html><body><div id="app"></div><script>window.__BOOT__=1;</script></body></html>`;

// DOM text AND an embedded blob both present — DOM must win.
const DOM_PLUS_EMBEDDED = `<!doctype html><html><body><main>
  RENDERED Marketing Manager role at Initech. Own campaigns end to end here.
</main>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "EMBEDDED Backend Engineer", description: "embedded description text that should not be chosen here" })}</script>
</body></html>`;

// ── Tests ────────────────────────────────────────────────────────────────

function testServerRendered() {
    const text = extractPostingTextFromHtml(SERVER_RENDERED);
    if (text.includes("Senior Backend Engineer") && text.includes("Postgres")) {
        pass("server-rendered: returns rendered DOM text unchanged");
    } else {
        fail("server-rendered: expected DOM text", text.slice(0, 120));
    }
}

function testDomWinsOverEmbedded() {
    const text = extractPostingTextFromHtml(DOM_PLUS_EMBEDDED);
    if (text.includes("RENDERED") && text.includes("Initech") && !text.includes("EMBEDDED")) {
        pass("priority: rendered DOM text wins when both DOM + embedded present");
    } else {
        fail("priority: expected DOM text to win over embedded", text.slice(0, 160));
    }
}

function testDayforceNextData() {
    const text = extractPostingTextFromHtml(DAYFORCE_SPA);
    const ok =
        text.includes("Security Guard (Part Time)") &&
        text.includes("immersive environments") &&
        text.includes("Patrol the venue") &&
        text.includes("Respond to incidents & write reports"); // entity decoded
    if (!ok) { fail("dayforce: expected title + description recovered + entity-decoded", text.slice(0, 240)); return; }
    if (/<\/?(p|b|ul|li|strong)>/i.test(text)) { fail("dayforce: HTML tags not stripped", text.slice(0, 240)); return; }
    pass("dayforce: __NEXT_DATA__ jobTitle + jobPostingContent recovered, tags stripped, entities decoded");
}

function testJsonLd() {
    const text = extractPostingTextFromHtml(JSONLD_SPA);
    const ok =
        text.includes("Data Scientist") &&
        text.includes("Globex R&D") && // hiringOrganization.name, entity decoded
        text.includes("ML pipelines") &&
        text.includes("Python & Spark");
    if (!ok) { fail("json-ld: expected title + org + description recovered", text.slice(0, 240)); return; }
    if (/<\/?(p|strong)>/i.test(text)) { fail("json-ld: HTML tags not stripped", text.slice(0, 240)); return; }
    pass("json-ld: schema.org JobPosting recovered (title + org + description), tags stripped");
}

function testJsonLdGraph() {
    const text = extractPostingTextFromHtml(JSONLD_GRAPH);
    if (text.includes("Data Scientist") && text.includes("ML pipelines")) {
        pass("json-ld @graph: JobPosting node located inside @graph array");
    } else {
        fail("json-ld @graph: expected description recovered from @graph node", text.slice(0, 200));
    }
}

function testI18nNotMistakenForJob() {
    const text = extractPostingTextFromHtml(I18N_ONLY);
    if (text === "") {
        pass("i18n-trap: dictionary-only __NEXT_DATA__ yields no posting text (anchor avoids noise)");
    } else {
        fail("i18n-trap: must NOT extract from the i18n string dictionary", JSON.stringify(text.slice(0, 120)));
    }
}

function testEmptySpa() {
    const text = extractPostingTextFromHtml(EMPTY_SPA);
    if (text === "") {
        pass("empty-spa: no DOM text + no recognizable blob → '' (parsePosting then throws too-short)");
    } else {
        fail("empty-spa: expected empty string", JSON.stringify(text.slice(0, 120)));
    }
}

function main() {
    testServerRendered();
    testDomWinsOverEmbedded();
    testDayforceNextData();
    testJsonLd();
    testJsonLdGraph();
    testI18nNotMistakenForJob();
    testEmptySpa();
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) {
        console.error(`${fails} failure(s).`);
        process.exit(1);
    }
    console.log("All checks passed.");
}

main();
