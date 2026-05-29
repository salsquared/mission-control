# employment-type-classifier

**Callsite:** `lib/ai/classify-employment-type.ts:classifyEmploymentTypes` (batched, one Gemini call per ≤ 50 postings)
**Model:** `MODEL_LITE_CHEAP` (`gemini-2.5-flash-lite`) — pure enum picker, cheapest model is invisible-quality.
**Temperature:** 0.1
**Max output tokens:** 1024
**Bypasses chatJSON?** no

## System

```
Classify each posting by employment type. Choose one of:
- "full-time": permanent salaried role (Engineer, Manager, Director, Staff/Senior X). Also paid post-grad fellowships at labs/companies (Anthropic Fellows, OpenAI Residency, "Research Fellow", "AI Safety Fellow") — these are typically 6-12mo W-2 roles for experienced hires.
- "internship": interns, co-ops, apprentices, student seasonal programs (Summer 2026 SWE). A summer-term fellowship tied to a student cohort goes here.
- "contract": 1099, freelance, fixed-term consulting. NOT "Contract Manager"/"Contract Specialist"/"Contract Negotiator" — those administer contracts and are full-time.
- "part-time": explicitly part-time hourly.
- "temporary": seasonal or short-term temp.
- null: genuinely ambiguous AND no signal.

Default to "full-time" for typical engineering/operations titles. Output: {"types":["full-time","internship",null,...]} — one entry per input line, same order, no other fields.
```

## User template

```
Classify each line below (one row per line). Return {{itemCount}} types in input order.

{{inputLines}}
```

## Variables

- `itemCount` — number of postings in this batch (≤ 50). Echoed in the prompt so the model knows the expected output array length.
- `inputLines` — newline-separated, pipe-delimited rows. One row per input posting:
  ```
  0|Acme Corp|Senior Backend Engineer|NYC
  1|Beta Labs|Summer 2026 SWE Intern|
  2|Gamma Inc|Contract Negotiator|Remote
  ```
  Format: `<index>|<company>|<title>|<location>`. Snippet/department intentionally dropped — title is the load-bearing signal; including snippet did not change classification on any live-probe fixture (including the "Anthropic AI Safety Fellow" edge case) and only added ~9% prompt tokens.

## Notes

- **Positional output** — the model returns `{"types": [...]}` aligned by array index to the input rows; no external id echoing. UUIDs from Workday/Lever would have burned ~70% of the output budget for zero signal (see 2026-05-20 change log entry in `docs/llm-calls.html`).
- Batch size 50 is the empirical sweet spot. The parse is **tolerant** (`ResultSchema`, 2026-05-29): the cheap model intermittently returns a bare array instead of `{"types":[...]}` (rewrapped) or an out-of-enum string (coerced to `null`), so one bad item no longer fails the whole 50-item batch.
- **Per-batch isolation** (2026-05-29): a batch that still fails to parse defaults *its* items to `null` and the sweep continues — it does NOT abort the run. Before this, one malformed response among ~20 batches threw the whole sweep and discarded every already-classified batch (observed failing ~100% live on `MODEL_LITE_CHEAP`).
- Caller handles missing items (model returns fewer entries than expected) — those default to `null` in the returned Map.
- Sequential dispatch — not `Promise.all`. Rate limiter (12 req/min default) would serialize anyway, and a 429 in one parallel branch can poison the others; sequential keeps timing logs interpretable.
- Tightened output cap (4096 → 1024 on 2026-05-20) since the output is a short string array — surfaces unexpected growth as MAX_TOKENS instead of silently burning budget.
- Caller in `scheduler/jobs/job-watcher.ts` catches throws and falls back to leaving postings as `Unspecified` — strictly degrades, never worse than today's behavior.
- Hermetic smoke at `scripts/tests/hermetic/classify-employment-type-smoke.ts` (8 cases) mocks via `ChatJSONFn` dep injection.
