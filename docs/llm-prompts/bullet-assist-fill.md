# bullet-assist-fill

**Callsite:** `lib/profile/bullet-assist.ts` (mode: `'fill'`)
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.4
**Max output tokens:** 4096
**Bypasses chatJSON?** no

## System

```
You are drafting or polishing professional resume bullets for the user. Output only the JSON schema requested — no preamble, no commentary.

Hard rules — never violate:
1. Do not invent specific quantitative claims (percentages, dollar amounts, user counts, performance numbers). If you have no source for a number, phrase the contribution qualitatively.
2. Preserve the user's existing tense and voice. Do not switch to first-person.
3. If you cannot produce a defensible bullet from the available context, return fewer bullets — never pad with generic filler.
4. When the archive shows the same role described with different wording across versions, prefer the most concrete / metric-bearing phrasing. When the current profile has a blank that the archive fills, prefer the archive's specifics over a generic restatement.
```

## User template

Sections appear in this order. Optional sections are omitted entirely (header + body) when their variable is empty.

```
Fill 3 to 5 starter bullets for this entry.

{{spine}}

{{siblings}}                       ← optional, omitted if empty

{{archive}}                        ← optional, omitted if empty

{{scratchpad}}                     ← optional, omitted if empty (M7.8.5)

## Output schema
{ "bullets": [{ "text": "<bullet text>", "tags": ["<tag1>", "<tag2>"] }, ...] }
Return 3–5 bullets. Tags should be 1–3 lowercase keywords drawn from the text. When the scratchpad section is present, match the user's voice + cadence + specifics — those notes are the most direct evidence of what this entry actually involved.
```

## Variables

- `spine` — pre-rendered markdown list of the parent entity's identifying fields. Produced by `renderSpine(parent)`. **Never trimmed.** Examples:
  - Work role: `## Entry\n- Kind: work-role\n- Company: Acme\n- Title: Engineer\n- Start date: 2022-01-01\n- End date: Present`
  - Project: `## Entry\n- Kind: project\n- Name: Pulsar\n- Description: Financial ingestion engine\n- Repo URL: ...`
  - Education: `## Entry\n- Kind: education\n- Institution: CSULB\n- Degree: B.S.\n- Field: Computer Science\n- ...`
- `siblings` — pre-rendered markdown list of up to 12 sibling bullets from the same profile, header included (`## Other bullets in this profile (voice + vocabulary reference)`). Capped to 1.5 KB; trims trailing entries from the (pre-ranked) list. Produced by `renderSiblingBullets(siblings, 1536)`. Empty string when the profile has no other bullets or all overflow.
- `archive` — pre-rendered markdown of up to 3 spans from prior uploaded resume versions, header included (`## Spans from prior uploaded resume versions`). Each block is `### filename (uploaded YYYY-MM-DD)\n<single-paragraph span>`. Capped to 1.5 KB. Produced by `renderArchiveSpans(spans, 1536)`. Empty string when no archive matches the parent or all overflow.
- `scratchpad` — **M7.8.5 (story S7.13)** — pre-rendered markdown of the parent entity's OWN scratchpad text, header included (`## User's notes about this role/project/education (their own voice)`). Capped to 2 KB. Produced by `renderScratchpad(parent.scratchpad, 2048)`. Cross-entity isolation enforced at the caller — only the current parent's scratchpad ever appears. Empty string when null / empty.

## Notes

- Total user-prompt budget is 8 KB (`USER_PROMPT_LIMIT`). When sections overflow, the builder drops in priority order: `archive` → `siblings` → `scratchpad`. Scratchpad drops LAST because it's the user's most-targeted grounding for this specific entity. `spine` + task statement + output schema are never trimmed.
- Server post-processing: response bullets get fresh cuid `id`, `locked: false`, `excluded: false`, `pinnedTags: []`, `autoTags: []`, `removedTags: []` injected; slice to first 5 entries (`FILL_BULLET_CAP`).
- Output validated against `FillResponseSchema` (1–8 bullets allowed in LLM response, sliced to 5 after).
- Anti-repetition + voice grounding live in the sibling block — they're the user's own bullets, so the model picks up wording naturally. The scratchpad block adds direct experience grounding when the user has populated it.
