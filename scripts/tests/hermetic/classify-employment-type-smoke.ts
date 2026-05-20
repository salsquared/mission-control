/**
 * Hermetic smoke for `lib/ai/classify-employment-type.ts`. Mocks chatJSON so
 * no Gemini quota is burned — exercises the batching, schema-shape handling,
 * and missing-id defaulting logic that the live probe at
 * scripts/tests/probes/employment-type-classifier-live.ts cannot cover
 * cheaply (each probe run costs free-tier quota).
 *
 *   npx tsx scripts/tests/hermetic/classify-employment-type-smoke.ts
 *
 * Exercises:
 *   1. Empty input → empty Map, chatFn never called
 *   2. Single-batch input (< 50 items) → 1 chatFn call, all ids returned
 *   3. Multi-batch input (120 items) → 3 chatFn calls of 50/50/20
 *   4. Model drops items from its response → ids still in output, value=null
 *   5. Model returns an invalid employmentType ("manager") → filtered → null
 *   6. Per-batch prompt contains the right input rows in the right shape
 *   7. Sequential dispatch (batch N+1 starts only after batch N resolves)
 *   8. chatFn throw inside a batch propagates (caller handles in job-watcher)
 */
import { classifyEmploymentTypes, type ChatJSONFn } from "@/lib/ai/classify-employment-type";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

interface CallRecord {
    user: string;
    system?: string;
}

function makeItem(i: number, overrides: Partial<{ title: string; snippet: string | null; location: string | null; company: string }> = {}) {
    // Use `in` so an explicit `null` override survives — `??` would coerce it back to the default.
    return {
        id: `posting-${i}`,
        company: "company" in overrides ? overrides.company! : "Acme",
        title: "title" in overrides ? overrides.title! : `Software Engineer ${i}`,
        snippet: "snippet" in overrides ? overrides.snippet! : "Engineering",
        location: "location" in overrides ? overrides.location! : "Remote",
    };
}

function makeMockChat(planner: (callIdx: number, parsedUserInputs: any[]) => { items: { id: string; employmentType: string | null }[] }): { chatFn: ChatJSONFn; calls: CallRecord[] } {
    const calls: CallRecord[] = [];
    const chatFn = (async (opts: any) => {
        calls.push({ user: opts.user, system: opts.system });
        // The user prompt is "Classify each of these postings.\n\n<json>" — parse out the JSON.
        const jsonStart = opts.user.indexOf("[");
        const parsed = JSON.parse(opts.user.slice(jsonStart));
        const callIdx = calls.length - 1;
        const out = planner(callIdx, parsed);
        return out;
    }) as unknown as ChatJSONFn;
    return { chatFn, calls };
}

async function testEmpty() {
    const { chatFn, calls } = makeMockChat(() => ({ items: [] }));
    const result = await classifyEmploymentTypes([], chatFn);
    if (result.size !== 0) fail(`empty: expected empty Map, got ${result.size} entries`);
    else if (calls.length !== 0) fail(`empty: chatFn called ${calls.length} times, expected 0`);
    else pass("empty input → no chatFn call, empty Map");
}

async function testSingleBatchHappy() {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(i));
    const { chatFn, calls } = makeMockChat((_idx, parsed) => ({
        items: parsed.map((p: any) => ({ id: p.id, employmentType: "full-time" })),
    }));
    const result = await classifyEmploymentTypes(items, chatFn);
    if (calls.length !== 1) fail(`single batch: expected 1 chatFn call, got ${calls.length}`);
    else if (result.size !== 10) fail(`single batch: expected 10 results, got ${result.size}`);
    else if (Array.from(result.values()).some(v => v !== "full-time")) fail("single batch: not every result was full-time");
    else pass("10 items → 1 batch, all classified");
}

async function testMultiBatch() {
    const items = Array.from({ length: 120 }, (_, i) => makeItem(i));
    const sizes: number[] = [];
    const { chatFn, calls } = makeMockChat((_idx, parsed) => {
        sizes.push(parsed.length);
        return { items: parsed.map((p: any) => ({ id: p.id, employmentType: "full-time" })) };
    });
    const result = await classifyEmploymentTypes(items, chatFn);
    if (calls.length !== 3) fail(`multi: expected 3 batches, got ${calls.length}`);
    else if (sizes.join(",") !== "50,50,20") fail(`multi: batch sizes wrong (${sizes.join(",")})`);
    else if (result.size !== 120) fail(`multi: expected 120 results, got ${result.size}`);
    else pass("120 items → 3 batches of 50/50/20, all classified");
}

async function testDroppedItems() {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(i));
    // Model only returns answers for the first 5 — the other 5 are silently dropped.
    const { chatFn } = makeMockChat((_idx, parsed) => ({
        items: parsed.slice(0, 5).map((p: any) => ({ id: p.id, employmentType: "full-time" })),
    }));
    const result = await classifyEmploymentTypes(items, chatFn);
    if (result.size !== 10) fail(`dropped: expected all 10 ids in map, got ${result.size}`);
    else {
        const classified = Array.from(result.values()).filter(v => v !== null).length;
        const nulled = Array.from(result.values()).filter(v => v === null).length;
        if (classified !== 5 || nulled !== 5) fail(`dropped: expected 5 classified + 5 null, got ${classified}/${nulled}`);
        else pass("dropped items: model returns 5/10, map has all 10 (5 classified + 5 null)");
    }

    // Specific dropped ids should be null in the map (not missing).
    if (result.get("posting-9") !== null) fail("dropped: expected dropped id to map to null");
    else pass("dropped item: missing-from-response id maps to null (not absent)");
}

async function testInvalidEmploymentType() {
    const items = [makeItem(0), makeItem(1), makeItem(2)];
    // Schema validation will reject the whole batch if a value is outside the enum.
    // So this test verifies the schema is doing its job — chatFn throwing is what
    // bubbles up. We model the model returning an out-of-enum value by having
    // the mock throw (representing the schema-validation failure in chatJSON).
    const { chatFn } = makeMockChat(() => {
        throw new Error("Gemini response failed schema validation: items.0.employmentType: Invalid enum value");
    });
    let threw = false;
    try {
        await classifyEmploymentTypes(items, chatFn);
    } catch (e) {
        threw = (e as Error).message.includes("schema validation");
    }
    if (threw) pass("schema-invalid model response → error propagates (caller handles)");
    else fail("schema-invalid: expected propagating throw, classifier swallowed it");
}

async function testPromptShape() {
    const items = [
        makeItem(0, { title: "Senior Backend Engineer", snippet: "Platform · Core · Full-time", location: "NYC", company: "Acme" }),
        makeItem(1, { title: "Summer 2026 SWE Intern", snippet: null, location: null, company: "Acme" }),
    ];
    const { chatFn, calls } = makeMockChat((_idx, parsed) => ({
        items: parsed.map((p: any) => ({ id: p.id, employmentType: p.title.includes("Intern") ? "internship" : "full-time" })),
    }));
    await classifyEmploymentTypes(items, chatFn);

    if (calls.length !== 1) {
        fail(`prompt: expected 1 call, got ${calls.length}`);
        return;
    }
    const call = calls[0];
    if (!call.system || !call.system.includes("classify job postings")) fail("prompt: system prompt missing or wrong");
    else pass("system prompt is the classifier system prompt");

    // The user prompt should contain id, company, title, department (from snippet), location.
    const jsonStart = call.user.indexOf("[");
    const parsed = JSON.parse(call.user.slice(jsonStart));
    if (parsed.length !== 2) fail(`prompt: expected 2 input rows, got ${parsed.length}`);
    else if (parsed[0].id !== "posting-0" || parsed[1].id !== "posting-1") fail("prompt: ids missing/wrong");
    else if (parsed[0].department !== "Platform · Core · Full-time") fail(`prompt: snippet→department mapping wrong (${parsed[0].department})`);
    else if (parsed[1].department !== null) fail("prompt: null snippet should become null department");
    else if (parsed[1].location !== null) fail("prompt: null location should serialize as null");
    else pass("user prompt shape: {id, company, title, department, location}");
}

async function testSequentialDispatch() {
    const items = Array.from({ length: 75 }, (_, i) => makeItem(i)); // 2 batches
    const callTimestamps: number[] = [];
    const chatFn = (async (opts: any) => {
        callTimestamps.push(Date.now());
        await new Promise(r => setTimeout(r, 80));
        const jsonStart = opts.user.indexOf("[");
        const parsed = JSON.parse(opts.user.slice(jsonStart));
        return { items: parsed.map((p: any) => ({ id: p.id, employmentType: "full-time" })) };
    }) as unknown as ChatJSONFn;

    await classifyEmploymentTypes(items, chatFn);
    if (callTimestamps.length !== 2) fail(`sequential: expected 2 calls, got ${callTimestamps.length}`);
    else {
        const gap = callTimestamps[1] - callTimestamps[0];
        if (gap < 70) fail(`sequential: batches overlapped (gap=${gap}ms, expected ≥70)`);
        else pass(`sequential: batch 2 started ${gap}ms after batch 1 (no Promise.all)`);
    }
}

async function testThrowPropagates() {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(i));
    const chatFn = (async () => {
        throw new Error("Gemini request failed: 429");
    }) as unknown as ChatJSONFn;

    let threw = false;
    try {
        await classifyEmploymentTypes(items, chatFn);
    } catch (e) {
        threw = (e as Error).message.includes("429");
    }
    if (threw) pass("chatFn throw → error propagates from classifier");
    else fail("expected chatFn throw to propagate, was swallowed");
}

async function main() {
    await testEmpty();
    await testSingleBatchHappy();
    await testMultiBatch();
    await testDroppedItems();
    await testInvalidEmploymentType();
    await testPromptShape();
    await testSequentialDispatch();
    await testThrowPropagates();

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
