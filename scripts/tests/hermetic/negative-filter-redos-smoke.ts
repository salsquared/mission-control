/**
 * Hermetic smoke for the ReDoS bound on NEGATIVE FILTERS
 * (security fast-follow, 2026-08-02 — `regexShapeRisk` in
 * lib/schemas/regex-guard.ts).
 *
 *   npx tsx scripts/tests/hermetic/negative-filter-redos-smoke.ts
 *
 * WHAT IT PROTECTS. Negative filters are crew-writable REGEX SOURCES on two
 * surfaces — `Watchlist.negativeFilters` (20 max, PATCH /api/watchlists/[id])
 * and `GlobalSetting.globalNegativeFilters` (40 max, POST /api/settings) — both
 * `requireSession`, so crew write them. Every entry is compiled by
 * lib/postings/negative-filters.ts and `.test()`ed once per posting row at
 * THREE call sites, one of which is inside the request path:
 *
 *   app/api/postings/route.ts        — in a .filter() over every posting row
 *   scheduler/jobs/job-watcher.ts    — every automatic crawl
 *   scheduler/jobs/posting-digest.ts — daily
 *
 * This is a strictly larger exposure than the `linkPattern` case
 * (watchlist-link-pattern-redos-smoke.ts): more patterns, and a ~20,000x row
 * multiplier measured against prod on 2026-08-02.
 *
 * TWO STRUCTURAL FACTS THIS SUITE PINS, because both are easy to regress:
 *
 *   (a) THE READ PATH HAS NO ZOD BOUNDARY. `linkPattern` got read coverage for
 *       free via hydrateWatchlistConfig → WatchlistConfigSchema.parse. Neither
 *       negative-filter read path does: parseNegativeFilters is a hand-rolled
 *       JSON.parse and compileNegativeFilters takes the raw column string. So
 *       the write-schema bound alone leaves stored/hand-edited rows reaching
 *       `new RegExp`, and the skip inside compilePattern is load-bearing, not
 *       belt-and-braces decoration. §4 is what says so.
 *   (b) IT IS SHAPE-ONLY, NOT A COMPILE GATE. negative-filters.ts documents
 *       that an invalid pattern is silently skipped; a user typing `C++` (an
 *       uncompilable but entirely plausible job filter) must keep getting that
 *       no-op rather than a new 400. §5 pins that split against a future
 *       "simplify" that swaps in unsafeRegexSourceReason.
 *
 * Asserts:
 *   1. Every pattern ALREADY STORED in prod.db and dev.db still validates —
 *      verified live on 2026-08-02 (21/21) and frozen here as a fixture, so the
 *      next settings PATCH cannot start failing on data the user never edited.
 *   2. Watchlist negativeFilters: catastrophic shapes rejected, ordinary
 *      keywords and regex escape hatches accepted.
 *   3. Global negativeFilters (the LARGER list, 40): same.
 *   4. The read path skips a stored catastrophic pattern instead of compiling
 *      it, and keeps the other patterns in the same set working.
 *   5. Shape-only: `C++` is accepted by both filter schemas (today's silent
 *      no-op preserved) while still being rejected by linkPattern's compile gate.
 *   6. The amplification is real: the cost of ONE catastrophic match, times the
 *      row count the request path actually iterates.
 *
 * Genuinely hermetic: pure functions and Zod parses. No DB, no network, no PM2.
 */

import { regexShapeRisk, unsafeRegexSourceReason } from '@/lib/schemas/regex-guard';
import { NegativeFiltersSchema, WatchlistPatchSchema, CareersPageConfigSchema } from '@/lib/schemas/watchlists';
import { NegativeFiltersListSchema, SettingsPostSchema } from '@/lib/schemas/settings';
import {
    compileNegativeFiltersFromArray,
    matchesNegativeFilters,
    _resetNegativeFilterCache,
} from '@/lib/postings/negative-filters';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}
function section(title: string): void { console.log(`\n── ${title}`); }

/**
 * Every negative-filter pattern present in prisma/prod.db and prisma/dev.db,
 * read live on 2026-08-02 and frozen here.
 *
 * This is a NO-REGRESSION fixture, not a proof the fix works — it passes with
 * and without the bound, on purpose. Its job is the opposite direction: to fail
 * if the scan is ever tightened in a way that rejects real user data, which
 * would turn the next settings PATCH into a 400 on input nobody edited.
 */
const STORED_IN_PROD_AND_DEV = [
    // prod GlobalSetting
    'senior', 'II', 'III', 'Lead', 'Manager', 'Sr.', 'Director',
    // dev GlobalSetting (superset overlaps prod)
    'government', 'graduate', 'lead', 'director', 'manager', 'head', 'police', 'armed', 'Sr',
    // dev Watchlist.negativeFilters
];

/** Shapes that must never compile on any surface. */
const CATASTROPHIC = [
    '(a+)+$',
    '(\\w+\\s?)*$',
    '([a-z]+)*$',
    '(?:a+)+',
    '(a|ab)*$',
    '(a|a)*',
    '(senior|sr)+$',
];

/** Patterns a real user plausibly types, all of which must keep working. */
const LEGITIMATE = [
    'senior', 'Sr.', 'II', '\\bjr\\b', 'senior.*', 'part[- ]time',
    '^intern', '(senior|staff)', 'level\\s?[123]', 'C#', '.NET',
];

// ── 1. Nothing already stored may break ─────────────────────────────────────
section('1. Every pattern already stored in prod.db + dev.db still validates');
{
    const rejected = STORED_IN_PROD_AND_DEV
        .map(p => [p, regexShapeRisk(p)] as const)
        .filter(([, r]) => r !== null);
    if (rejected.length > 0) {
        fail(
            `the bound rejects ${rejected.length} pattern(s) that are ALREADY STORED — the next ` +
            `settings PATCH would 400 on data the user never edited`,
            rejected,
        );
    } else {
        pass(`all ${STORED_IN_PROD_AND_DEV.length} live-stored patterns accepted (verified against both DBs 2026-08-02)`);
    }

    // …and through the real schemas, since that is what the routes call.
    const g = NegativeFiltersListSchema.safeParse(STORED_IN_PROD_AND_DEV);
    const w = NegativeFiltersSchema.safeParse(STORED_IN_PROD_AND_DEV.slice(0, 20));
    if (!g.success) fail('the stored global list no longer parses', g.error.issues);
    else if (!w.success) fail('the stored watchlist list no longer parses', w.error.issues);
    else pass('the stored corpus round-trips through both real schemas');
}

// ── 2. Watchlist negativeFilters ────────────────────────────────────────────
section('2. Watchlist.negativeFilters (20 max) — PATCH /api/watchlists/[id]');
{
    let missed = 0;
    for (const p of CATASTROPHIC) {
        if (NegativeFiltersSchema.safeParse([p]).success) {
            fail(`NegativeFiltersSchema accepted a catastrophic pattern \`${p}\``); missed++;
        }
    }
    if (missed === 0) pass(`all ${CATASTROPHIC.length} catastrophic shapes rejected by NegativeFiltersSchema`);

    const ok = NegativeFiltersSchema.safeParse(LEGITIMATE);
    if (!ok.success) fail('NegativeFiltersSchema rejected legitimate filters', ok.error.issues);
    else pass(`all ${LEGITIMATE.length} legitimate filters accepted (incl. escape hatches like \\bjr\\b, senior.*)`);

    // The real request shape, and a message the user can act on.
    const bad = WatchlistPatchSchema.safeParse({ negativeFilters: ['senior', '(a+)+$'] });
    const good = WatchlistPatchSchema.safeParse({ negativeFilters: ['senior', 'Sr.'] });
    if (bad.success) {
        fail('WatchlistPatchSchema accepted a catastrophic filter — the PATCH would store it');
    } else if (!good.success) {
        fail('WatchlistPatchSchema rejected an ordinary filter edit', good.error.issues);
    } else {
        const msg = bad.error.issues.map(i => i.message).join(' | ');
        if (!msg.includes('(a+)+$')) fail('the 400 should quote the offending pattern (a list has many entries)', msg);
        else pass(`WatchlistPatchSchema rejects and NAMES the bad entry — "${msg.slice(0, 80)}…"`);
    }
}

// ── 3. Global negativeFilters — the LARGER of the two lists ─────────────────
section('3. GlobalSetting.globalNegativeFilters (40 max) — POST /api/settings');
{
    let missed = 0;
    for (const p of CATASTROPHIC) {
        if (NegativeFiltersListSchema.safeParse([p]).success) {
            fail(`NegativeFiltersListSchema accepted a catastrophic pattern \`${p}\``); missed++;
        }
    }
    if (missed === 0) pass(`all ${CATASTROPHIC.length} catastrophic shapes rejected by NegativeFiltersListSchema`);

    const bad = SettingsPostSchema.safeParse({ negativeFilters: ['senior', '(\\w+\\s?)*$'] });
    const good = SettingsPostSchema.safeParse({ negativeFilters: STORED_IN_PROD_AND_DEV });
    if (bad.success) fail('SettingsPostSchema accepted a catastrophic global filter');
    else if (!good.success) fail('SettingsPostSchema rejected the live-stored global list', good.error.issues);
    else pass('SettingsPostSchema rejects a catastrophic entry, accepts the live-stored list');

    // The count cap must survive the new element check.
    const tooMany = NegativeFiltersListSchema.safeParse(Array.from({ length: 41 }, (_, i) => `k${i}`));
    const atCap = NegativeFiltersListSchema.safeParse(Array.from({ length: 40 }, (_, i) => `k${i}`));
    if (tooMany.success || !atCap.success) fail('the 40-entry cap regressed');
    else pass('the 40-entry count cap still holds alongside the shape scan');
}

// ── 4. The READ path — the half the write schemas do NOT cover ──────────────
section('4. Stored/hand-edited rows are skipped at compile (no Zod on this path)');
{
    _resetNegativeFilterCache();
    // A set as it would sit in the DB: one good pattern, one catastrophic one
    // written before the bound existed (or hand-edited into SQLite).
    const regexes = compileNegativeFiltersFromArray(['senior', '(a+)+$']);

    if (regexes.length !== 1) {
        fail(
            `compilePattern must SKIP the catastrophic entry and keep the good one — got ${regexes.length} ` +
            `regex(es). A stored bad pattern still reaches new RegExp.`,
            regexes.map(String),
        );
    } else {
        // …and the surviving one must still actually filter.
        const hit = matchesNegativeFilters({ title: 'Senior Engineer', snippet: null, location: null }, regexes);
        const miss = matchesNegativeFilters({ title: 'Staff Engineer', snippet: null, location: null }, regexes);
        if (!hit || miss) fail('the surviving filter stopped matching correctly', { hit, miss });
        else pass('read path: catastrophic entry skipped, the good entry in the same set still filters');
    }
    _resetNegativeFilterCache();
}

// ── 5. Shape-only, NOT a compile gate ───────────────────────────────────────
section('5. Uncompilable-but-harmless input keeps its documented silent no-op');
{
    // `C++` is not a valid regex ("Nothing to repeat") but is an entirely
    // plausible negative filter. Today it is silently skipped; turning that into
    // a 400 would be a regression a "simplify to one helper" refactor could
    // easily introduce, so pin both halves of the split.
    const w = NegativeFiltersSchema.safeParse(['C++']);
    const g = NegativeFiltersListSchema.safeParse(['C++']);
    if (!w.success || !g.success) {
        fail('an uncompilable-but-harmless filter must NOT 400 — negative-filters.ts skips it silently', {
            watchlist: w.success ? null : w.error.issues,
            global: g.success ? null : g.error.issues,
        });
    } else if (regexShapeRisk('C++') !== null) {
        fail('regexShapeRisk must not flag `C++` — it is uncompilable, not catastrophic');
    } else if (unsafeRegexSourceReason('C++') === null) {
        fail('unsafeRegexSourceReason (the compile gate) must still reject `C++` for linkPattern');
    } else {
        _resetNegativeFilterCache();
        const compiled = compileNegativeFiltersFromArray(['C++']);
        if (compiled.length !== 0) fail('`C++` should compile to nothing, as before');
        else pass('`C++`: accepted by both filter schemas, silently skipped at compile — unchanged behaviour');
        _resetNegativeFilterCache();
    }

    // The same split, from the other side: linkPattern still refuses it.
    const link = CareersPageConfigSchema.safeParse({
        kind: 'careers-page', rootUrl: 'https://example.invalid/c', linkPattern: 'C++', companyName: 'X',
    });
    if (link.success) fail('linkPattern must keep its compile gate — an invalid pattern is a broken watchlist');
    else pass('linkPattern keeps the compile gate while negative filters keep the lenient one (deliberate asymmetry)');
}

// ── 6. The amplification the row multiplier creates ─────────────────────────
section('6. Why this surface is worse than linkPattern: the row multiplier');
{
    // Measured 2026-08-02: 20,504 JobPosting rows in prod, max haystack 206
    // chars. Per-match cost is comparable to a URL match; the damage comes from
    // running it once per row inside the /api/postings request path.
    const ROWS_IN_PROD = 20_504;
    const evil = new RegExp('(a+)+$', 'i');
    const haystack = `Senior ${'a'.repeat(22)}!\nsnippet\nRemote`;

    const t0 = process.hrtime.bigint();
    evil.test(haystack);
    const oneMatchMs = Number(process.hrtime.bigint() - t0) / 1e6;

    if (oneMatchMs < 1) {
        fail(`one catastrophic match took only ${oneMatchMs.toFixed(3)}ms — the premise no longer holds`);
    } else {
        const projectedS = (oneMatchMs * ROWS_IN_PROD) / 1000;
        pass(
            `one match ${oneMatchMs.toFixed(1)}ms × ${ROWS_IN_PROD} prod rows ≈ ${projectedS.toFixed(0)}s of ` +
            `BLOCKED event loop per /api/postings request — and V8 regex is uninterruptible`,
        );
    }

    // …and the guard is what stands between a stored pattern and that cost.
    if (regexShapeRisk('(a+)+$') === null) fail('the guard no longer rejects the pattern measured above');
    else pass('that exact pattern is refused at both the write schemas and the compile boundary');
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log('All checks passed.');
process.exit(0);
