# scratchpad-synth

**Callsite:** `lib/profile/scratchpad-synth.ts:synthesizeBulletsForEntity`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.4
**Max output tokens:** 2048
**Bypasses chatJSON?** no

## System

```
You synthesize fresh resume bullet candidates for one entry on a user's resume, grounded on the user's own raw notes (scratchpad) + the job posting's keywords + the entry's spine. Output only the JSON schema requested — no preamble, no commentary.

Hard rules — never violate:
1. NO FABRICATION. Only synthesize bullets whose claims are supported by the user's scratchpad text. Never invent metrics, dates, technologies, team sizes, dollar amounts, or any other specific claim that isn't in the scratchpad or the posting. If the scratchpad doesn't mention Python and the posting requires Python, do NOT write a Python bullet. Returning fewer bullets (or an empty array) is ALWAYS acceptable.
2. VOICE PRESERVATION. Read the user's scratchpad notes — they're written in the user's own raw voice. Match their cadence and word choices when phrasing the bullets. Don't over-formalize colloquial scratchpad notes into generic resume-speak. "Hacked together a quick prototype" can become "Prototyped X to solve Y" — same first-person ownership, same casual-but-professional register; not "Spearheaded innovative prototype solution."
3. POSTING KEYWORD VERBATIM USE. When the scratchpad evidence supports a posting keyword, use that exact keyword string in the bullet. The user wants an ATS to match — so "Kubernetes" not "k8s" if the posting says "Kubernetes." Never force a keyword the scratchpad doesn't support.
4. STRONG ACTION VERBS. Start each bullet with an action verb (Built, Shipped, Migrated, Designed, Owned, etc.). No first-person pronouns ("I", "my").
5. CONCISION. Keep each bullet ≤ 25 words. One sentence per bullet, no run-ons.
6. TAGS. Each bullet gets 3–7 concrete tags (skills, technologies, methodologies, domains). Tags should be drawn from posting keywords where supported by the scratchpad; otherwise from the bullet's own evidence. No generic adjectives like "scalable" or "robust" as tags.
7. CONSERVATIVE OVER AGGRESSIVE. Empty `bullets: []` is the safe default when you cannot defensibly synthesize anything grounded on the inputs.
```

## User template

```
Synthesize up to {{maxBullets}} fresh bullet candidates for this entry. The user's structured profile bullets already cover some of the posting's keywords — your job is to fill the gap from the user's own scratchpad notes, NOT to duplicate what they already have.

## Entry context
{{spine}}

## User's scratchpad notes (their own voice — match this cadence)
{{scratchpad}}

## All posting keywords (use exact strings where the scratchpad supports them)
{{postingKeywords}}

## Uncovered posting keywords (these are the high-value targets)
{{uncoveredKeywords}}

## Output schema
{ "bullets": [{ "text": "<bullet text>", "tags": ["<tag1>", "<tag2>", "<tag3>"] }, ...] }

Return UP TO {{maxBullets}} bullets, grounded ONLY on the scratchpad + posting keywords + spine. Fewer is fine. Empty array is fine when nothing is defensible. Each bullet gets 3–7 concrete tags.
```

## Variables

- `spine` — short 1-line context produced by `renderSynthSpine(entityKind, entitySpine)`. Examples: `"Software Engineer at Acme Corp"`, `"Project: mission-control"`, `"B.S. at State University"`. Keeps the prompt compact since the bulk of grounding lives in the scratchpad.
- `scratchpad` — the entity's `scratchpad` column, front-trimmed to 2 KB at the prompt layer (`trimScratchpadForPrompt`). The user wrote this in their own voice; the model should mirror their cadence.
- `postingKeywords` — full list of posting keywords from `posting.keywords`, formatted as `  - <keyword>` per line. The model uses this to pick keyword strings VERBATIM when the scratchpad supports them.
- `uncoveredKeywords` — the subset of posting keywords NOT already covered by the user's existing profile bullets. Same line format. These are the high-priority gaps the synthesis tries to close.
- `maxBullets` — string-rendered cap on synthesized bullets per entity. Default 3 at the caller level (`DEFAULT_MAX_BULLETS`). Keeps the resume from filling with LLM-spun bullets when the scratchpad is verbose.

## Notes

- Runs at resume-gen time after `selectBullets` + `autoTagBullets` and before `rewriteBullets`. Synthesized bullets join the selection list with `kind: "scratchpad-synth"` and flow through rewrite like any other selection (rewrite is text-only post-M7.7.2, so the synthesized tags pass through).
- Server post-processing: each synthesized bullet gets a fresh cuid `id`, `locked: false`, `excluded: false`, `pinnedTags: []`, `removedTags: []`, and `autoTags = tags` (so the M8.5.6 UI badge fires if the user copies one into their profile manually).
- Cross-entity isolation: this caller only sees ONE entity's scratchpad per invocation. The resume-gen route calls this once per relevant entity. A sibling entity's notes NEVER reach this prompt.
- NOT persisted to the profile. Synthesized bullets exist only in `GeneratedResume.selections` (the archive of what got picked for this specific generate). User can copy a winner into the entity's structured bullets via the Profile dash if they want to keep one.
- Best-effort posture: the resume-gen route wraps each per-entity call in try/catch. One entity's synthesis throw doesn't block the others; total synthesis failure across all entities is fine — the user still gets their resume from select+rewrite.
- 2048 output tokens — sized for ~3 bullets × ~250 tokens (text + tags + JSON overhead). Bumps reserved for outlier scratchpads.
- Temperature 0.4 — same as `bullet-assist-fill`. Some exploration is appropriate (the user wants novel phrasings); not aggressive enough to drift into invention.
