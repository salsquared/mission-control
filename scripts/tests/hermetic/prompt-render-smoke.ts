// Structural invariant smoke for the 9 LLM-callsite prompt templates. NO
// network, NO model calls — exercises `loadPromptFromDisk(slug, vars)` for
// every slug in `docs/llm-prompts/`, asserting the renders are well-formed.
//
// Catches the drift cases that bite when a template edit ships without the
// matching code change:
//   - template grew a new {{var}} that the code doesn't supply
//   - code passes a var that the template no longer references
//   - a literal `{{foo}}` survived substitution (placeholder typo)
//   - rendered user prompt blew past a slug-specific byte cap
//   - metadata stripped (model/temperature went undefined unexpectedly)
//
// Cheap (sub-100ms), so it's wired into the pre-push gate — every push
// catches a template/code mismatch before it ever reaches a real LLM call.
//
// Run: npx tsx scripts/tests/hermetic/prompt-render-smoke.ts

import fs from 'node:fs';
import path from 'node:path';
import { loadPromptFromDisk, type LoadedPrompt, type PromptVars } from '@/lib/ai/prompts';
import { PROMPT_SLUGS, SAMPLE_VARS, type PromptSlug } from '@/scripts/prompt-samples';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string): void {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

// Per-slug expectations the renderer should satisfy. `expectSystem: false`
// means the template is single-prompt (no system message — discovery-suggest
// and email-parser). `userByteBudget` is the hard ceiling for the rendered
// user prompt with the sample vars; pick a value that comfortably covers
// the realistic range without leaving room for runaway growth.
interface Expectation {
    expectSystem: boolean;
    expectModel: boolean;
    expectTemperature: boolean;
    expectMaxTokens: boolean;
    userByteBudget: number;
    requiredSystemPhrases?: string[];
    requiredUserPhrases?: string[];
}

const EXPECTATIONS: Record<PromptSlug, Expectation> = {
    'bullet-assist-fill': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 8_192,
        requiredSystemPhrases: ['Do not invent specific quantitative claims', 'tense and voice'],
        requiredUserPhrases: ['Output schema', '## Entry'],
    },
    'bullet-assist-rewrite': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 8_192,
        requiredSystemPhrases: ['Do not invent specific quantitative claims', 'tense and voice'],
        requiredUserPhrases: ['Current bullet to rewrite', 'Output schema'],
    },
    'bullet-tags-from-posting': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 16_384,
        requiredSystemPhrases: ['Never invent coverage', 'removedTags'],
        requiredUserPhrases: ['Posting keywords', 'Bullets to consider'],
    },
    'bullet-tags-from-profile': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 8_192,
        // System enforces the four core invariants: pin preservation,
        // blocklist filter, 3–7 cap, vocabulary reuse.
        requiredSystemPhrases: ['MUST appear verbatim', 'No fabrication', '3 to 7 tags'],
        requiredUserPhrases: ['Current tags', 'Blocked tags', 'Profile vocabulary', 'Output schema'],
    },
    'scratchpad-synth': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        // Tier 2b: the batched caller computes maxOutputTokens dynamically from
        // the entity count (min(8192, 512 + entries × 1536)), so the blob
        // deliberately declares NO static value — a number here would override
        // the dynamic budget (caller uses `prompt.maxOutputTokens ?? computed`).
        expectMaxTokens: false,
        userByteBudget: 8_192,
        // System enforces no-fabrication + voice preservation + verbatim
        // keyword use + 3-7 tags per synthesized bullet.
        requiredSystemPhrases: ['NO FABRICATION', 'VOICE PRESERVATION', 'POSTING KEYWORD VERBATIM'],
        requiredUserPhrases: ['scratchpad notes', 'posting keywords', 'Uncovered', 'Output schema'],
    },
    'tagline-draft': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 8_192,
        // System enforces the four core invariants: no fabrication, one
        // sentence ≤ 200 chars, no first-person, mode-specific behavior.
        requiredSystemPhrases: ['NO FABRICATION', 'ONE SENTENCE', 'NO FIRST-PERSON', 'MODE-SPECIFIC'],
        requiredUserPhrases: ['Current tagline', 'Profile (the ONLY evidence', 'Output schema'],
    },
    'resume-tagline': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 8_192,
        // System enforces the same no-fab / one-sentence / no-first-person
        // invariants as tagline-draft, plus the load-bearing posting-aware
        // framing rule that makes this callsite distinct from tagline-draft.
        requiredSystemPhrases: ['NO FABRICATION', 'ONE SENTENCE', 'NO FIRST-PERSON', 'POSTING-AWARE FRAMING'],
        requiredUserPhrases: ['## Posting', '## Profile evidence', '## Output'],
    },
    'discovery-suggest': {
        expectSystem: false,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 4_096,
        requiredUserPhrases: ['EXCLUDED', 'careersUrl'],
    },
    'email-parser': {
        expectSystem: false,
        expectModel: true,
        expectTemperature: false,
        expectMaxTokens: false,
        userByteBudget: 8_192,
        requiredUserPhrases: ['isApplicationRelated', 'Email send-date'],
    },
    'employment-type-classifier': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 16_384,
        requiredSystemPhrases: ['full-time', 'internship', 'Default to "full-time"'],
        requiredUserPhrases: ['Classify each line'],
    },
    'posting-parse': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 16_384,
        requiredSystemPhrases: ['structured signals', 'conservative'],
        requiredUserPhrases: ['Job posting text', 'keywords'],
    },
    'profile-import': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 80_000,
        requiredSystemPhrases: ['NEVER invent', 'PROJECT', 'WORK ROLE'],
        requiredUserPhrases: ['Resume text', 'workRoles'],
    },
    'profile-synthesize': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 100_000,
        requiredSystemPhrases: ['canonical master resume', 'CROSS-DRAFT DEDUP'],
        requiredUserPhrases: ['EXISTING profile', 'DRAFTS'],
    },
    'resume-rewrite': {
        expectSystem: true,
        expectModel: true,
        expectTemperature: true,
        expectMaxTokens: true,
        userByteBudget: 8_192,
        requiredSystemPhrases: ['NEVER invent metrics', "Preserve the bullet `id`"],
        requiredUserPhrases: ['Posting title', 'Bullets to rewrite'],
    },
};

function declaredVarsInDisk(slug: string): Set<string> {
    const file = path.join(process.cwd(), 'docs', 'llm-prompts', `${slug}.md`);
    const text = fs.readFileSync(file, 'utf8');
    const declared = new Set<string>();
    for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) declared.add(m[1]);
    return declared;
}

function assertSlug(slug: PromptSlug, expect: Expectation, sample: PromptVars): void {
    let rendered: LoadedPrompt;
    try {
        rendered = loadPromptFromDisk(slug, sample);
    } catch (err) {
        record(`${slug}: render`, false, err instanceof Error ? err.message : String(err));
        return;
    }

    // 1. Var-set coverage — every declared {{var}} in the .md has a sample.
    const declared = declaredVarsInDisk(slug);
    const supplied = new Set(Object.keys(sample));
    const missing = [...declared].filter(v => !supplied.has(v));
    record(`${slug}: every declared {{var}} has a sample`, missing.length === 0, missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined);

    // 2. No leftover {{…}} markers in rendered output (catches typos in the
    // template that don't match the \{\{\s*\w+\s*\}\} substitution regex).
    const userLeftovers = [...rendered.user.matchAll(/\{\{[^}]*\}\}/g)].map(m => m[0]);
    const systemLeftovers = rendered.system ? [...rendered.system.matchAll(/\{\{[^}]*\}\}/g)].map(m => m[0]) : [];
    const allLeftovers = [...userLeftovers, ...systemLeftovers];
    record(`${slug}: no unsubstituted {{…}} markers`, allLeftovers.length === 0, allLeftovers.length > 0 ? `found: ${[...new Set(allLeftovers)].join(', ')}` : undefined);

    // 3. System presence matches expectation.
    const hasSystem = typeof rendered.system === 'string' && rendered.system.length > 0;
    record(`${slug}: system field ${expect.expectSystem ? 'present' : 'absent'}`, hasSystem === expect.expectSystem);

    // 4. Metadata fields present per expectation.
    record(`${slug}: model ${expect.expectModel ? 'present' : 'absent'}`, Boolean(rendered.model) === expect.expectModel, rendered.model ?? '(none)');
    record(`${slug}: temperature ${expect.expectTemperature ? 'present' : 'absent'}`, (rendered.temperature !== undefined) === expect.expectTemperature, String(rendered.temperature));
    record(`${slug}: maxOutputTokens ${expect.expectMaxTokens ? 'present' : 'absent'}`, (rendered.maxOutputTokens !== undefined) === expect.expectMaxTokens, String(rendered.maxOutputTokens));

    // 5. Byte budget for the user prompt.
    const userBytes = utf8Bytes(rendered.user);
    record(`${slug}: user ≤ ${expect.userByteBudget} bytes`, userBytes <= expect.userByteBudget, `user=${userBytes}`);

    // 6. Required system phrases (guardrails that should never silently disappear).
    if (expect.requiredSystemPhrases && hasSystem) {
        for (const phrase of expect.requiredSystemPhrases) {
            record(`${slug}: system contains "${phrase}"`, rendered.system!.includes(phrase));
        }
    }

    // 7. Required user phrases (structural markers that anchor the prompt shape).
    if (expect.requiredUserPhrases) {
        for (const phrase of expect.requiredUserPhrases) {
            record(`${slug}: user contains "${phrase}"`, rendered.user.includes(phrase));
        }
    }
}

function main(): void {
    // Cross-check: PROMPT_SLUGS, SAMPLE_VARS, EXPECTATIONS, and the on-disk
    // .md files all agree on which 9 slugs exist. Drift here means someone
    // added/removed a callsite and missed one of these dimensions.
    const onDisk = fs.readdirSync(path.join(process.cwd(), 'docs', 'llm-prompts'))
        .filter(f => f.endsWith('.md') && f !== 'README.md')
        .map(f => f.replace(/\.md$/, ''))
        .sort();
    const declared = [...PROMPT_SLUGS].sort();
    record(
        'inventory: PROMPT_SLUGS matches on-disk docs/llm-prompts/*.md',
        declared.length === onDisk.length && declared.every((s, i) => s === onDisk[i]),
        `declared=[${declared.join(',')}] disk=[${onDisk.join(',')}]`,
    );
    const sampleKeys = Object.keys(SAMPLE_VARS).sort();
    record('inventory: SAMPLE_VARS covers every slug', declared.every(s => sampleKeys.includes(s)));
    const expKeys = Object.keys(EXPECTATIONS).sort();
    record('inventory: EXPECTATIONS covers every slug', declared.every(s => expKeys.includes(s)));

    for (const slug of PROMPT_SLUGS) {
        assertSlug(slug, EXPECTATIONS[slug], SAMPLE_VARS[slug]);
    }

    const passed = steps.filter(s => s.ok).length;
    const failed = steps.length - passed;
    console.info(`\n${passed}/${steps.length} steps passed`);
    if (failed > 0) {
        console.error(`${failed} step(s) failed.`);
        process.exit(1);
    }
    console.info('All checks passed.');
}

main();
