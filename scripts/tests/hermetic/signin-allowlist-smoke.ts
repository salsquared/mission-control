// P1.1 (OQ1a) hermetic smoke for the sign-in allowlist helpers — pure
// functions over an explicit env-value parameter, so no process.env
// mutation, no network, no NextAuth.
// Run with: npx tsx scripts/tests/hermetic/signin-allowlist-smoke.ts

import { isAllowedSignInEmail, isAllowlistConfigured, parseAllowlist } from '@/lib/auth-allowlist';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const OWNER = 'salsalcedo4321@gmail.com';

// ─── Unset / empty env → fail-open (TRUE for anyone) ─────────────────────
{
    record('env undefined: any email allowed', isAllowedSignInEmail('anyone@evil.com', undefined));
    record('env undefined: null email allowed (fail-open)', isAllowedSignInEmail(null, undefined));
    record('env empty string: allowed', isAllowedSignInEmail('anyone@evil.com', ''));
    record('env whitespace-only: allowed', isAllowedSignInEmail('anyone@evil.com', '   '));
    record('env commas-only: allowed', isAllowedSignInEmail('anyone@evil.com', ' , ,, '));
}

// ─── isAllowlistConfigured mirrors the fail-open boundary ────────────────
{
    record('configured: undefined → false', !isAllowlistConfigured(undefined));
    record('configured: empty → false', !isAllowlistConfigured(''));
    record('configured: whitespace/commas → false', !isAllowlistConfigured(' , '));
    record('configured: one entry → true', isAllowlistConfigured(OWNER));
}

// ─── Set env → strict membership ─────────────────────────────────────────
{
    record('exact match: allowed', isAllowedSignInEmail(OWNER, OWNER));
    record('non-member: rejected', !isAllowedSignInEmail('attacker@gmail.com', OWNER));
    record('null email with list set: rejected', !isAllowedSignInEmail(null, OWNER));
    record('undefined email with list set: rejected', !isAllowedSignInEmail(undefined, OWNER));
    record('empty-string email with list set: rejected', !isAllowedSignInEmail('', OWNER));
}

// ─── Case-insensitivity (both sides) ─────────────────────────────────────
{
    record('email uppercased: allowed', isAllowedSignInEmail('SalSalcedo4321@GMAIL.com', OWNER));
    record('env uppercased: allowed', isAllowedSignInEmail(OWNER, 'SALSALCEDO4321@Gmail.COM'));
}

// ─── Whitespace tolerance ────────────────────────────────────────────────
{
    record('env entries padded with spaces: allowed',
        isAllowedSignInEmail(OWNER, `  ${OWNER} , other@example.com  `));
    record('email padded with spaces: allowed',
        isAllowedSignInEmail(`  ${OWNER}  `, OWNER));
}

// ─── Multi-email list ────────────────────────────────────────────────────
{
    const list = `first@example.com,${OWNER},third@example.com`;
    record('multi-list: first member allowed', isAllowedSignInEmail('first@example.com', list));
    record('multi-list: middle member allowed', isAllowedSignInEmail(OWNER, list));
    record('multi-list: last member allowed', isAllowedSignInEmail('third@example.com', list));
    record('multi-list: non-member rejected', !isAllowedSignInEmail('fourth@example.com', list));
    record('multi-list: no substring match', !isAllowedSignInEmail('rst@example.com', list));
}

// ─── parseAllowlist normalization ────────────────────────────────────────
{
    const parsed = parseAllowlist(`  A@B.com ,, c@D.com , `);
    record('parse: drops blanks, trims, lowercases',
        parsed.length === 2 && parsed[0] === 'a@b.com' && parsed[1] === 'c@d.com',
        JSON.stringify(parsed));
    record('parse: undefined → []', parseAllowlist(undefined).length === 0);
}

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
