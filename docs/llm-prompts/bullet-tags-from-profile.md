# bullet-tags-from-profile

**Callsite:** `lib/profile/bullet-tag-suggest.ts:suggestTagsForBullet`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.3
**Max output tokens:** 1024
**Bypasses chatJSON?** no

## System

```
You propose a final tag list for a single resume bullet. Output only the JSON schema requested — no preamble, no commentary. Tags label the bullet's evidence with concrete skills, technologies, methodologies, or domains.

Hard rules — never violate:
1. Output 3 to 7 tags total — pinned + unpinned, counted together. If you genuinely cannot defend 3 tags from the bullet's text, return what you can defend (fewer is acceptable).
2. Every tag the input marks `[pinned]` MUST appear verbatim in your output. Pinned tags are the user's anchor — they are not candidates for replacement or removal.
3. Never propose a tag listed in the "Blocked tags" section. The user explicitly removed those; do not bring them back.
4. No fabrication: only tag what the bullet's text actually evidences. A bullet about Go work cannot be tagged "Rust" because the user might know Rust. A bullet about bartending cannot be tagged "Infrastructure Management" because the user has tech experience elsewhere. The bullet's own words are the only evidence.
5. Vocabulary reuse is a TIEBREAKER, not an override of Rule 4. When two candidate tags would label the bullet's evidence equally well, prefer the one already in the "Profile vocabulary" section so the user's tag-space stays consistent (e.g. reuse "TypeScript" instead of inventing "TS"). When NO vocabulary term genuinely fits the bullet's domain, invent appropriate new tags — do not stretch a vocabulary term to fit. Vocabulary tags from "OTHER profile entries" are especially likely to belong to a different domain than the current bullet; only reuse them when they describe evidence actually present in the bullet text.
6. Tags must be concrete: skills (Python, Kubernetes), technologies (Postgres, React), methodologies (CI/CD, code review), or domains (distributed systems, payments). NOT generic adjectives (great, scalable, robust, modern).
7. Tags should be short — typically 1–3 words, max ~30 chars. Keep capitalization consistent with the profile vocabulary (e.g. "TypeScript" not "typescript" if the vocabulary uses TypeScript).

Output is the proposed final tag list, replacing the bullet's current tags wholesale (except pins, which must be preserved). Tags the input marks `[auto]` or `[user]` are candidates — you may keep, replace, or remove them to make room for stronger labels.
```

## User template

```
Propose a final tag list for the bullet below.

## Entry context
{{spine}}

## Bullet text
{{bulletText}}

## Current tags
{{tagState}}

## Blocked tags (never propose these)
{{removedTags}}

## Profile vocabulary (reuse as a TIEBREAKER between equally-fitting candidates — never as an override of "no fabrication")
{{vocabulary}}

## Output schema
{ "tags": ["<tag1>", "<tag2>", ...], "reason": "<short explanation, optional>" }

Return 3–7 tags total including every `[pinned]` tag verbatim. Tags are concrete skills / technologies / methodologies / domains. No generic adjectives. No fabrication — every tag must be defensible from the bullet text alone, even if that means inventing new tags rather than reusing the profile vocabulary. The `reason` field is optional — include a 1-sentence explanation only if the proposal is non-obvious (e.g. you swapped out a user tag because it didn't match the bullet text, or invented new tags because no vocabulary terms fit).
```

## Variables

- `spine` — short 1-line context, e.g. `"Software Engineer at Acme Corp"` or `"Project: mission-control"` or `"B.S. at State University"`. Helps the LLM understand whether to tag this as work-experience evidence vs. project portfolio vs. coursework.
- `bulletText` — the bullet's text, truncated at 500 chars defensively. Profile bullets are usually ≤ 200 chars; truncation only fires on a runaway hand-edit.
- `tagState` — multi-line list of the current tags, each marked `[pinned]` / `[auto]` / `[user]`. Pinned-first ordering. When the bullet has zero tags, this becomes a single line: `(no tags yet — propose 3–7 from scratch grounded on the bullet text)`.
- `removedTags` — multi-line list of the bullet's blocklist (`removedTags` JSON array). When empty: `(none)`.
- `vocabulary` — frequency-sorted profile tag list split into two labeled sub-sections: (a) tags from OTHER bullets in the SAME parent entity (most likely to share this bullet's domain), and (b) tags from OTHER profile entries (only reuse if they genuinely fit). Excludes tags already on the current bullet (they're already visible in `tagState`). When the profile is fresh: `(no other tags in the profile yet — invent appropriate ones)`. The split is computed by `computeContextualTagVocabulary` in `lib/profile/bullet-tag-suggest.ts`; the rendering is `renderVocabulary`.

## Notes

- M7.7.3 — invoked by the Tags icon on `components/ui/BulletRow.tsx` (sibling to the wand for text rewrite). Posting-agnostic — distinct from the M8.5 bulk auto-tag pass which runs at resume-gen time against posting keywords.
- The route (M7.7.5) checks `bullet.tags.length < 7` BEFORE invoking this caller. A bullet at the 7-tag cap returns 400 `tag-limit-reached`; no LLM round-trip. So the prompt never sees an over-capped bullet as input.
- Server post-filter (`applyTagSuggestPostFilter`) re-adds any pinned tag the LLM dropped, strips any tag in `removedTags`, dedupes, and truncates to 7. The prompt enforces these contracts at the model layer; the post-filter enforces them at the server layer as defense-in-depth.
- Lower temperature (0.3) than fill (0.7) — tag suggestion is closer to classification than to writing. Some exploration is fine (the user wants the model to consider alternatives to existing tags) but not free-form generation.
- 1024 output tokens — far more than 7 tags need. The slack is for the optional `reason` field plus any internal model overhead. If the model truncates at MAX_TOKENS in practice, bump first.
- On accept (M7.7.7), the client persists via the existing entity PATCH with `bullet.tags = proposal.tags`. Tags newly introduced by the proposal (in `proposal.tags` but not in the original `bullet.tags`) get marked into `bullet.autoTags` so the UI badges them as pending user confirmation (same semantic as M8.5.6). Pinned tags stay in `pinnedTags`. Dropped tags are NOT added to `removedTags` — only an explicit chip-X click adds to the blocklist.
