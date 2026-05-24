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
Rewrite this one bullet. Return both the new text AND updated tags reflecting the new wording — when the rewrite changes which skills / technologies / themes the bullet emphasizes, the tags should change with it.

{{spine}}

{{siblings}}                       ← optional, omitted if empty

{{archive}}                        ← optional, omitted if empty

{{readme}}                         ← optional, project parents only

## Current bullet to rewrite
{{currentBulletText}}
tags: [{{currentBulletTags}}]

## Output schema
{ "text": "<rewritten bullet text>", "tags": ["<tag1>", "<tag2>"] }
Return the new text plus 1–3 lowercase keyword tags reflecting the rewritten wording (typically skills, technologies, or themes the rewrite emphasizes). Keep the text length range close to the original (±20%). Tags MAY repeat the originals when the rewrite preserves the same concepts; tags MUST change when the rewrite shifts emphasis. Do not echo the id — that is preserved by the server.
```

## Variables

Inherits all four from `bullet-assist-fill` (`spine`, `siblings`, `archive`, `readme`) plus:

- `currentBulletText` — the original bullet's text, unmodified.
- `currentBulletTags` — JSON-stringified comma-separated list of the original bullet's tags, e.g. `"typescript", "performance"`. Produced by `current.tags.map(t => JSON.stringify(t)).join(', ')`.

## Notes

- The `Current bullet to rewrite` block is **never trimmed** (along with spine + task statement + output schema). Overflow trim order is the same as fill: `archive` → `siblings` → `readme`.
- Output schema enforces text length 1–2000 chars; tags array defaults to `[]` when the model omits them (lenient — UI lets the user re-tag manually after Accept).
- Server post-processing: response replaces `text` + `tags` on the existing bullet; `id` / `locked` / `excluded` are preserved from the original `currentBullet` passed in. The schema instructs the model to not echo the id (server-side enforcement).
- Lower token cap than fill (2048 vs 4096) because rewrite is single-bullet output.
- Wand icon in `components/ui/BulletRow.tsx` triggers this; hidden when `bullet.locked === true` (defense-in-depth — server also rejects locked rewrites with 400).
