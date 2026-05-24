# LLM calls — Gemini model fleet + token budgets

Operational doc for every Gemini callsite in mission-control. The goal is to **sip the free-tier quota, not chug it** — most of our LLM work is mechanical extraction that doesn't need the highest-end Flash model.

Update this doc whenever:
- A new Gemini callsite ships (add a row to the inventory).
- A model is swapped or a token cap changed (update the row + add a note in "Change log").
- We observe quality regression on a downgraded callsite (revert the model + record what we saw).

---

## Model fleet

All three constants live in `lib/ai/gemini.ts` and are passed through `chatJSON({ model: ... })`. The email-parser callsite uses the Vercel AI SDK directly and pins the model string inline (kept in sync by comment).

| Constant | Model id | When to use |
|---|---|---|
| `MODEL_FLASH` | `gemini-3.5-flash` | **Quality-sensitive only.** Output directly shapes user-facing artifacts. Reach for this when a mistake means a worse resume or wrong applied-status. |
| `MODEL_LITE` *(default)* | `gemini-3.1-flash-lite` | Mechanical extraction at moderate volume — keyword pulls, structured-field extraction, classification with >2 output classes. Default for new callsites unless you have a specific reason. |
| `MODEL_LITE_CHEAP` | `gemini-2.5-flash-lite` | Pure picker / enum tasks where the output space is tiny (a handful of strings or labels). Quality drop is invisible because the answer space is constrained. |

`DEFAULT_MODEL` is set to `MODEL_LITE`. Forgetting to specify a model puts you in the cheap path by default — the fail-safe direction.

---

## Callsite inventory

| File | Lunary slug (`name:` field) | Model | maxOutputTokens | Input cap | Migrated to registry? | Notes |
|---|---|---|---|---|---|---|
| `lib/email-parser.ts` (parseApplicationEmail) | `email-parser` | `MODEL_LITE` | n/a (Vercel SDK) | **3 KB** body | ⏳ | Highest-volume caller. One call per inbound Gmail message + every backfill. Pinned inline because Vercel AI SDK wraps the model name into a provider call. **Bypasses `chatJSON`** — manually traced via `lunary.trackEvent` in `safeTrack` helper (LOP-5). |
| `lib/ai/classify-employment-type.ts` (classifyEmploymentTypes) | `employment-type-classifier` | `MODEL_LITE_CHEAP` | **1024** | 50 items/batch | ⏳ | Pure 5-class enum picker per posting. Cheapest model is invisible-quality. Positional output (`{"types":[…]}` array, no id echoing) — see 2026-05-20 change log entry. |
| `lib/discovery/suggest.ts` (suggestCompanies) | `discovery-suggest` | `MODEL_LITE` *(default)* | 4096 | small | ⏳ | User-triggered "Discover companies". Temp 0.9 for exploration. |
| `lib/resumes/posting.ts` (parsePosting) | `posting-parse` | `MODEL_LITE` *(default)* | 2048 | **8 KB** posting | ⏳ | Keyword extraction from job posting HTML/text. |
| `lib/resumes/rewrite.ts` (rewriteBullets) | `resume-rewrite` | **`MODEL_FLASH`** | 4096 | small | ⏳ | Output directly becomes resume bullets the user sends to employers. |
| `lib/profile/bullet-assist.ts` fill mode | `bullet-assist-fill` | `MODEL_LITE` (`gemini-3.1-flash-lite`) | 4096 | ~8 KB user prompt (capped inside builder) | ⏳ | M7.6 — bullet drafting on empty Profile entries. Same builder + system prompt as the rewrite mode; output schema differs. |
| `lib/profile/bullet-assist.ts` rewrite mode | `bullet-assist-rewrite` | `MODEL_LITE` (`gemini-3.1-flash-lite`) | 2048 | ~8 KB user prompt (capped inside builder) | ⏳ | M7.6 — per-bullet rewrite via wand icon. Same prompt builder + archive grounding as fill mode; smaller token cap (single bullet output). |
| `lib/profile/import-llm.ts` (extractProfileFromText) | `profile-import` | `MODEL_LITE` *(default)* | **32768** | 60 KB resume | ⏳ | Per-file mechanical extraction — verbatim preservation, no judgment. Large output budget because nested bullets across many roles + projects + education legitimately need it. |
| `lib/profile/synthesize.ts` (synthesizeMasterResume) | `profile-synthesize` | **`MODEL_FLASH`** | **32768** | 80 KB serialized inputs | ⏳ | **One call per import.** Consolidates all per-file extractions + existing profile into the canonical "master resume" stored on the Profile dash. Resolves role-vs-project misclassifications across files, dedupes entities, orders reverse-chrono. The output IS what every downstream tailored-resume rewrite pulls from — quality matters. |

**Lunary slug** = the value passed to `chatJSON({ name: ... })` (or to `lunary.trackEvent` for email-parser). Required since LOP-2 — TypeScript enforces it on `ChatJSONOptions`. Same kebab-case slug names the corresponding file in [`./llm-prompts/`](./llm-prompts/) (the registry source-of-truth snapshot) and the corresponding suite in [`../eval/suites/`](../eval/suites/) (Promptfoo fixtures).

**Migrated to registry?** column tracks per-callsite LOP-6 rollout. ⏳ = prompt still lives inline in code; ✅ = code calls `lunary.renderTemplate(slug, vars)` instead. Flip when you cut over a callsite. Recommended order: bullet-assist + resume-rewrite first (highest iteration churn), then the rest.

---

## Observability (LOP-1 → LOP-9, landed 2026-05-24)

Three pieces wire LLM ops across every callsite. Design doc: [`./implementation.md`](./implementation.md) §LLM observability + prompt registry.

### Tracing — Lunary (managed cloud)

`lib/ai/gemini.ts` wraps the inner `generateContent` call with `lunary.wrapModel` at module-init time, **gated on `LUNARY_PUBLIC_KEY`** — when the env var is unset (dev / CI / fresh clones) `tracedGenerate === rawGenerate` and Lunary code never executes. When the key is set, every call lands in Lunary's dashboard with `name`, model, input messages, output, prompt+completion tokens, latency. Retries trace as separate runs but share a parent name.

`lib/email-parser.ts` bypasses `chatJSON` (Vercel AI SDK), so it tracks manually via `lunary.trackEvent('llm', 'start'/'end'/'error', …)` inside a defensive `safeTrack` helper — a Lunary failure logs a warn but never disrupts Gmail ingest.

Init lives in `instrumentation.ts:7-13` next to `initLogger()`. To activate: sign up at lunary.ai → drop `LUNARY_PUBLIC_KEY=<key>` into `.env` → `pm2 restart mission-control-{dev,scheduler-dev,scheduler-prod} --update-env`.

### Prompt registry — Lunary templates (per-callsite, incremental)

`docs/llm-prompts/<slug>.md` holds the verbatim system + user template text with `{{var}}` markers for every callsite — the source-of-truth-during-migration artifact. Cutover per callsite swaps the inline `SYSTEM_PROMPT` constants for `lunary.renderTemplate(slug, vars)` calls; dynamic section assembly (sibling lists, archive spans, posting text) stays computed in code and passes as variables. Recommended order: `bullet-assist-fill` + `bullet-assist-rewrite` + `resume-rewrite` first (highest iteration churn), then the rest. Track per-callsite status in the "Migrated to registry?" column above.

After cutover: edits to a prompt happen in Lunary's dashboard (versioned + A/B-able without code deploys), then mirror back to `docs/llm-prompts/<slug>.md` same-day so the disk snapshot stays canonical.

### Eval harness — Promptfoo (manual trigger only)

`eval/` directory with a TS custom provider (`eval/provider.ts`) that dispatches each fixture's `callsite` slug to the real `chatJSON`-wrapped lib function. One YAML per callsite slug under `eval/suites/`, each holding an array of fixture test cases with `is-json` + schema-shape `javascript` + `llm-rubric` assertions. Judge model pinned to `MODEL_LITE_CHEAP` to keep rubric cost ~$0.001/call.

Run: `npm run test:prompts`. **NOT** wired into `pre-push.sh` — burns real Gemini tokens (~$0.01–0.05/full-run at 9 callsites × 2–3 fixtures). See [`../eval/README.md`](../eval/README.md) for full operation + the "Capturing real fixtures" recipe.

## Defaults baked into `chatJSON`

- `temperature` → 0.4 (callers override per task: 0.1 conservative extraction, 0.9 exploration).
- `maxOutputTokens` → **4096** (callers override per task; 32k only for profile import).
- `thinkingBudget` → 0 (Gemini 2.5+ defaults to thinking mode which adds 30s–2min latency and eats the output budget — all current callers are mechanical extraction, no chain-of-thought needed).
- `responseMimeType` → `"application/json"` (every caller is structured-output).

---

## Rate limiting

`lib/ai/rate-limit.ts:acquireGeminiSlot()` is a process-shared token bucket. Code default is **12 req/min, burst 60** (free-tier safe). Every Gemini call MUST go through `chatJSON` or `parseApplicationEmail` — both block on the bucket before hitting the API. Bypass = quota drain risk.

Env overrides:
- `GEMINI_RATE_PER_MIN` (default 12, **prod ships 60** via `.env.production` — paid-tier headroom for backfill bursts)
- `GEMINI_RATE_BURST` (default 60)

Practical ceiling: ingest is sequential, so RPM above ~120 stops mattering — Gemini's own response latency (~1-2 s/call) dominates past that. Raising the bucket only helps when the bucket itself is the bottleneck.

---

## Adding a new Gemini caller

1. Route through `chatJSON` (`lib/ai/gemini.ts`) — gets you retries, rate-limit gate, Zod validation, token-usage logging.
2. Pick the model:
   - Output is enum-like with ≤5 classes → `MODEL_LITE_CHEAP`.
   - Output ends up in front of a user as resume / cover-letter / similar high-stakes text → `MODEL_FLASH`.
   - Anything else → omit `model` (inherits `MODEL_LITE`).
3. Pass `maxOutputTokens` matched to the expected response size (roughly 4× your typical output, to absorb tail variance without burning budget).
4. Add a row to the inventory table above.
5. If you're sending external content (HTML, email body, resume text) cap the input length at the smallest size that still preserves the signal — tail content is almost always boilerplate.

---

## Change log

- **2026-05-24** — Observability infra landed (LOP-1 → LOP-9 from `implementation.md` §LLM observability + prompt registry). Lunary `wrapModel` integration at module-init in `chatJSON` (gated on `LUNARY_PUBLIC_KEY`). Required `name: string` field on `ChatJSONOptions` — TypeScript flags any unnamed call. All 7 chatJSON callsites + email-parser tagged with stable kebab-case slugs (see inventory above). `instrumentation.ts` calls `lunary.init()` when the key is present. `docs/llm-prompts/` directory seeded with 9 prompt blob `.md` files for LOP-6 cutover. `eval/` Promptfoo harness scaffolded with 9 suites, 13 starter fixtures, `npm run test:prompts` script. Pre-push gate unchanged (45/45 hermetic green). Per-callsite prompt-registry migration (LOP-6) is incremental, deferred to as-needed.
- **2026-05-20** — Employment-type classifier call shape rewrite. Switched to positional output (no external-id echoing — those Workday/Lever UUIDs were ~70 % of the output budget), pipe-delimited single-line-per-item input (was pretty-printed JSON), dropped `snippet/department` field (title is the load-bearing signal), tightened system prompt. `maxOutputTokens` 4096 → 1024. Measured drop from ~10 k tokens / batch to ~1.2 k tokens / batch (≈ 8× reduction). Same model.
- **2026-05-19** — Three-tier model split landed. `MODEL_FLASH` reserved for resume rewrite only; `MODEL_LITE_CHEAP` for employment-type classifier; `MODEL_LITE` default for everything else. Per-call `maxOutputTokens` introduced (default dropped from 32k → 4k). Email-parser input cap 6 KB → 3 KB; posting parser input cap 12 KB → 8 KB.
- **2026-05-19** — `DEFAULT_MODEL` pinned to `gemini-3.5-flash` (released same day). Superseded by the three-tier split above.
- **2026-05-15** — Switched from `gemini-2.5-flash` to `gemini-flash-latest` for ~30–42% latency improvement on resume generation.
