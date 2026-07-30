// P1.1 (OQ1a) hermetic smoke for the sign-in allowlist — pure functions over an
// explicit env-value parameter (no process.env mutation, no network, no
// NextAuth), PLUS a wiring check that drives `authOptions.callbacks.signIn`
// itself, because a fail-closed helper nobody calls is worth nothing.
// Run with: npx tsx scripts/tests/hermetic/signin-allowlist-smoke.ts
//
// THE PROPERTY THIS FILE EXISTS TO HOLD (changed 2026-07-29, security
// fast-follow): an unset/blank ALLOWED_SIGNIN_EMAILS DENIES. It used to admit
// everyone ("fail-open-with-warning"), which was defensible when a `User` row
// was near-meaningless and is not now that a `User` row IS authorization to use
// this instance — a blank var would have let anyone past the Cloudflare Access
// edge self-provision as crew through `/api/auth/signin`, one of only two
// unguarded routes. If a future change flips the unset case back to `true`,
// section 1 below goes red.

import {
    ALLOWLIST_ENV,
    allowlistUnconfiguredMessage,
    checkSignInAllowlistAtStartup,
    evaluateSignIn,
    isAllowedSignInEmail,
    isAllowlistConfigured,
    parseAllowlist,
} from '@/lib/auth-allowlist';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const OWNER = 'salsalcedo4321@gmail.com';

// ─── 1. Unset / empty env → FAIL-CLOSED (deny everyone) ──────────────────
{
    record('env undefined: denied', !isAllowedSignInEmail('anyone@evil.com', undefined));
    record('env undefined: owner ALSO denied (no "known address" escape hatch)',
        !isAllowedSignInEmail(OWNER, undefined));
    record('env undefined: null email denied', !isAllowedSignInEmail(null, undefined));
    record('env empty string: denied', !isAllowedSignInEmail('anyone@evil.com', ''));
    record('env whitespace-only: denied', !isAllowedSignInEmail('anyone@evil.com', '   '));
    record('env commas-only: denied', !isAllowedSignInEmail('anyone@evil.com', ' , ,, '));
}

// ─── 2. The deny REASONS are distinct (different fixes, different surfaces) ─
{
    const unset = evaluateSignIn(OWNER, undefined);
    record('unset env → reason "unconfigured" (a config fault, not a rejected account)',
        !unset.ok && unset.reason === 'unconfigured', JSON.stringify(unset));

    const blank = evaluateSignIn(OWNER, ' , ');
    record('blank-ish env → reason "unconfigured"',
        !blank.ok && blank.reason === 'unconfigured', JSON.stringify(blank));

    const stranger = evaluateSignIn('attacker@gmail.com', OWNER);
    record('configured + non-member → reason "not-allowlisted"',
        !stranger.ok && stranger.reason === 'not-allowlisted', JSON.stringify(stranger));

    const noEmail = evaluateSignIn(undefined, OWNER);
    record('configured + no email → reason "no-email"',
        !noEmail.ok && noEmail.reason === 'no-email', JSON.stringify(noEmail));

    const allowed = evaluateSignIn(`  ${OWNER.toUpperCase()} `, OWNER);
    record('allowed decision carries the NORMALIZED email',
        allowed.ok && allowed.email === OWNER, JSON.stringify(allowed));
}

// ─── 3. isAllowlistConfigured mirrors the deny boundary ──────────────────
{
    record('configured: undefined → false', !isAllowlistConfigured(undefined));
    record('configured: empty → false', !isAllowlistConfigured(''));
    record('configured: whitespace/commas → false', !isAllowlistConfigured(' , '));
    record('configured: one entry → true', isAllowlistConfigured(OWNER));
}

// ─── 4. Set env → strict membership ──────────────────────────────────────
{
    record('exact match: allowed', isAllowedSignInEmail(OWNER, OWNER));
    record('non-member: rejected', !isAllowedSignInEmail('attacker@gmail.com', OWNER));
    record('null email with list set: rejected', !isAllowedSignInEmail(null, OWNER));
    record('undefined email with list set: rejected', !isAllowedSignInEmail(undefined, OWNER));
    record('empty-string email with list set: rejected', !isAllowedSignInEmail('', OWNER));
}

// ─── 5. Case-insensitivity (both sides) ──────────────────────────────────
{
    record('email uppercased: allowed', isAllowedSignInEmail('SalSalcedo4321@GMAIL.com', OWNER));
    record('env uppercased: allowed', isAllowedSignInEmail(OWNER, 'SALSALCEDO4321@Gmail.COM'));
}

// ─── 6. Whitespace tolerance ─────────────────────────────────────────────
{
    record('env entries padded with spaces: allowed',
        isAllowedSignInEmail(OWNER, `  ${OWNER} , other@example.com  `));
    record('email padded with spaces: allowed',
        isAllowedSignInEmail(`  ${OWNER}  `, OWNER));
}

// ─── 7. Multi-email list ─────────────────────────────────────────────────
{
    const list = `first@example.com,${OWNER},third@example.com`;
    record('multi-list: first member allowed', isAllowedSignInEmail('first@example.com', list));
    record('multi-list: middle member allowed', isAllowedSignInEmail(OWNER, list));
    record('multi-list: last member allowed', isAllowedSignInEmail('third@example.com', list));
    record('multi-list: non-member rejected', !isAllowedSignInEmail('fourth@example.com', list));
    record('multi-list: no substring match', !isAllowedSignInEmail('rst@example.com', list));
}

// ─── 8. parseAllowlist normalization ─────────────────────────────────────
{
    const parsed = parseAllowlist(`  A@B.com ,, c@D.com , `);
    record('parse: drops blanks, trims, lowercases',
        parsed.length === 2 && parsed[0] === 'a@b.com' && parsed[1] === 'c@d.com',
        JSON.stringify(parsed));
    record('parse: undefined → []', parseAllowlist(undefined).length === 0);
}

// ─── 9. The message is ACTIONABLE, not just loud ─────────────────────────
// A silent deny reads as a Google outage. These assertions are the "and it
// tells you what to do" half of the fix — they check the message names the
// var, the file and the remedy rather than merely existing.
{
    const msg = allowlistUnconfiguredMessage();
    record('message names the env var', msg.includes(ALLOWLIST_ENV), ALLOWLIST_ENV);
    record('message names the file to edit', msg.includes('.env'));
    record('message names the remedy (pm2 restart --update-env)',
        msg.includes('pm2 restart') && msg.includes('--update-env'));
    record('message says sign-in is REFUSED (not "disabled"/"open")',
        /refused/i.test(msg) && !/fail-open/i.test(msg));
    record('message states the consequence for the owner (Gmail/Calendar token)',
        /gmail/i.test(msg) && /calendar/i.test(msg));
}

// ─── 10. Startup check: reports loudly, returns, never throws ────────────
{
    const originalError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    let configuredResult: boolean | undefined;
    let unconfiguredResult: boolean | undefined;
    // Counted BETWEEN the two calls — the configured path must be silent, and
    // asserting on the total afterwards would let its line hide behind the
    // unconfigured one.
    let loggedAfterConfigured = -1;
    let threw = false;
    try {
        configuredResult = checkSignInAllowlistAtStartup(OWNER);
        loggedAfterConfigured = captured.length;
        unconfiguredResult = checkSignInAllowlistAtStartup('   ');
    } catch {
        threw = true;
    } finally {
        console.error = originalError;
    }

    record('startup check never throws (a missing allowlist must not brick the tier)', !threw);
    record('startup check: configured → true, silent',
        configuredResult === true && loggedAfterConfigured === 0,
        `logged ${loggedAfterConfigured} line(s)`);
    record('startup check: unconfigured → false', unconfiguredResult === false);
    record('startup check: unconfigured logs one console.error naming the env var',
        captured.length === 1 && captured[0].includes(ALLOWLIST_ENV),
        captured[0]?.slice(0, 80));
}

// ─── 11. WIRING — the real NextAuth signIn callback honours all of it ────
// Section 1 proves the helper denies; this proves lib/auth.ts CALLS it, and
// that the unconfigured branch produces the "Configuration" (server error)
// page rather than the generic AccessDenied a bare `false` gives — the
// distinction between "fix your env" and "you're not on the list".
//
// Hermetic: `account: null` means the Google token-persist / gmail-watch branch
// is never entered, so nothing touches the DB or the network.
async function checkSignInCallbackWiring(): Promise<void> {
    const saved = process.env[ALLOWLIST_ENV];
    const originalError = console.error;
    const originalWarn = console.warn;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    console.warn = () => { /* the per-attempt rejection warn is not under test here */ };

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions } = require('@/lib/auth') as typeof import('@/lib/auth');
        const signIn = authOptions.callbacks?.signIn;
        if (typeof signIn !== 'function') {
            record('authOptions.callbacks.signIn exists', false, 'callback missing');
            return;
        }
        const drive = (email: string | null) =>
            Promise.resolve(signIn({
                user: { id: 'signin-smoke', email, emailVerified: null } as never,
                account: null,
                profile: undefined,
            }));

        delete process.env[ALLOWLIST_ENV];
        const unsetResult = await drive(OWNER);
        record('callback with unset env: does NOT admit (fail-closed end to end)',
            unsetResult !== true, String(unsetResult));
        record('callback with unset env: routes to the Configuration error page, not AccessDenied',
            typeof unsetResult === 'string' && unsetResult.includes('error=Configuration'),
            String(unsetResult));
        record('callback with unset env: logs the actionable message',
            errors.some((e) => e.includes(ALLOWLIST_ENV)), `${errors.length} error line(s)`);

        process.env[ALLOWLIST_ENV] = '   ';
        record('callback with blank env: does NOT admit', (await drive(OWNER)) !== true);

        process.env[ALLOWLIST_ENV] = OWNER;
        record('callback with configured env + allowlisted email: admits',
            (await drive(OWNER)) === true);
        record('callback with configured env + stranger: refused with plain false (AccessDenied)',
            (await drive('attacker@example.com')) === false);
        record('callback with configured env + no email: refused',
            (await drive(null)) === false);
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
        if (saved === undefined) delete process.env[ALLOWLIST_ENV];
        else process.env[ALLOWLIST_ENV] = saved;
    }
}

/**
 * Exit path lives OUTSIDE the async body so no early return can skip it (the
 * resume-list-smoke bug: printed [FAIL] and still exited 0, so the pre-push gate
 * passed a red suite).
 */
function finish(): never {
    const passed = steps.filter(s => s.ok).length;
    const failed = steps.length - passed;
    console.info(`\n${passed}/${steps.length} steps passed`);
    if (failed > 0) {
        console.error(`${failed} step(s) failed`);
        process.exit(1);
    }
    console.info('All checks passed.');
    process.exit(0);
}

checkSignInCallbackWiring().then(finish, (e) => {
    console.error('Unhandled error:', e);
    process.exit(2);
});
