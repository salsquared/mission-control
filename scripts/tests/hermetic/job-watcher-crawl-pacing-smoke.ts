/**
 * Hermetic smoke for runDueWatchlists' inter-crawl pacing
 * (scheduler/jobs/job-watcher.ts). Asserts that a jittered gap is inserted
 * BEFORE the 2nd, 3rd, … crawl to a fragile scraped source (LinkedIn/Indeed)
 * within a tick — never before the first, never after the last, never around
 * ATS-API sources — and that a crawl throwing still counts as a fragile
 * attempt + doesn't abort the batch.
 *
 * Fully injected (loadDue + processFn + sleepFn + jitterMs) → no DB, no network,
 * no real timer. Deterministic.
 *
 *   1. Three LinkedIn crawls → 2 gaps (before #2 and #3), each = jitter value.
 *   2. Two ATS crawls (greenhouse/lever) → 0 gaps.
 *   3. [LI, greenhouse, LI] → 1 gap (before the 2nd LI; the ATS in between
 *      doesn't get a gap and doesn't reset the "fragile seen" state).
 *   4. [indeed, linkedin] → 1 gap (both fragile, cross-source still spaced).
 *   5. Single LinkedIn → 0 gaps (never gap the first/last).
 *   6. processFn throws on the 2nd of [LI, LI(throws), LI] → all 3 attempted,
 *      result #2 carries the error, and 2 gaps still inserted (throw still
 *      counts as a fragile attempt).
 *   7. Crawl ORDER is preserved and processed count == due length.
 *   8. isFragileSource: linkedin/indeed true; greenhouse/lever/workday false.
 */
import { runDueWatchlists, isFragileSource, type RunDueDeps } from "@/scheduler/jobs/job-watcher";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const JITTER = 5_000;
const dummyResult = (id: string) => ({
    watchlistId: id, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: null,
});

/** Run with an injected due-list; record crawl order + the sleep durations. */
async function run(
    due: Array<{ id: string; kind: string }>,
    opts: { throwOn?: string } = {},
) {
    const crawlOrder: string[] = [];
    const sleeps: number[] = [];
    const deps: RunDueDeps = {
        loadDue: async () => due,
        processFn: async (id: string) => {
            crawlOrder.push(id);
            if (opts.throwOn === id) throw new Error(`boom:${id}`);
            return dummyResult(id);
        },
        sleepFn: async (ms: number) => { sleeps.push(ms); },
        jitterMs: () => JITTER,
    };
    const res = await runDueWatchlists(deps);
    return { crawlOrder, sleeps, res };
}

async function main() {
    // 1. Three LinkedIn → 2 gaps.
    {
        const { sleeps, res } = await run([
            { id: "li1", kind: "linkedin" },
            { id: "li2", kind: "linkedin" },
            { id: "li3", kind: "linkedin" },
        ]);
        check("3 LinkedIn → 2 gaps", sleeps.length === 2, `got ${sleeps.length}`);
        check("3 LinkedIn → each gap == jitter", sleeps.every((s) => s === JITTER), JSON.stringify(sleeps));
        check("3 LinkedIn → processed == 3", res.processed === 3, `got ${res.processed}`);
    }

    // 2. Two ATS → 0 gaps.
    {
        const { sleeps } = await run([
            { id: "gh1", kind: "greenhouse" },
            { id: "lv1", kind: "lever" },
        ]);
        check("2 ATS → 0 gaps", sleeps.length === 0, `got ${sleeps.length}`);
    }

    // 3. [LI, greenhouse, LI] → 1 gap before the 2nd LI.
    {
        const { sleeps, crawlOrder } = await run([
            { id: "li1", kind: "linkedin" },
            { id: "gh1", kind: "greenhouse" },
            { id: "li2", kind: "linkedin" },
        ]);
        check("[LI, GH, LI] → 1 gap", sleeps.length === 1, `got ${sleeps.length}`);
        check("[LI, GH, LI] → order preserved", crawlOrder.join(",") === "li1,gh1,li2", crawlOrder.join(","));
    }

    // 4. [indeed, linkedin] → 1 gap (cross fragile source).
    {
        const { sleeps } = await run([
            { id: "in1", kind: "indeed" },
            { id: "li1", kind: "linkedin" },
        ]);
        check("[indeed, linkedin] → 1 gap", sleeps.length === 1, `got ${sleeps.length}`);
    }

    // 5. Single LinkedIn → 0 gaps.
    {
        const { sleeps } = await run([{ id: "li1", kind: "linkedin" }]);
        check("single LinkedIn → 0 gaps", sleeps.length === 0, `got ${sleeps.length}`);
    }

    // 6. Throw on 2nd of three LinkedIn → all attempted, error recorded, 2 gaps.
    {
        const { sleeps, crawlOrder, res } = await run([
            { id: "li1", kind: "linkedin" },
            { id: "li2", kind: "linkedin" },
            { id: "li3", kind: "linkedin" },
        ], { throwOn: "li2" });
        check("throw → all 3 attempted", crawlOrder.join(",") === "li1,li2,li3", crawlOrder.join(","));
        check("throw → result #2 carries error", res.results[1]?.error === "boom:li2", String(res.results[1]?.error));
        check("throw → still 2 gaps (throw counts as fragile attempt)", sleeps.length === 2, `got ${sleeps.length}`);
        check("throw → processed == 3", res.processed === 3, `got ${res.processed}`);
    }

    // 7. Order + processed for a mixed batch.
    {
        const { crawlOrder, res } = await run([
            { id: "a", kind: "greenhouse" },
            { id: "b", kind: "linkedin" },
            { id: "c", kind: "workday" },
        ]);
        check("mixed → order preserved", crawlOrder.join(",") === "a,b,c", crawlOrder.join(","));
        check("mixed → results length == due length", res.results.length === 3, `got ${res.results.length}`);
    }

    // 8. isFragileSource classification.
    check("isFragileSource(linkedin)", isFragileSource("linkedin") === true);
    check("isFragileSource(indeed)", isFragileSource("indeed") === true);
    check("isFragileSource(greenhouse) == false", isFragileSource("greenhouse") === false);
    check("isFragileSource(lever) == false", isFragileSource("lever") === false);
    check("isFragileSource(workday) == false", isFragileSource("workday") === false);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
