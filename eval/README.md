# eval/ — Promptfoo regression suite for LLM callsites

Manually-triggered prompt regression harness against the 9 LLM callsites listed in [`docs/implementation.md`](../docs/implementation.md) §LLM observability. Burns real Gemini tokens — **not** wired into `pre-push.sh`.

## Layout

```
eval/
  provider.ts                # custom Promptfoo provider — dispatches per fixture to
                             # the real chatJSON-wrapped lib functions
  promptfooconfig.yaml       # top-level config; references all suites via glob
  suites/                    # one YAML per callsite slug
    bullet-assist-fill.yaml
    bullet-assist-rewrite.yaml
    discovery-suggest.yaml
    email-parser.yaml
    employment-type-classifier.yaml
    posting-parse.yaml
    profile-import.yaml
    profile-synthesize.yaml
    resume-rewrite.yaml
  fixtures/                  # (optional) per-callsite directories for big fixture
                             # inputs that don't fit cleanly inline in YAML.
                             # Reference from a suite via `file://./fixtures/...`.
```

## Running

```sh
npm run test:prompts
```

Prereqs: `GOOGLE_GENERATIVE_AI_KEY` (or one of the fallbacks in `lib/ai/gemini.ts:getClient`) in `.env`. Lunary tracing fires automatically if `LUNARY_PUBLIC_KEY` is also set — every eval call shows up in the dashboard tagged by its `name` field.

Output lands in `eval/output/results.json` (gitignored).

## Cost

Roughly 9 callsites × 2-3 fixtures × (1 main call + 1 llm-rubric judge) ≈ 40–60 Gemini calls per full run. At `MODEL_LITE` token sizes that's ~$0.01–0.05. `llm-rubric` judges use `MODEL_LITE_CHEAP` (configured in `promptfooconfig.yaml:defaultTest.options.provider`) to keep cost down.

Some callsites burn extra:
- `discovery-suggest` — provider also probes Greenhouse/Lever/Ashby (~5–20 outbound HTTP per fixture). Slower wall time, free of Gemini cost.
- `profile-synthesize` + `profile-import` — MODEL_FLASH on synthesize is ~5× more expensive than MODEL_LITE.

## Adding fixtures

1. Pick the suite YAML matching your callsite slug.
2. Append a new entry to the array. Required fields: `description`, `vars.callsite`, `vars.input`, `assert[]`.
3. Optionally capture real input via `CAPTURE_FIXTURES=1` (see "Capturing real fixtures" below).
4. Run `npm run test:prompts -- --filter-description "<your description>"` to isolate just your new case during iteration.

## Adding a new callsite

1. Add the slug to `HANDLERS` in `eval/provider.ts` — a single async function that takes the fixture's `input` and calls the real lib function.
2. Drop a new `eval/suites/<slug>.yaml` with at least one test case. The glob in `promptfooconfig.yaml` picks it up automatically.
3. Add a row to `docs/llm-calls.html` and update the inventory table in `docs/implementation.md` §LLM observability.

## Capturing real fixtures (TODO — LOP-9 follow-up)

The seed fixtures in `suites/*.yaml` are synthetic-but-realistic. To capture actual production inputs:

1. Add a gated `console.info('[FIXTURE]', JSON.stringify({ name, system, user }))` at the start of `chatJSON` in `lib/ai/gemini.ts`, gated on `process.env.CAPTURE_FIXTURES === '1'`. (Future LOP-9 work — add the seam.)
2. `CAPTURE_FIXTURES=1 pm2 restart mission-control-dev --update-env`.
3. Use the app for 30 minutes covering the flows you care about.
4. `pm2 logs mission-control-dev | grep '^\[FIXTURE\]'` to grep the captures.
5. Paste into the relevant `suites/<callsite>.yaml`, adapt the input shape to match the function signature (the provider dispatcher in `provider.ts` shows what shape each callsite expects).

## Downgrade probe — can a callsite move down a tier?

`scripts/tests/probes/eval-downgrade-probe.ts` runs the suite twice (baseline + downgrade) and diffs pass-rates per callsite. Use it when considering moving a `MODEL_LITE` callsite down to `MODEL_LITE_CHEAP` (or `MODEL_FLASH` down to `MODEL_LITE`).

```sh
npx tsx scripts/tests/probes/eval-downgrade-probe.ts
# or override the candidate list:
PROBE_CALLSITES=posting-parse,bullet-tags-from-profile \
  npx tsx scripts/tests/probes/eval-downgrade-probe.ts
```

Mechanism: `chatJSON` honors `MC_EVAL_DOWNGRADE_CALLSITES` (comma-separated callsite names) + `MC_EVAL_DOWNGRADE_MODEL` (gemini model id). The override only fires for the named callsites, so other callsites in the suite still run on their hardcoded models — keeps the cost of the probe scoped and the signal clean.

Default candidates: `bullet-tags-from-posting`, `bullet-tags-from-profile`, `discovery-suggest` (the picker/enum-shaped MODEL_LITE callsites flagged in the 2026-05-26 conversation as plausible downgrade targets). Pass-rates only reflect what the suite covers — eyeball Lunary samples before flipping a callsite for real.

### 2026-05-26 probe run — findings

Ran the probe twice (initial pass on the seed fixtures, then a second pass after expanding `bullet-tags-from-posting` 4→9 and `discovery-suggest` 1→3):

| callsite | initial | expanded | call |
|---|---|---|---|
| `bullet-tags-from-posting` | 4/4 → 4/4 | **9/9 → 8/9** | **keep MODEL_LITE** — cheap model tagged a "React SPA with Next.js" bullet as `React Native` (close-but-not-match false positive). MODEL_LITE correctly returned `{"proposals":[]}`. |
| `bullet-tags-from-profile` | 6/6 → 5/6 | (no fixture changes) | keep MODEL_LITE — bartending cross-domain rubric is noisy between runs but the regression is real enough not to flip. |
| `discovery-suggest` | 1/1 → 1/1 | 3/3 → 3/3 | **don't flip yet — coverage too thin.** The current 3 assertions are all hard-rule checks (response shape + excludes-respected + internal-uniqueness) and would survive the soft quality drop most likely on a cheaper model. |

**Coverage gap for `discovery-suggest`** (before considering a flip):

- Add 2–4 more fixtures across **ambiguous topics** (e.g. "shell" — oil major vs unix shell), **broad topics** (e.g. "fintech"), **niche topics** (e.g. "fusion energy"), and an **empty-excludes diversity test**.
- Add an `llm-rubric` assertion per fixture grading **suggestion plausibility** — "Are at least 3 of these recognizable real companies that fit the topic?" That's the soft-quality signal the hard-rule checks miss.
- Eyeball Lunary samples from both models on a few real user queries before flipping.

Decision after this exploration: **no model changes**. The probe + override hook are now durable infra — re-run when a Gemini generation bump (or new fixture coverage) shifts the calculus.

## Why not in pre-push?

Real Gemini tokens + ~30 s wall time + flake potential from upstream model variance. Pre-push stays hermetic (zero external calls); this harness runs manually before / after prompt edits and on demand.

If you want CI gating later: wrap individual fixture results with `score: { value: ... }` annotations and threshold against a baseline JSON. Today the harness is binary pass/fail per assertion.
