/**
 * Hermetic smoke for the ReDoS bound on `careers-page.linkPattern`
 * (security fast-follow, 2026-08-02 — `unsafeRegexSourceReason` in
 * lib/schemas/watchlists.ts).
 *
 *   npx tsx scripts/tests/hermetic/watchlist-link-pattern-redos-smoke.ts
 *
 * WHAT IT PROTECTS. `linkPattern` is a REGEX SOURCE a crew member supplies, and
 * `lib/fetchers/careers-page-fetcher.ts` compiles it with `new RegExp(...)` and
 * runs `.test(...)` once per <a href> on the fetched page. The schema used to
 * bound only its LENGTH (200 chars), which bounds nothing that matters: `(a+)+$`
 * is six characters and backtracks exponentially in the length of the SUBJECT.
 * V8 regex matching is synchronous and uninterruptible, and that fetcher is
 * reached from BOTH tiers — the scheduler (every automatic crawl; a wedge stalls
 * gmail-watch-renew, the prunes, notifications) and the web tier (the initial
 * crawl on create and `POST /api/watchlists/[id]/run`; a wedge pins the event
 * loop serving every other user, the owner included). One crew-authored string
 * was therefore a whole-tier DoS on both.
 *
 * §1 is deliberately the first thing asserted: a guard that bans shapes nobody
 * has shown to be dangerous is cargo-culting, so the suite starts by PROVING
 * `(a+)+$` is catastrophic on this machine before asserting it is rejected.
 *
 * Asserts:
 *   1. The premise — `(a+)+$` against 24 a's + "!" takes far longer than a
 *      linear match, so the rejected shape is dangerous in fact, not by lore.
 *   2. `unsafeRegexSourceReason` accepts every REALISTIC link pattern, including
 *      ones with quantifiers, unrepeated alternation groups, character classes,
 *      escapes and lookaheads. Over-rejection would push users to weaker
 *      patterns, so the negative direction is tested as hard as the positive.
 *   3. …and rejects the catastrophic shapes, uncompilable sources,
 *      backreferences, and over-complex patterns — each with a reason naming
 *      what it saw.
 *   4. The bound is WIRED into the schema, not merely exported: the whole
 *      request shape (`WatchlistPostSchema`, the POST body) rejects a malicious
 *      linkPattern and accepts an ordinary one.
 *   5. It is wired on the PATCH shape too (`WatchlistPatchSchema`) — a create
 *      that is legal and an edit that is not would be a bypass, the same one
 *      the schedule floor had to close.
 *   6. It is wired on the READ path (`hydrateWatchlistConfig`), so a row
 *      hand-edited into the DB or written before this bound existed is refused
 *      at hydrate rather than reaching `new RegExp` in the fetcher.
 *   7. Escapes and character classes are honoured, so `\(a\+\)\+` and `[+*]+`
 *      are literals and stay accepted — the scan reads structure, not bytes.
 *
 * Genuinely hermetic: pure functions and Zod parses. No DB, no network, no PM2.
 */

import {
    unsafeRegexSourceReason,
    MAX_LINK_PATTERN_LEN,
    CareersPageConfigSchema,
    WatchlistPostSchema,
    WatchlistPatchSchema,
} from '@/lib/schemas/watchlists';
import { hydrateWatchlistConfig } from '@/lib/watchlists/hydrate';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}
function section(title: string): void { console.log(`\n── ${title}`); }

const careersConfig = (linkPattern: string) => ({
    kind: 'careers-page' as const,
    rootUrl: 'https://example.invalid/careers',
    linkPattern,
    companyName: 'Example Co',
});

// ── 1. The premise: the banned shape really is catastrophic ─────────────────
//
// 24 a's + "!" is ~2^24 backtracks. Measured at ~150ms on the dev box (an
// M-series Mac); a linear match of the same length is microseconds. The
// threshold is 20ms — a 7x margin — so this fails only if the shape stopped
// being exponential, never because a machine is fast.
const REDOS_SUBJECT_LEN = 24;
const REDOS_MIN_MS = 20;

function elapsedMs(fn: () => void): number {
    const t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
}

section('1. The premise — the shape this suite bans is catastrophic in fact');
{
    const subject = 'a'.repeat(REDOS_SUBJECT_LEN) + '!';
    const evil = new RegExp('(a+)+$');
    const safe = new RegExp('a+$');
    const evilMs = elapsedMs(() => { evil.test(subject); });
    const safeMs = elapsedMs(() => { safe.test(subject); });

    if (evilMs < REDOS_MIN_MS) {
        fail(
            `(a+)+$ against ${REDOS_SUBJECT_LEN} a's took only ${evilMs.toFixed(1)}ms — the premise of ` +
            `this whole guard is that it is exponential. Either V8 gained a backtracking limiter ` +
            `(good news, re-verify the guard is still needed) or the subject length is now too short.`,
        );
    } else {
        pass(
            `(a+)+$ over ${REDOS_SUBJECT_LEN} chars: ${evilMs.toFixed(1)}ms vs ${safeMs.toFixed(3)}ms for the ` +
            `linear equivalent — uninterruptible, on the scheduler's and the web tier's only thread`,
        );
    }
}

// ── 2. Realistic patterns must keep working ─────────────────────────────────
section('2. Ordinary link patterns still validate (over-rejection is a real cost)');
{
    const ACCEPT: Array<[string, string]> = [
        ['/careers/jobs/', 'the literal substring used by every careers-page fixture in this repo'],
        ['/jobs/', 'plain substring'],
        ['/job/\\d+', 'one quantifier, no group'],
        ['/jobs/[0-9]+/', 'character class + quantifier'],
        ['^https://boards\\.greenhouse\\.io/.*/jobs/\\d+$', 'anchored, escaped dots, .* — the common shape'],
        ['(jobs|careers)/\\d+', 'alternation in a group that is NOT repeated'],
        ['(?:en|de|fr)/jobs/', 'non-capturing alternation, unrepeated'],
        ['/(\\d{4,6})/apply', 'counted repetition inside an unrepeated group'],
        ['/careers/.+/apply', 'unbounded quantifier at top level'],
        ['(?=.*apply)/jobs/', 'lookahead containing a quantifier, unrepeated'],
        ['/jobs/[a-z-]+-(?:remote|hybrid)?/?$', 'optional group + optional trailing slash'],
        ['(abc)+', 'a repeated group whose body is FIXED — deterministic, must not be rejected'],
        ['(a+)?', 'a group with a quantifier under `?` — tried at most once, cannot blow up'],
    ];
    let bad = 0;
    for (const [src, why] of ACCEPT) {
        const reason = unsafeRegexSourceReason(src);
        if (reason !== null) { fail(`rejected a legitimate pattern \`${src}\` (${why}): ${reason}`); bad++; }
    }
    if (bad === 0) pass(`all ${ACCEPT.length} realistic link patterns accepted (incl. (abc)+ and (a+)?)`);
}

// ── 3. …and the dangerous ones must not ─────────────────────────────────────
section('3. Catastrophic / uncompilable / over-complex sources rejected');
{
    const REJECT: Array<[string, string]> = [
        ['(a+)+$', 'the canonical nested quantifier'],
        ['(a*)*$', 'nested star'],
        ['([a-z]+)*$', 'nested quantifier over a class'],
        ['(?:a+)+$', 'nested quantifier behind a non-capturing group'],
        ['(\\w+\\s?)*$', 'the classic "trim" ReDoS'],
        ['(a{1,3})+$', 'counted inner repetition still multiplies'],
        ['(a+){10}', 'a bounded outer repeat with a huge exponent is catastrophic in practice'],
        ['(a|a)*$', 'alternation with identical branches under a star'],
        ['(a|ab)*$', 'overlapping alternation under a star'],
        ['/jobs/((\\d+)*)+', 'nesting two levels down'],
        ['(', 'does not compile'],
        ['[', 'does not compile — the shape watchlist-hermetic-smoke stores by hand'],
        ['a{2,1}', 'does not compile (inverted bounds)'],
        ['(\\w+)\\1+', 'a repeated backreference'],
        ['(a)(b)\\2*', 'a backreference under a quantifier'],
        [`${'('.repeat(11)}a${')'.repeat(11)}`, 'group nesting one past the depth cap of 10'],
        [`/${'a+'.repeat(21)}/`, 'more quantifiers than the complexity cap allows'],
    ];
    let missed = 0;
    for (const [src, why] of REJECT) {
        const reason = unsafeRegexSourceReason(src);
        if (reason === null) { fail(`ACCEPTED a dangerous pattern \`${src}\` (${why})`); missed++; }
        else if (typeof reason !== 'string' || reason.length < 10) {
            fail(`rejected \`${src}\` without a usable reason`, reason); missed++;
        }
    }
    if (missed === 0) pass(`all ${REJECT.length} catastrophic / invalid / over-complex sources rejected with a stated reason`);
}

// ── 4. Wired into the request schema, not just exported ─────────────────────
section('4. The POST body schema enforces it');
{
    const evil = careersConfig('(a+)+$');
    const fine = careersConfig('/careers/jobs/');

    const evilCfg = CareersPageConfigSchema.safeParse(evil);
    const fineCfg = CareersPageConfigSchema.safeParse(fine);
    if (evilCfg.success) fail('CareersPageConfigSchema accepted a catastrophic linkPattern');
    else if (!fineCfg.success) fail('CareersPageConfigSchema rejected an ordinary linkPattern', fineCfg.error.issues);
    else pass('CareersPageConfigSchema: `(a+)+$` rejected, `/careers/jobs/` accepted');

    const evilPost = WatchlistPostSchema.safeParse({ name: 'Evil', config: evil });
    const finePost = WatchlistPostSchema.safeParse({ name: 'Fine', config: fine });
    if (evilPost.success) {
        fail('WatchlistPostSchema accepted a catastrophic linkPattern — POST /api/watchlists would store it');
    } else if (!finePost.success) {
        fail('WatchlistPostSchema rejected an ordinary careers-page create', finePost.error.issues);
    } else {
        // The message reaches the user through lib/api-client.ts, so it has to
        // say what is wrong rather than "Invalid input".
        const msg = evilPost.error.issues.map(i => i.message).join(' | ');
        if (!/linkPattern/i.test(msg)) fail('the 400 issue should name linkPattern', msg);
        else pass(`WatchlistPostSchema: rejected with a usable message — "${msg.slice(0, 90)}…"`);
    }

    // A 200-char pattern that is STRUCTURALLY fine is still accepted, and one
    // char more is still refused — the length cap must survive the new check.
    const long = '/x'.repeat(MAX_LINK_PATTERN_LEN / 2);
    if (unsafeRegexSourceReason(long) !== null) fail('a long-but-simple pattern should pass the shape scan');
    else if (CareersPageConfigSchema.safeParse(careersConfig(long)).success !== true) {
        fail(`a ${MAX_LINK_PATTERN_LEN}-char simple pattern should still be accepted`);
    } else if (CareersPageConfigSchema.safeParse(careersConfig(long + '/y')).success !== false) {
        fail('the max-length cap regressed');
    } else pass(`the ${MAX_LINK_PATTERN_LEN}-char length cap still holds alongside the shape scan`);
}

// ── 5. …and on PATCH, so create-legal-then-edit-evil is closed ──────────────
section('5. The PATCH body schema enforces it too');
{
    const evil = WatchlistPatchSchema.safeParse({ config: careersConfig('(a+)+$') });
    const fine = WatchlistPatchSchema.safeParse({ config: careersConfig('/careers/jobs/') });
    if (evil.success) fail('WatchlistPatchSchema accepted a catastrophic linkPattern — the edit-in bypass is open');
    else if (!fine.success) fail('WatchlistPatchSchema rejected an ordinary config edit', fine.error.issues);
    else pass('WatchlistPatchSchema: the create-legal-then-edit-evil bypass is closed');
}

// ── 6. …and on the READ path (defense in depth) ─────────────────────────────
section('6. Stored rows are re-checked at hydrate');
{
    // hydrateWatchlistConfig re-parses the stored JSON on every serialize and at
    // the top of every crawl, so a row written before this bound existed — or
    // hand-edited into the DB — is refused before it reaches the fetcher.
    let threw = false;
    try {
        hydrateWatchlistConfig({ config: JSON.stringify(careersConfig('(a+)+$')), directoryKey: null });
    } catch { threw = true; }

    let ok = true;
    try {
        hydrateWatchlistConfig({ config: JSON.stringify(careersConfig('/careers/jobs/')), directoryKey: null });
    } catch (e) { ok = false; fail('hydrate rejected an ordinary stored config', e); }

    if (!threw) {
        fail('hydrateWatchlistConfig accepted a stored catastrophic linkPattern — a hand-edited row still reaches new RegExp');
    } else if (ok) {
        pass('hydrateWatchlistConfig throws on a stored catastrophic pattern and passes an ordinary one');
    }
}

// ── 7. The scan reads structure, not bytes ──────────────────────────────────
section('7. Escapes and character classes are honoured');
{
    const LITERALS: Array<[string, string]> = [
        ['\\(a\\+\\)\\+', 'an escaped literal "(a+)+" is text, not a nested quantifier'],
        ['[+*]+/jobs/', 'quantifier characters inside a class are literals'],
        ['[)(]+', 'parens inside a class are literals and must not unbalance the scan'],
        ['\\|jobs\\|', 'an escaped pipe is not an alternation'],
        ['[\\]]+', 'an escaped close-bracket inside a class'],
    ];
    let bad = 0;
    for (const [src, why] of LITERALS) {
        const reason = unsafeRegexSourceReason(src);
        if (reason !== null) { fail(`misread \`${src}\` as structure (${why}): ${reason}`); bad++; }
    }
    // …and the same bytes UNESCAPED are still caught, proving §7 is not just
    // "the scan gave up on anything with a backslash".
    if (unsafeRegexSourceReason('(a+)+') === null) { fail('the unescaped form is no longer rejected'); bad++; }
    if (bad === 0) pass(`${LITERALS.length} escaped/classed literals accepted, while their unescaped form is still rejected`);
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log('All checks passed.');
process.exit(0);
