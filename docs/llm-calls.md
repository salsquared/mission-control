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

| File | Model | maxOutputTokens | Input cap | Notes |
|---|---|---|---|---|
| `lib/email-parser.ts` (parseApplicationEmail) | `MODEL_LITE` | n/a (Vercel SDK) | **3 KB** body | Highest-volume caller. One call per inbound Gmail message + every backfill. Pinned inline because Vercel AI SDK wraps the model name into a provider call. |
| `lib/ai/classify-employment-type.ts` (classifyEmploymentTypes) | `MODEL_LITE_CHEAP` | **1024** | 50 items/batch | Pure 5-class enum picker per posting. Cheapest model is invisible-quality. Positional output (`{"types":[…]}` array, no id echoing) — see 2026-05-20 change log entry. |
| `lib/discovery/suggest.ts` (suggestCompanies) | `MODEL_LITE` *(default)* | 4096 | small | User-triggered "Discover companies". Temp 0.9 for exploration. |
| `lib/resumes/posting.ts` (parsePosting) | `MODEL_LITE` *(default)* | 2048 | **8 KB** posting | Keyword extraction from job posting HTML/text. |
| `lib/resumes/rewrite.ts` (rewriteBullets) | **`MODEL_FLASH`** | 4096 | small | Output directly becomes resume bullets the user sends to employers. |
| `lib/profile/bullet-assist.ts` (callBulletAssist) | `gemini-3.1-flash` *(literal)* | 4096 (fill) / 2048 (rewrite) | ~8 KB user prompt (capped inside builder) | M7.6 / S7.7+S7.8+S7.9 — bullet drafting + rewriting + archive grounding on Profile entries. The SKU is not in the model-fleet constants; pinned inline. Rate-limited at `profile:bullet-assist` 20 / 10 min in the route. |
| `lib/profile/import-llm.ts` (extractProfileFromText) | `MODEL_LITE` *(default)* | **32768** | 60 KB resume | Per-file mechanical extraction — verbatim preservation, no judgment. Large output budget because nested bullets across many roles + projects + education legitimately need it. |
| `lib/profile/synthesize.ts` (synthesizeMasterResume) | **`MODEL_FLASH`** | **32768** | 80 KB serialized inputs | **One call per import.** Consolidates all per-file extractions + existing profile into the canonical "master resume" stored on the Profile dash. Resolves role-vs-project misclassifications across files, dedupes entities, orders reverse-chrono. The output IS what every downstream tailored-resume rewrite pulls from — quality matters. |

---

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

- **2026-05-20** — Employment-type classifier call shape rewrite. Switched to positional output (no external-id echoing — those Workday/Lever UUIDs were ~70 % of the output budget), pipe-delimited single-line-per-item input (was pretty-printed JSON), dropped `snippet/department` field (title is the load-bearing signal), tightened system prompt. `maxOutputTokens` 4096 → 1024. Measured drop from ~10 k tokens / batch to ~1.2 k tokens / batch (≈ 8× reduction). Same model.
- **2026-05-19** — Three-tier model split landed. `MODEL_FLASH` reserved for resume rewrite only; `MODEL_LITE_CHEAP` for employment-type classifier; `MODEL_LITE` default for everything else. Per-call `maxOutputTokens` introduced (default dropped from 32k → 4k). Email-parser input cap 6 KB → 3 KB; posting parser input cap 12 KB → 8 KB.
- **2026-05-19** — `DEFAULT_MODEL` pinned to `gemini-3.5-flash` (released same day). Superseded by the three-tier split above.
- **2026-05-15** — Switched from `gemini-2.5-flash` to `gemini-flash-latest` for ~30–42% latency improvement on resume generation.
