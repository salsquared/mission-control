// Hermetic smoke for the `resume-tagline` callsite — pure prompt-render +
// post-filter assertions. No Gemini, no DB. Covers:
//   1. buildResumeTaglineVars produces the expected {{var}} substitutions
//      across the four optional fields (title, company, seniority, keywords).
//   2. buildResumeTaglineUserPrompt assembles a user message that includes
//      the posting block AND the profile evidence block (so the LLM sees
//      both at once — that's the load-bearing invariant of this callsite).
//   3. postFilterTagline (reused from tagline-draft) cleans the model output
//      consistently with the route's persistence path.
//
// Run with: npx tsx scripts/tests/hermetic/resume-tagline-smoke.ts

import {
    buildResumeTaglineVars,
    buildResumeTaglineUserPrompt,
} from '@/lib/resumes/tagline-tailor';
import { postFilterTagline } from '@/lib/profile/tagline-draft';
import type { ParsedPosting } from '@/lib/resumes/posting';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Minimal HydratedProfile-shaped fixture. Only the fields buildProfileSummary
// reads need to be populated; everything else is a placeholder.
function mkProfile(overrides: Partial<{
    headline: string | null;
    workRoles: Array<{ id: string; title: string; company: string; location: string | null; bullets: Array<{ text: string; excluded?: boolean }>; scratchpad?: string | null }>;
    projects: Array<{ id: string; name: string; description: string | null; bullets: Array<{ text: string; excluded?: boolean }>; scratchpad?: string | null }>;
    education: Array<{ id: string; institution: string; degree: string | null; field: string | null; bullets: Array<{ text: string; excluded?: boolean }>; scratchpad?: string | null }>;
    skills: Array<{ category: string; items: string[] }> | null;
    hobbies: string[] | null;
    languages: Array<{ name: string; proficiency: string }> | null;
}> = {}) {
    return {
        headline: overrides.headline ?? 'Salvador Salcedo',
        workRoles: overrides.workRoles ?? [],
        projects: overrides.projects ?? [],
        education: overrides.education ?? [],
        skills: overrides.skills ?? null,
        hobbies: overrides.hobbies ?? null,
        languages: overrides.languages ?? null,
    } as unknown as Parameters<typeof buildResumeTaglineVars>[0]['profile'];
}

const POSTING_SECURITY: ParsedPosting = {
    title: 'Campus Security Officer',
    company: 'Cedars-Sinai',
    location: 'Los Angeles, CA',
    seniority: 'entry-level',
    rawText: 'placeholder',
    sourceUrl: null,
    keywords: ['security', 'patrol', 'incident-reporting', 'customer-service'],
};

// ─── buildResumeTaglineVars: var substitutions ──────────────────────────────
{
    const vars = buildResumeTaglineVars({
        profile: mkProfile({ headline: 'Salvador Salcedo' }),
        posting: POSTING_SECURITY,
    });
    record(
        'vars: posting title threaded through',
        vars.postingTitle === 'Campus Security Officer',
        `got "${vars.postingTitle}"`,
    );
    record(
        'vars: posting company threaded through',
        vars.postingCompany === 'Cedars-Sinai',
        `got "${vars.postingCompany}"`,
    );
    record(
        'vars: posting seniority threaded through',
        vars.postingSeniority === 'entry-level',
        `got "${vars.postingSeniority}"`,
    );
    const kwBlock = typeof vars.postingKeywordsBlock === 'string' ? vars.postingKeywordsBlock : '';
    record(
        'vars: keywords block contains every keyword',
        ['security', 'patrol', 'incident-reporting', 'customer-service']
            .every(k => kwBlock.includes(k)),
        `block: ${JSON.stringify(kwBlock)}`,
    );
    record(
        'vars: keywords block leads each line with "  - "',
        kwBlock.split('\n').every(line => line.startsWith('  - ')),
        `block: ${JSON.stringify(kwBlock)}`,
    );
}

// ─── buildResumeTaglineVars: empty fields degrade to (unknown) ──────────────
{
    const vars = buildResumeTaglineVars({
        profile: mkProfile(),
        posting: {
            title: null,
            company: null,
            location: null,
            seniority: null,
            rawText: '',
            sourceUrl: null,
            keywords: [],
        },
    });
    record(
        'vars: null title → "(unknown)"',
        vars.postingTitle === '(unknown)',
        `got "${vars.postingTitle}"`,
    );
    record(
        'vars: null company → "(unknown)"',
        vars.postingCompany === '(unknown)',
        `got "${vars.postingCompany}"`,
    );
    record(
        'vars: null seniority → "(unknown)"',
        vars.postingSeniority === '(unknown)',
        `got "${vars.postingSeniority}"`,
    );
    const kwBlock = typeof vars.postingKeywordsBlock === 'string' ? vars.postingKeywordsBlock : '';
    record(
        'vars: empty keywords → "  (none extracted)"',
        kwBlock === '  (none extracted)',
        `got "${kwBlock}"`,
    );
}

// ─── buildResumeTaglineUserPrompt: assembled prompt includes both blocks ────
{
    const prompt = buildResumeTaglineUserPrompt({
        profile: mkProfile({
            headline: 'Salvador Salcedo',
            education: [{
                id: 'ed1',
                institution: 'California State University Long Beach',
                degree: 'B.S.',
                field: 'Applied Mathematics',
                bullets: [{ text: 'Coursework in linear algebra' }],
                scratchpad: 'Currently enrolled.',
            }],
        }),
        posting: POSTING_SECURITY,
    });
    record(
        'prompt: includes posting title',
        prompt.includes('Campus Security Officer'),
        prompt.slice(0, 200),
    );
    record(
        'prompt: includes posting company',
        prompt.includes('Cedars-Sinai'),
    );
    record(
        'prompt: includes profile evidence (CSULB degree)',
        prompt.includes('Applied Mathematics') && prompt.includes('California State University Long Beach'),
    );
    record(
        'prompt: includes Output section anchor',
        prompt.includes('## Output'),
    );
}

// ─── postFilterTagline: invariants enforced regardless of model output ──────
{
    record(
        'post-filter: strips wrapping double quotes',
        postFilterTagline('"Applied math student looking for work."') === 'Applied math student looking for work.',
    );
    record(
        'post-filter: strips wrapping single quotes',
        postFilterTagline("'Applied math student looking for work.'") === 'Applied math student looking for work.',
    );
    record(
        'post-filter: adds trailing period when missing',
        postFilterTagline('Applied math student looking for work') === 'Applied math student looking for work.',
    );
    record(
        'post-filter: collapses internal newlines',
        !postFilterTagline('Applied math student\nlooking for work.').includes('\n'),
    );
    {
        const long = 'Applied math student at California State University Long Beach with extensive customer-facing experience from years of high-volume bartending plus engineering internships and a passion for security work and patrol and reporting and incident management and absolutely loves it.';
        const filtered = postFilterTagline(long);
        record(
            'post-filter: hard cap ≤ 200 chars',
            filtered.length <= 200,
            `got length ${filtered.length}`,
        );
        record(
            'post-filter: truncated output still ends in punctuation',
            /[.!?]$/.test(filtered),
            filtered,
        );
    }
}

// ─── Summary ────────────────────────────────────────────────────────────────
const pass = steps.filter(s => s.ok).length;
const fail = steps.filter(s => !s.ok).length;
console.info(`\n${pass}/${steps.length} steps passed`);
if (fail === 0) {
    console.info('All checks passed.');
} else {
    console.error(`${fail} failure(s).`);
    process.exit(1);
}
