/**
 * Hermetic smoke for lib/postings/location-expansion.ts. Verifies:
 *
 *   - metro chips expand to their city lists (LA → Long Beach included)
 *   - country chips expand to literal + state-code-suffix needles
 *     (US → ", CA" / ", NY" / "United States" / "USA")
 *   - state-name chips expand to literal + ", XX" suffix
 *   - aliases agree with their canonical metro (LA == Los Angeles, NYC == New York)
 *   - case-insensitive normalization on the input
 *   - unknown chips fall through to literal substring
 *   - empty / whitespace chips return []
 *   - expandLocationFilters dedupes across chips
 *
 *   npx tsx scripts/tests/hermetic/location-expansion-smoke.ts
 */
import { expandLocationFilter, expandLocationFilters, locationMatchesChips } from "@/lib/postings/location-expansion";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function assertIncludes(out: string[], expected: string[], label: string) {
    const miss = expected.filter(e => !out.includes(e));
    if (miss.length) fail(`${label}: missing ${JSON.stringify(miss)} (got ${JSON.stringify(out)})`);
    else pass(`${label}: includes ${JSON.stringify(expected)}`);
}

function assertEquals(out: string[], expected: string[], label: string) {
    const a = JSON.stringify(out);
    const b = JSON.stringify(expected);
    if (a !== b) fail(`${label}: expected ${b}, got ${a}`);
    else pass(`${label}: ${a}`);
}

// ─── Metro expansions ────────────────────────────────────────────────────

function testLAExpansion() {
    const out = expandLocationFilter("Los Angeles");
    assertIncludes(out, ["Los Angeles", "Long Beach", "Pasadena", "Burbank"], "metro 'Los Angeles'");
}

function testNYCExpansion() {
    const out = expandLocationFilter("New York");
    assertIncludes(out, ["New York", "Manhattan", "Brooklyn", "Queens"], "metro 'New York'");
}

function testBayAreaExpansion() {
    const out = expandLocationFilter("Bay Area");
    assertIncludes(out, ["San Francisco", "Oakland", "Palo Alto", "Mountain View"], "metro 'Bay Area'");
}

function testCaseInsensitive() {
    const out = expandLocationFilter("LOS ANGELES");
    assertIncludes(out, ["Long Beach", "Pasadena"], "case 'LOS ANGELES'");
}

// ─── Aliases agree with canonical ────────────────────────────────────────

function testAliases() {
    if (JSON.stringify(expandLocationFilter("LA")) !== JSON.stringify(expandLocationFilter("Los Angeles"))) {
        fail("alias 'LA' should equal 'Los Angeles' expansion");
    } else pass("alias 'LA' == 'Los Angeles'");
    if (JSON.stringify(expandLocationFilter("NYC")) !== JSON.stringify(expandLocationFilter("New York"))) {
        fail("alias 'NYC' should equal 'New York'");
    } else pass("alias 'NYC' == 'New York'");
    if (JSON.stringify(expandLocationFilter("Silicon Valley")) !== JSON.stringify(expandLocationFilter("San Francisco"))) {
        fail("alias 'Silicon Valley' should equal 'San Francisco' (same metro)");
    } else pass("alias 'Silicon Valley' == 'San Francisco'");
}

// ─── Country expansion ───────────────────────────────────────────────────

function testUSExpansion() {
    const out = expandLocationFilter("United States");
    // The state-code suffix needles let "Long Beach, CA" match.
    assertIncludes(out, ["United States", "USA", ", CA", ", NY", ", TX", ", WA"], "country 'United States'");
    if (!out.includes(", DC")) fail("'United States' should include ', DC'");
    else pass("'United States' includes ', DC'");
}

function testCanadaExpansion() {
    const out = expandLocationFilter("Canada");
    assertIncludes(out, ["Canada", ", ON", ", BC", "Toronto", "Vancouver"], "country 'Canada'");
}

function testUKExpansion() {
    const out = expandLocationFilter("United Kingdom");
    assertIncludes(out, ["United Kingdom", ", UK", "London"], "country 'United Kingdom'");
}

// ─── State name expansion ────────────────────────────────────────────────

function testCalifornia() {
    const out = expandLocationFilter("California");
    assertEquals(out, ["California", ", CA"], "state 'California'");
}

function testTexas() {
    const out = expandLocationFilter("Texas");
    assertEquals(out, ["Texas", ", TX"], "state 'Texas'");
}

function testWashingtonStateDisambig() {
    // Plain "Washington" hits the DC metro (a longstanding ambiguity). The
    // 'washington state' alias is what unlocks the state-code suffix.
    const out = expandLocationFilter("Washington State");
    assertEquals(out, ["Washington State", ", WA"], "state 'Washington State'");
}

// ─── Unknown chips fall through ──────────────────────────────────────────

function testUnknownLiteral() {
    const out = expandLocationFilter("Albuquerque");
    assertEquals(out, ["Albuquerque"], "unknown 'Albuquerque' → literal");
}

function testRemoteLiteral() {
    const out = expandLocationFilter("Remote");
    assertEquals(out, ["Remote"], "unknown 'Remote' → literal");
}

// ─── Empty / whitespace ──────────────────────────────────────────────────

function testEmpty() {
    if (expandLocationFilter("").length !== 0) fail("empty input should return []");
    else pass("empty input → []");
    if (expandLocationFilter("   ").length !== 0) fail("whitespace input should return []");
    else pass("whitespace input → []");
}

// ─── Batch dedup ─────────────────────────────────────────────────────────

function testBatchDedup() {
    // "Los Angeles" includes "Long Beach"; "Long Beach" as a separate chip
    // would re-add it. The dedupe step in expandLocationFilters should drop
    // the duplicate (case-insensitive).
    const out = expandLocationFilters(["Los Angeles", "Long Beach"]);
    const lowercased = out.map(s => s.toLowerCase());
    const longBeachCount = lowercased.filter(s => s === "long beach").length;
    if (longBeachCount !== 1) fail(`batch dedupe: expected 1 'long beach', got ${longBeachCount}`);
    else pass("batch dedupe: 'Long Beach' appears once across overlapping chips");
}

function testBatchPreservesUnion() {
    const out = expandLocationFilters(["California", "Texas"]);
    assertIncludes(out, ["California", ", CA", "Texas", ", TX"], "batch California+Texas");
}

// ─── Practical user-case from this session ───────────────────────────────

function testUserCase() {
    // User said: "Long Beach, CA" should match "United States" filter.
    const usNeedles = expandLocationFilter("United States");
    const location = "Long Beach, CA";
    const hit = usNeedles.some(n => location.toLowerCase().includes(n.toLowerCase()));
    if (!hit) fail(`user case: 'Long Beach, CA' should match 'United States' but didn't (needles: ${JSON.stringify(usNeedles.slice(0, 5))}...)`);
    else pass("user case: 'Long Beach, CA' matches 'United States' via ', CA'");

    // User said: "Long Beach" should be in the "Los Angeles" metro.
    const laNeedles = expandLocationFilter("Los Angeles");
    const hit2 = laNeedles.some(n => location.toLowerCase().includes(n.toLowerCase()));
    if (!hit2) fail(`user case: 'Long Beach, CA' should match 'Los Angeles' but didn't`);
    else pass("user case: 'Long Beach, CA' matches 'Los Angeles' metro");
}

// ─── Boundary-aware matching (locationMatchesChips) ──────────────────────

function assertMatch(location: string | null, chips: string[], expected: boolean, label: string) {
    const got = locationMatchesChips(location, chips);
    if (got !== expected) fail(`${label}: locationMatchesChips(${JSON.stringify(location)}, ${JSON.stringify(chips)}) expected ${expected}, got ${got}`);
    else pass(`${label}: ${expected ? "matched" : "rejected"} as expected`);
}

function testCaliforniaRejectsCanada() {
    // The reported bug: the "California" chip expands to a bare ", CA" needle,
    // and unanchored LIKE matched the prefix of ", Canada" / ", CAN". The
    // boundary-aware matcher must reject pure-Canada locations.
    const ca = ["California"];
    assertMatch("Cambridge, Ontario, Canada", ca, false, "California ⊅ 'Cambridge, Ontario, Canada'");
    assertMatch("CAN - Richmond, Canada", ca, false, "California ⊅ 'CAN - Richmond, Canada'");
    assertMatch("Toronto, CAN", ca, false, "California ⊅ 'Toronto, CAN'");
    assertMatch("Canada, Remote", ca, false, "California ⊅ 'Canada, Remote'");
    // ...but genuine California locations still match.
    assertMatch("Long Beach, CA", ca, true, "California ⊇ 'Long Beach, CA'");
    assertMatch("San Francisco, CA | New York, NY", ca, true, "California ⊇ 'San Francisco, CA | New York, NY'");
    assertMatch("Long Beach, California", ca, true, "California ⊇ 'Long Beach, California' (literal)");
    // A multi-location string mixing Canada AND a real CA city still matches
    // on the genuine ", CA" occurrence (every occurrence is scanned).
    assertMatch("London, UK; Ontario, CAN; San Francisco, CA", ca, true, "California ⊇ mixed CAN + 'San Francisco, CA'");
}

function testLAMetroMatch() {
    const la = ["Los Angeles"];
    assertMatch("Long Beach, CA", la, true, "Los Angeles ⊇ 'Long Beach, CA'");
    assertMatch("Pasadena, CA", la, true, "Los Angeles ⊇ 'Pasadena, CA'");
    assertMatch("Cambridge, Ontario, Canada", la, false, "Los Angeles ⊅ 'Cambridge, Ontario, Canada'");
}

function testUSCountryRejectsCanada() {
    // "United States" expands to all ", XX" state-code suffixes — the same
    // ", CA" collision risk. Must reject Canadian rows but keep US ones.
    const us = ["United States"];
    assertMatch("Long Beach, CA", us, true, "United States ⊇ 'Long Beach, CA'");
    assertMatch("Brooklyn, NY", us, true, "United States ⊇ 'Brooklyn, NY'");
    assertMatch("Toronto, CAN", us, false, "United States ⊅ 'Toronto, CAN'");
}

function testEmptyChipsAndNullLocation() {
    assertMatch("Anywhere", [], true, "no chips ⇒ everything matches");
    assertMatch(null, ["California"], false, "null location ⇒ no match under a filter");
    assertMatch(null, [], true, "null location ⇒ matches when no filter");
}

function main() {
    testLAExpansion();
    testNYCExpansion();
    testBayAreaExpansion();
    testCaseInsensitive();
    testAliases();
    testUSExpansion();
    testCanadaExpansion();
    testUKExpansion();
    testCalifornia();
    testTexas();
    testWashingtonStateDisambig();
    testUnknownLiteral();
    testRemoteLiteral();
    testEmpty();
    testBatchDedup();
    testBatchPreservesUnion();
    testUserCase();
    testCaliforniaRejectsCanada();
    testLAMetroMatch();
    testUSCountryRejectsCanada();
    testEmptyChipsAndNullLocation();
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) {
        console.error(`${fails} failure(s).`);
        process.exit(1);
    }
    console.log("All checks passed.");
}

main();
