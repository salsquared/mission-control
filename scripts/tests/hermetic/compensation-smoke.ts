// Story 24 — compensation parser hermetic smoke. Pure function, no DB.
// Run with: npx tsx scripts/tests/hermetic/compensation-smoke.ts

import { parseCompensation } from '@/lib/postings/compensation';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function check(name: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    record(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ─── Annual ranges ───────────────────────────────────────────────────────
check(
    'standard k-range: $120k - $150k',
    parseCompensation('Salary: $120k - $150k per year'),
    { min: 120000, max: 150000, currency: 'USD', cadence: 'year' },
);
check(
    'full-digits range: $120,000 to $150,000',
    parseCompensation('Annual base $120,000 to $150,000'),
    { min: 120000, max: 150000, currency: 'USD', cadence: 'year' },
);
check(
    'em-dash range: $200,000–$250,000',
    parseCompensation('$200,000–$250,000 annually'),
    { min: 200000, max: 250000, currency: 'USD', cadence: 'year' },
);
check(
    'no-cadence range stays valid with cadence null',
    parseCompensation('Compensation: $150,000 - $180,000'),
    { min: 150000, max: 180000, currency: 'USD', cadence: null },
);

// ─── Magnitude mismatch fix-up ───────────────────────────────────────────
check(
    'magnitude mismatch: $120k-150 → both treated as k',
    parseCompensation('$120k-150 per year'),
    { min: 120000, max: 150000, currency: 'USD', cadence: 'year' },
);

// ─── Hourly ──────────────────────────────────────────────────────────────
check(
    'hourly: $60/hr',
    parseCompensation('$60/hr'),
    { min: 60, max: 60, currency: 'USD', cadence: 'hour' },
);
check(
    'hourly range: $40-60 per hour',
    parseCompensation('$40-$60 per hour'),
    { min: 40, max: 60, currency: 'USD', cadence: 'hour' },
);

// ─── "Up to" ─────────────────────────────────────────────────────────────
check(
    'up to: Up to $200,000',
    parseCompensation('Up to $200,000 annually'),
    { min: 200000, max: 200000, currency: 'USD', cadence: 'year' },
);

// ─── Single anchored value ───────────────────────────────────────────────
check(
    // "base salary" alone is ambiguous — the parser yields a value but leaves
    // cadence null. The UI defaults a null-cadence + plausible-annual value
    // to "year" on display, which keeps us out of the business of guessing.
    'single anchored value with no cadence: $175,000 base salary',
    parseCompensation('$175,000 base salary'),
    { min: 175000, max: 175000, currency: 'USD', cadence: null },
);
check(
    'single with explicit yearly: $175,000 / year',
    parseCompensation('$175,000 / year'),
    { min: 175000, max: 175000, currency: 'USD', cadence: 'year' },
);
check(
    '"Annual base" is recognized as yearly',
    parseCompensation('Annual base $120,000 to $150,000'),
    { min: 120000, max: 150000, currency: 'USD', cadence: 'year' },
);

// ─── Plausibility filters ────────────────────────────────────────────────
record(
    'rejects "5,000 employees"',
    parseCompensation('We have 5,000 employees') === null,
);
record(
    'rejects "$1 / hour"',
    parseCompensation('$1 / hour') === null,
);
record(
    'rejects bare $50 with no cadence (under annual floor)',
    parseCompensation('$50') === null,
);

// ─── No-comp inputs ──────────────────────────────────────────────────────
record('null input → null', parseCompensation(null) === null);
record('empty string → null', parseCompensation('') === null);
record('comp-less snippet → null', parseCompensation('Join our team! We value collaboration.') === null);

// ─── Realistic posting snippets ──────────────────────────────────────────
check(
    'realistic Greenhouse-style snippet',
    parseCompensation(`Senior Software Engineer, Backend\n\nLocation: Remote\n\nThe base salary range for this role is $180,000 - $230,000 annually, depending on level and location.`),
    { min: 180000, max: 230000, currency: 'USD', cadence: 'year' },
);

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
