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
3. Add a row to `docs/llm-calls.md` and update the inventory table in `docs/implementation.md` §LLM observability.

## Capturing real fixtures (TODO — LOP-9 follow-up)

The seed fixtures in `suites/*.yaml` are synthetic-but-realistic. To capture actual production inputs:

1. Add a gated `console.info('[FIXTURE]', JSON.stringify({ name, system, user }))` at the start of `chatJSON` in `lib/ai/gemini.ts`, gated on `process.env.CAPTURE_FIXTURES === '1'`. (Future LOP-9 work — add the seam.)
2. `CAPTURE_FIXTURES=1 pm2 restart mission-control-dev --update-env`.
3. Use the app for 30 minutes covering the flows you care about.
4. `pm2 logs mission-control-dev | grep '^\[FIXTURE\]'` to grep the captures.
5. Paste into the relevant `suites/<callsite>.yaml`, adapt the input shape to match the function signature (the provider dispatcher in `provider.ts` shows what shape each callsite expects).

## Why not in pre-push?

Real Gemini tokens + ~30 s wall time + flake potential from upstream model variance. Pre-push stays hermetic (zero external calls); this harness runs manually before / after prompt edits and on demand.

If you want CI gating later: wrap individual fixture results with `score: { value: ... }` annotations and threshold against a baseline JSON. Today the harness is binary pass/fail per assertion.
