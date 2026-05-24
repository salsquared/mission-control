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

{{readme}}                         ← optional, project parents only

## Output schema
{ "bullets": [{ "text": "<bullet text>", "tags": ["<tag1>", "<tag2>"] }, ...] }
Return 3–5 bullets. Tags should be 1–3 lowercase keywords drawn from the text.
```

## Variables

- `spine` — pre-rendered markdown list of the parent entity's identifying fields. Produced by `renderSpine(parent)`. **Never trimmed.** Examples:
  - Work role: `## Entry\n- Kind: work-role\n- Company: Acme\n- Title: Engineer\n- Start date: 2022-01-01\n- End date: Present`
  - Project: `## Entry\n- Kind: project\n- Name: Pulsar\n- Description: Financial ingestion engine\n- Repo URL: ...`
  - Education: `## Entry\n- Kind: education\n- Institution: CSULB\n- Degree: B.S.\n- Field: Computer Science\n- ...`
- `siblings` — pre-rendered markdown list of up to 12 sibling bullets from the same profile, header included (`## Other bullets in this profile (voice + vocabulary reference)`). Capped to 1.5 KB; trims trailing entries from the (pre-ranked) list. Produced by `renderSiblingBullets(siblings, 1536)`. Empty string when the profile has no other bullets or all overflow.
- `archive` — pre-rendered markdown of up to 3 spans from prior uploaded resume versions, header included (`## Spans from prior uploaded resume versions`). Each block is `### filename (uploaded YYYY-MM-DD)\n<single-paragraph span>`. Capped to 1.5 KB. Produced by `renderArchiveSpans(spans, 1536)`. Empty string when no archive matches the parent or all overflow.
- `readme` — pre-rendered markdown of a single project's README excerpt, header included (`## Project README — <projectName>`). Capped to 2 KB. Produced by `renderReadme(ctx, 2048)`. Empty string when not a project parent or no README available.

## Notes

- Total user-prompt budget is 8 KB (`USER_PROMPT_LIMIT`). When sections overflow, the builder drops in priority order: `archive` → `siblings` → `readme`. `spine` + task statement + output schema are never trimmed.
- Server post-processing: response bullets get fresh cuid `id`, `locked: false`, `excluded: false` injected; slice to first 5 entries (`FILL_BULLET_CAP`).
- Output validated against `FillResponseSchema` (1–8 bullets allowed in LLM response, sliced to 5 after).
- Anti-repetition + voice grounding live in the sibling block — they're the user's own bullets, so the model picks up wording naturally.
