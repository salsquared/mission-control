# bullet-assist-rewrite

**Callsite:** `lib/profile/bullet-assist.ts` (mode: `'rewrite'`)
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.4
**Max output tokens:** 2048
**Bypasses chatJSON?** no

## System

Identical to [`bullet-assist-fill`](./bullet-assist-fill.md) — same 4-rule hallucination guard. Lunary template note: when migrating, both `bullet-assist-fill` and `bullet-assist-rewrite` should reference the same system-prompt source. If Lunary's UI doesn't natively support that, paste it verbatim in both and keep them in sync from this file.

```
You are drafting or polishing professional resume bullets for the user. Output only the JSON schema requested — no preamble, no commentary.

Hard rules — never violate:
1. Do not invent specific quantitative claims (percentages, dollar amounts, user counts, performance numbers). If you have no source for a number, phrase the contribution qualitatively.
2. Preserve the user's existing tense and voice. Do not switch to first-person.
3. If you cannot produce a defensible bullet from the available context, return fewer bullets — never pad with generic filler.
4. When the archive shows the same role described with different wording across versions, prefer the most concrete / metric-bearing phrasing. When the current profile has a blank that the archive fills, prefer the archive's specifics over a generic restatement.
```

## User template

Same section assembly as `bullet-assist-fill` plus the `Current bullet` block before the output schema.

```
Rewrite this one bullet. **Return ONLY the new text — do not return tags.** Tags on this bullet are owned by a separate flow (`bullet-tags-from-profile`); this rewrite must not touch them. The user invokes you when they want sharper wording without losing their carefully chosen tag set.

{{spine}}

{{siblings}}                       ← optional, omitted if empty

{{archive}}                        ← optional, omitted if empty

{{scratchpad}}                     ← optional, omitted if empty (M7.8.5)

## Current bullet to rewrite
{{currentBulletText}}
tags (for context only — do not return or modify): [{{currentBulletTags}}]

## Output schema
{ "text": "<rewritten bullet text>" }
Return the new text only. Keep the text length range close to the original (±20%). When the scratchpad section is present, draw on the user's actual experience + cadence + specifics — those notes are the most direct evidence of what this work actually involved. Do not echo the id — that is preserved by the server. Do not return a `tags` field.
```

## Variables

Inherits all four from `bullet-assist-fill` (`spine`, `siblings`, `archive`, `scratchpad`) plus:

- `currentBulletText` — the original bullet's text, unmodified.
- `currentBulletTags` — JSON-stringified comma-separated list of the original bullet's tags, e.g. `"typescript", "performance"`. Produced by `current.tags.map(t => JSON.stringify(t)).join(', ')`. Sent as **context only** — the LLM uses tags to understand bullet emphasis but must not output a `tags` field.

## Notes

- M7.7.2 (S7.10) narrowed this to text-only. The `M7.6` enhancement that added tag-update is reverted. Tag churn now lives in the sibling `bullet-tags-from-profile` callsite (Tags icon in `components/ui/BulletRow.tsx`, next to the wand).
- The `Current bullet to rewrite` block is **never trimmed** (along with spine + task statement + output schema). Overflow trim order is the same as fill: `archive` → `siblings` → `scratchpad` (scratchpad drops last because it's the user's most-targeted grounding for this specific entity).
- Output schema enforces text length 1–2000 chars. No `tags` field — server preserves all tag-related state (`tags`, `autoTags`, `removedTags`, `pinnedTags`) from the input bullet verbatim.
- Server post-processing: response replaces only `text` on the existing bullet; `id` / tags / `autoTags` / `removedTags` / `pinnedTags` / `locked` / `excluded` all pass through. The schema instructs the model to not echo the id (server-side enforcement).
- Lower token cap than fill (2048 vs 4096) because rewrite is single-bullet output.
- Wand icon in `components/ui/BulletRow.tsx` triggers this; hidden when `bullet.locked === true` (defense-in-depth — server also rejects locked rewrites with 400).
