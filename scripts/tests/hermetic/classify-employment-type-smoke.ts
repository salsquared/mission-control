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
 *   5. Tolerant schema: bare array rewrapped; out-of-enum/wrong-case → null; non-array `types` rejected
 *   6. Per-batch prompt contains the right input rows in the right shape
 *   7. Sequential dispatch (batch N+1 starts only after batch N resolves)
 *   8. Per-batch isolation: one failing batch nulls its items; other batches survive (no whole-sweep throw)
 */
import { classifyEmploymentTypes, ResultSchema, type ChatJSONFn } from "@/lib/ai/classify-employment-type";

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

interface ParsedRow { i: number; company: string; title: string; location: string }

// The new user prompt is "Classify each line below ...\n\n<lines>" where each
// line is `index|company|title|location`. Parse it back into ParsedRow[] so
// the planner can reason about what the classifier sent.
function parseUserPrompt(user: string): ParsedRow[] {
    const lines = user.split("\n\n").slice(1).join("\n\n").split("\n").filter(Boolean);
    return lines.map(line => {
        const [idx, company, title, location] = line.split("|");
        return { i: Number(idx), company: company ?? "", title: title ?? "", location: location ?? "" };
    });
}

function makeMockChat(planner: (callIdx: number, parsedUserInputs: ParsedRow[]) => { types: (string | null)[] }): { chatFn: ChatJSONFn; calls: CallRecord[] } {
    const calls: CallRecord[] = [];
    const chatFn = (async (opts: any) => {
        calls.push({ user: opts.user, system: opts.system });
        const parsed = parseUserPrompt(opts.user);
        const callIdx = calls.length - 1;
        return planner(callIdx, parsed);
    }) as unknown as ChatJSONFn;
    return { chatFn, calls };
}

async function testEmpty() {
    const { chatFn, calls } = makeMockChat(() => ({ types: [] }));
    const result = await classifyEmploymentTypes([], chatFn);
    if (result.size !== 0) fail(`empty: expected empty Map, got ${result.size} entries`);
    else if (calls.length !== 0) fail(`empty: chatFn called ${calls.length} times, expected 0`);
    else pass("empty input → no chatFn call, empty Map");
}

async function testSingleBatchHappy() {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(i));
    const { chatFn, calls } = makeMockChat((_idx, parsed) => ({
        types: parsed.map(() => "full-time"),
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
        return { types: parsed.map(() => "full-time") };
    });
    const result = await classifyEmploymentTypes(items, chatFn);
    if (calls.length !== 3) fail(`multi: expected 3 batches, got ${calls.length}`);
    else if (sizes.join(",") !== "50,50,20") fail(`multi: batch sizes wrong (${sizes.join(",")})`);
    else if (result.size !== 120) fail(`multi: expected 120 results, got ${result.size}`);
    else pass("120 items → 3 batches of 50/50/20, all classified");
}

async function testDroppedItems() {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(i));
    // Model only returns the first 5 entries — positional alignment means
    // items[0..4] get a type, items[5..9] fall through to the null default.
    const { chatFn } = makeMockChat((_idx, parsed) => ({
        types: parsed.slice(0, 5).map(() => "full-time"),
    }));
    const result = await classifyEmploymentTypes(items, chatFn);
    if (result.size !== 10) fail(`dropped: expected all 10 ids in map, got ${result.size}`);
    else {
        const classified = Array.from(result.values()).filter(v => v !== null).length;
        const nulled = Array.from(result.values()).filter(v => v === null).length;
        if (classified !== 5 || nulled !== 5) fail(`dropped: expected 5 classified + 5 null, got ${classified}/${nulled}`);
        else pass("dropped items: model returns 5/10, map has all 10 (5 classified + 5 null)");
    }

    // Specific dropped position (the trailing items) should be null.
    if (result.get("posting-9") !== null) fail("dropped: expected dropped id to map to null");
    else pass("dropped item: position past response length maps to null (not absent)");
}

async function testTolerantSchema() {
    // The tolerant ResultSchema is applied inside the REAL chatJSON (which the
    // mock seam bypasses), so exercise it directly against the kinds of
    // malformed payloads the cheap model actually emits.

    // (a) bare array instead of the {types:[...]} wrapper → rewrapped.
    const bare = ResultSchema.safeParse(["full-time", "internship", null]);
    if (!bare.success) fail("tolerant: bare array rejected", bare.error);
    else if (bare.data.types.length !== 3 || bare.data.types[0] !== "full-time" || bare.data.types[2] !== null)
        fail("tolerant: bare array rewrapped wrong", bare.data.types);
    else pass("tolerant: bare array [...] rewrapped to {types:[...]}");

    // (b) out-of-enum + wrong-case items coerce to null; valid ones survive —
    // so one bad item no longer poisons its 49 neighbors.
    const mixed = ResultSchema.safeParse({ types: ["full-time", "manager", "Internship", null, "contract"] });
    if (!mixed.success) fail("tolerant: a bad item failed the whole parse", mixed.error);
    else if (mixed.data.types[0] !== "full-time" || mixed.data.types[1] !== null
          || mixed.data.types[2] !== null || mixed.data.types[3] !== null || mixed.data.types[4] !== "contract")
        fail("tolerant: bad items not coerced to null / valid ones dropped", mixed.data.types);
    else pass("tolerant: out-of-enum ('manager') + wrong-case ('Internship') coerce to null, valid survive");

    // (c) genuinely unparseable (`types` not an array) must still FAIL so the
    // per-batch isolation can default it to null (rather than silently caching garbage).
    const garbage = ResultSchema.safeParse({ types: "nope" });
    if (garbage.success) fail("tolerant: non-array `types` should not parse", garbage.data);
    else pass("tolerant: non-array `types` fails parse (→ per-batch isolation handles it)");
}

async function testPromptShape() {
    const items = [
        makeItem(0, { title: "Senior Backend Engineer", snippet: "Platform · Core · Full-time", location: "NYC", company: "Acme" }),
        makeItem(1, { title: "Summer 2026 SWE Intern", snippet: null, location: null, company: "Acme" }),
    ];
    const { chatFn, calls } = makeMockChat((_idx, parsed) => ({
        types: parsed.map(p => p.title.includes("Intern") ? "internship" : "full-time"),
    }));
    await classifyEmploymentTypes(items, chatFn);

    if (calls.length !== 1) {
        fail(`prompt: expected 1 call, got ${calls.length}`);
        return;
    }
    const call = calls[0];
    if (!call.system || !call.system.includes("Classify each posting")) fail("prompt: system prompt missing or wrong");
    else pass("system prompt is the classifier system prompt");

    // The user prompt is `index|company|title|location` lines. No id/snippet —
    // ids are positional, snippet was dropped (title is the load-bearing signal).
    const parsed = parseUserPrompt(call.user);
    if (parsed.length !== 2) fail(`prompt: expected 2 input rows, got ${parsed.length}`);
    else if (parsed[0].i !== 0 || parsed[1].i !== 1) fail("prompt: positional indices missing/wrong");
    else if (parsed[0].title !== "Senior Backend Engineer" || parsed[1].title !== "Summer 2026 SWE Intern") fail("prompt: titles wrong");
    else if (parsed[0].company !== "Acme") fail(`prompt: company mapping wrong (${parsed[0].company})`);
    else if (parsed[0].location !== "NYC") fail(`prompt: location mapping wrong (${parsed[0].location})`);
    else if (parsed[1].location !== "") fail("prompt: null location should serialize as empty string");
    else pass("user prompt shape: positional `index|company|title|location` lines");
}

async function testSequentialDispatch() {
    const items = Array.from({ length: 75 }, (_, i) => makeItem(i)); // 2 batches
    const callTimestamps: number[] = [];
    const chatFn = (async (opts: any) => {
        callTimestamps.push(Date.now());
        await new Promise(r => setTimeout(r, 80));
        const parsed = parseUserPrompt(opts.user);
        return { types: parsed.map(() => "full-time") };
    }) as unknown as ChatJSONFn;

    await classifyEmploymentTypes(items, chatFn);
    if (callTimestamps.length !== 2) fail(`sequential: expected 2 calls, got ${callTimestamps.length}`);
    else {
        const gap = callTimestamps[1] - callTimestamps[0];
        if (gap < 70) fail(`sequential: batches overlapped (gap=${gap}ms, expected ≥70)`);
        else pass(`sequential: batch 2 started ${gap}ms after batch 1 (no Promise.all)`);
    }
}

async function testPerBatchIsolation() {
    // 120 items → 3 batches (50/50/20). The 2nd batch throws (a malformed
    // response the tolerant schema couldn't salvage); batches 1 + 3 succeed.
    // The sweep must NOT throw, and must keep batches 1 + 3's results — one bad
    // batch can no longer discard the whole run (the bug that made the live
    // sweep persist ~nothing).
    const items = Array.from({ length: 120 }, (_, i) => makeItem(i));
    let call = 0;
    const chatFn = (async (opts: any) => {
        const idx = call++; // sequential dispatch ⇒ idx 0/1/2 = batch 1/2/3
        const parsed = parseUserPrompt(opts.user);
        if (idx === 1) throw new Error("Gemini response failed schema validation: types: expected array");
        return { types: parsed.map(() => "full-time") };
    }) as unknown as ChatJSONFn;

    let threw = false;
    let result = new Map<string, string | null>();
    try {
        result = await classifyEmploymentTypes(items, chatFn) as Map<string, string | null>;
    } catch {
        threw = true;
    }
    if (threw) { fail("per-batch isolation: a single failing batch threw the whole sweep"); return; }
    if (result.size !== 120) { fail(`per-batch isolation: expected all 120 ids present, got ${result.size}`); return; }

    const classified = Array.from(result.values()).filter(v => v === "full-time").length;
    const nulled = Array.from(result.values()).filter(v => v === null).length;
    if (classified !== 70 || nulled !== 50) fail(`per-batch isolation: expected 70 classified + 50 null, got ${classified}/${nulled}`);
    else pass("per-batch isolation: failed batch 2 → its 50 items null, batches 1+3 (70) survive, no throw");

    // batch 2 = items 50..99 → those ids null; a batch-1 id stays classified.
    if (result.get("posting-50") !== null) fail("per-batch isolation: failed-batch item should be null");
    else if (result.get("posting-0") !== "full-time") fail("per-batch isolation: surviving-batch item lost its classification");
    else pass("per-batch isolation: failed-batch ids null, surviving-batch ids classified");
}

async function main() {
    await testEmpty();
    await testSingleBatchHappy();
    await testMultiBatch();
    await testDroppedItems();
    await testTolerantSchema();
    await testPromptShape();
    await testSequentialDispatch();
    await testPerBatchIsolation();

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
