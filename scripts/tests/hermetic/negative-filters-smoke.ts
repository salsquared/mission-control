/**
 * Hermetic smoke for watchlist negative filters.
 *
 *   npx tsx scripts/tests/hermetic/negative-filters-smoke.ts
 *
 * Exercises the compile + match helpers in lib/postings/negative-filters.ts
 * directly. No DB, no HTTP — the route layer just plumbs these functions over
 * `rows.filter`, so unit-testing them is enough to lock in the behavior.
 */
import {
    compileNegativeFilters,
    matchesNegativeFilters,
    _resetNegativeFilterCache,
} from "@/lib/postings/negative-filters";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const row = (title: string, snippet: string | null, location: string | null) => ({ title, snippet, location });

function main() {
    _resetNegativeFilterCache();

    // ─── null / empty filter columns ───
    if (compileNegativeFilters(null).length !== 0) fail("null filters → empty regex list");
    else pass("null filters → empty regex list");

    if (compileNegativeFilters("[]").length !== 0) fail("empty JSON array → empty regex list");
    else pass("empty JSON array → empty regex list");

    if (matchesNegativeFilters(row("Senior Engineer", null, null), [])) {
        fail("empty regex list never matches");
    } else pass("empty regex list never matches");

    // ─── malformed JSON ───
    if (compileNegativeFilters("not json").length !== 0) fail("malformed JSON → empty regex list");
    else pass("malformed JSON → empty regex list");

    if (compileNegativeFilters('{"k":"v"}').length !== 0) fail("non-array JSON → empty regex list");
    else pass("non-array JSON → empty regex list");

    // ─── basic title match ───
    const internsFilter = compileNegativeFilters(JSON.stringify(["intern"]));
    if (internsFilter.length !== 1) fail("simple filter compiles to 1 regex");
    else pass("simple filter compiles to 1 regex");

    if (!matchesNegativeFilters(row("Software Engineer Intern", null, null), internsFilter)) {
        fail("'intern' matches 'Software Engineer Intern'");
    } else pass("'intern' matches title 'Software Engineer Intern'");

    if (matchesNegativeFilters(row("Senior Engineer", null, null), internsFilter)) {
        fail("'intern' should NOT match 'Senior Engineer'");
    } else pass("'intern' does not match unrelated title");

    // ─── case-insensitive ───
    if (!matchesNegativeFilters(row("INTERN — Robotics", null, null), internsFilter)) {
        fail("regex is case-insensitive");
    } else pass("filter is case-insensitive");

    // ─── snippet + location haystack ───
    const remoteFilter = compileNegativeFilters(JSON.stringify(["remote"]));
    if (!matchesNegativeFilters(row("Engineer", null, "Remote, US"), remoteFilter)) {
        fail("location field is searched");
    } else pass("location field included in haystack");
    if (!matchesNegativeFilters(row("Engineer", "Fully remote position.", null), remoteFilter)) {
        fail("snippet field is searched");
    } else pass("snippet field included in haystack");

    // ─── multiple patterns OR'd ───
    const multi = compileNegativeFilters(JSON.stringify(["intern", "contract"]));
    if (!matchesNegativeFilters(row("Contract Engineer", null, null), multi)) {
        fail("second pattern hits when first does not");
    } else pass("multiple patterns OR'd together");

    // ─── invalid regex silently skipped, others still work ───
    const mixed = compileNegativeFilters(JSON.stringify(["[bad(unterminated", "manager"]));
    if (mixed.length !== 1) fail(`expected 1 valid regex from mixed list, got ${mixed.length}`);
    else pass("invalid regex silently dropped, valid one kept");
    if (!matchesNegativeFilters(row("Product Manager", null, null), mixed)) {
        fail("valid pattern in mixed list still applies");
    } else pass("valid pattern in mixed list still applies");

    // ─── non-string entries dropped ───
    const withGarbage = compileNegativeFilters(JSON.stringify(["", 42, null, "valid"]));
    if (withGarbage.length !== 1) fail(`expected 1 regex from garbage list, got ${withGarbage.length}`);
    else pass("non-string / empty entries dropped");

    // ─── word-boundary regex ───
    const wordBoundary = compileNegativeFilters(JSON.stringify(["\\bjr\\b"]));
    if (!matchesNegativeFilters(row("Jr. Software Engineer", null, null), wordBoundary)) {
        fail("\\b word-boundary regex matches 'Jr.'");
    } else pass("word-boundary regex works");
    if (matchesNegativeFilters(row("Injure Test", null, null), wordBoundary)) {
        fail("\\bjr\\b should NOT match inside 'injure'");
    } else pass("word-boundary regex avoids substring match");

    // ─── cache returns same array reference for same JSON ───
    const a = compileNegativeFilters(JSON.stringify(["cached"]));
    const b = compileNegativeFilters(JSON.stringify(["cached"]));
    if (a !== b) fail("cache miss: same JSON should return the same compiled array");
    else pass("cache hit: identical JSON returns cached array");

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails === 0) console.log("All checks passed.");
    if (fails > 0) process.exit(1);
}

main();
