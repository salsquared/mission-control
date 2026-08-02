/**
 * ClearCompany liveness-probe investigation (2026-08-02).
 *
 * Manual exploration script — no assertions, exit code is not a contract.
 * It exists so the ClearCompany probe design can be re-derived / re-validated
 * later without re-guessing endpoints by hand.
 *
 * Modes:
 *   detail     — THE DESIGN. Single-hop probe of the per-job detail endpoint
 *                careers-api.clearcompany.com/v1/<siteId>/<jobId>, run over a
 *                stratified sample whose expected verdict was established
 *                INDEPENDENTLY (by cross-referencing the live board list
 *                against prisma/prod.db). This is the three-case validation.
 *   interlock  — the mass-false-close guard: a bogus siteId must NOT look like
 *                a removed posting.
 *   endpoints  — the endpoint-shape survey that found the detail path.
 *   twohop     — the REJECTED alternative (posting-url XHR → HRMDirect page),
 *                kept because it documents why the detail endpoint won.
 *
 * Politeness: strictly serial, DELAY_MS between every request. HRMDirect
 * visibly degrades under rapid fire (observed 2026-08-02 — a tight loop made
 * live postings return bodies with neither marker), so do not parallelize.
 *
 *   npx tsx scripts/tests/debug/clearcompany-probe-audit.ts detail
 */
const UA = "mission-control-watcher/1.0 (+https://mc.local; personal job-search agent)";
const SITE_ID = "00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5"; // Firefly Aerospace
const SHORT_NAME = "firefly";
const DELAY_MS = 2500;

/**
 * uuid → what we believe INDEPENDENTLY of the probe, from cross-referencing
 * the live board list against prisma/prod.db on 2026-08-02.
 *
 * The three `alive / 64d stale` rows are the important ones: their lastSeenAt
 * is 64 days old (so job-watcher treats them as close candidates) while the
 * posting is demonstrably still on the live board. They are exactly what a
 * naive "stale ⇒ closed" rule would have false-closed.
 */
const SAMPLE: Array<{ uuid: string; expect: string; note: string }> = [
    { uuid: "3cf500fc-4b07-e198-4396-3c716e6c8137", expect: "alive",  note: "64d stale BUT on live board" },
    { uuid: "78befc30-5633-d0ec-06c8-d45b0dc05c8e", expect: "alive",  note: "64d stale BUT on live board" },
    { uuid: "70fc0bc6-3089-d186-00ac-dd341d12fdec", expect: "alive",  note: "64d stale BUT on live board" },
    { uuid: "ac6f4e4a-71ef-384c-cc0b-d41dd9c7f8c3", expect: "alive",  note: "fresh + on live board" },
    { uuid: "8df4e75b-daec-548b-4cb2-1e109e61aee9", expect: "alive",  note: "fresh + on live board" },
    { uuid: "ec2951b8-ca42-288b-0608-3758b809938a", expect: "closed", note: "absent from live board" },
    { uuid: "9cba58fe-54ea-e3b6-a4dc-aea19019b3b9", expect: "closed", note: "absent from live board" },
    { uuid: "34ce8c7b-b66a-a865-1e0d-c0a19e1ae5d2", expect: "closed", note: "absent from live board" },
    { uuid: "91084ef8-7892-a469-90a1-30a15c5c687b", expect: "closed", note: "absent from live board" },
    { uuid: "00000000-0000-0000-0000-000000000000", expect: "closed", note: "DELIBERATELY BOGUS job id" },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function get(url: string, headers: Record<string, string> = {}) {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    return { status: res.status, body: await res.text() };
}

const detailUrl = (site: string, job: string) =>
    `https://careers-api.clearcompany.com/v1/${site}/${job}`;

/** The verdict logic the real probe implements, mirrored here for validation. */
function classify(jobId: string, status: number, body: string): string {
    if (status === 404) return body.trim().length > 0 ? "closed" : "unknown(empty 404 → board-level)";
    if (status !== 200) return `unknown(HTTP ${status})`;
    try {
        const j = JSON.parse(body) as { id?: string };
        return j.id?.toLowerCase() === jobId.toLowerCase() ? "alive" : "unknown(id echo mismatch)";
    } catch { return "unknown(unparseable)"; }
}

async function modeDetail() {
    for (const { uuid, expect, note } of SAMPLE) {
        const { status, body } = await get(detailUrl(SITE_ID, uuid), { Accept: "application/json" });
        const verdict = classify(uuid, status, body);
        const flag = verdict === expect ? "ok  " : verdict.startsWith("unknown") ? "SOFT" : "MISS";
        console.log(`[${flag}] ${uuid} expect=${expect.padEnd(6)} got=${verdict.padEnd(34)} HTTP ${status} ${String(body.length).padStart(6)}b  ${note}`);
        await sleep(DELAY_MS);
    }
}

async function modeInterlock() {
    const LIVE = "d6db08ab-c00d-c94b-2d43-f8ab0ea513ca";
    const cases: Array<[string, string]> = [
        ["valid site + live job",   detailUrl(SITE_ID, LIVE)],
        ["valid site + bogus job",  detailUrl(SITE_ID, "00000000-0000-0000-0000-000000000000")],
        ["BOGUS site + live job",   detailUrl("11111111-2222-3333-4444-555555555555", LIVE)],
        ["BOGUS site #2 + live job", detailUrl("deadbeef-dead-beef-dead-beefdeadbeef", LIVE)],
        ["valid site + junk job id", detailUrl(SITE_ID, "not-a-uuid")],
    ];
    for (const [label, url] of cases) {
        try {
            const { status, body } = await get(url, { Accept: "application/json" });
            console.log(`${label.padEnd(28)} HTTP ${status} ${String(body.length).padStart(6)}b  ${body.slice(0, 90).replace(/\s+/g, " ")}`);
        } catch (e) { console.log(`${label.padEnd(28)} THREW ${(e as Error).message.slice(0, 60)}`); }
        await sleep(DELAY_MS);
    }
}

async function modeEndpoints() {
    const ids: Array<[string, string]> = [
        ["LIVE ", "d6db08ab-c00d-c94b-2d43-f8ab0ea513ca"],
        ["GONE ", "ec2951b8-ca42-288b-0608-3758b809938a"],
        ["BOGUS", "00000000-0000-0000-0000-000000000000"],
    ];
    const paths = [
        (id: string) => detailUrl(SITE_ID, id),
        (id: string) => `https://careers-api.clearcompany.com/v1/${SITE_ID}/jobs/${id}`,
        (id: string) => `https://careers-api.clearcompany.com/v1/jobs/${id}`,
    ];
    for (const [label, id] of ids) {
        for (const p of paths) {
            const url = p(id);
            const { status, body } = await get(url, { Accept: "application/json" });
            console.log(`${label} ${status} ${String(body.length).padStart(8)}b  ${url.replace("https://careers-api.clearcompany.com/", "")}  ${body.slice(0, 60).replace(/\s+/g, " ")}`);
            await sleep(DELAY_MS);
        }
    }
}

/**
 * REJECTED alternative. The public career site is a redirector: its job-detail
 * view GETs `<host>/api/v1/careers/jobs/<id>/posting-url` (needs an
 * `API-ShortName` header) and redirects to an HRMDirect requisition page.
 *
 * Why it lost to the detail endpoint:
 *   - two requests per posting instead of one;
 *   - hop 1 does NOT discriminate — a REMOVED posting still returns 200 with a
 *     posting-url (only a wholly unknown id 404s), so removal detection lands
 *     back on an HTML body marker ("Oops! The position you're looking for does
 *     not exist.") — precisely the body heuristic this work set out to avoid;
 *   - HRMDirect degrades under rapid fire, making that marker unreliable.
 */
async function modeTwoHop() {
    for (const { uuid, expect, note } of SAMPLE) {
        const h1 = await get(
            `https://${SHORT_NAME}.clearcompany.com/api/v1/careers/jobs/${uuid}/posting-url`,
            { Accept: "application/json", "API-ShortName": SHORT_NAME },
        );
        let verdict = "unknown", detail = `hop1 HTTP ${h1.status}`;
        if (h1.status === 404) { verdict = "closed"; detail = "hop1 404"; }
        else if (h1.status === 200) {
            const target = (JSON.parse(h1.body) as string).replace(/#job$/, "");
            await sleep(DELAY_MS);
            const h2 = await get(target);
            const lower = h2.body.toLowerCase();
            const oops = lower.includes("does not exist"), alive = lower.includes('id="job"');
            verdict = oops && !alive ? "closed" : alive && !oops ? "alive" : "unknown";
            detail = `${target.match(/req=\d+/)?.[0] ?? "?"} ${h2.body.length}b oops=${oops} idJob=${alive}`;
        }
        console.log(`[${verdict === expect ? "ok  " : "SOFT"}] ${uuid} expect=${expect.padEnd(6)} got=${verdict.padEnd(7)} ${detail.padEnd(42)} ${note}`);
        await sleep(DELAY_MS);
    }
}

const mode = process.argv[2] ?? "detail";
const run = { detail: modeDetail, interlock: modeInterlock, endpoints: modeEndpoints, twohop: modeTwoHop }[mode];
if (!run) { console.error(`unknown mode "${mode}"`); process.exit(1); }
run().catch(e => { console.error(e); process.exit(1); });
