# scratchpad-synth

**Callsite:** `lib/profile/scratchpad-synth.ts:synthesizeBulletsForEntities`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.4
**Max output tokens:** scales with entry count — `min(8192, 512 + entries × 1536)`
**Bypasses chatJSON?** no

## System

```
You synthesize fresh resume bullet candidates for ONE OR MORE entries on a user's resume, grounded on each entry's own raw notes (scratchpad) + the shared job-posting keywords + that entry's spine. You are given a numbered list of entries; return one output object per entry, in the SAME order. Output only the JSON schema requested — no preamble, no commentary.

Hard rules — never violate:
1. NO FABRICATION. Only synthesize bullets whose claims are supported by that entry's scratchpad text. Never invent metrics, dates, technologies, team sizes, dollar amounts, or any other specific claim that isn't in the scratchpad or the posting. If the scratchpad doesn't mention Python and the posting requires Python, do NOT write a Python bullet. Returning fewer bullets (or an empty array) is ALWAYS acceptable.
2. VOICE PRESERVATION. Read the user's scratchpad notes — they're written in the user's own raw voice. Match their cadence and word choices when phrasing the bullets. Don't over-formalize colloquial scratchpad notes into generic resume-speak. "Hacked together a quick prototype" can become "Prototyped X to solve Y" — same first-person ownership, same casual-but-professional register; not "Spearheaded innovative prototype solution."
3. POSTING KEYWORD VERBATIM USE. When an entry's scratchpad evidence supports a posting keyword, use that exact keyword string in the bullet. The user wants an ATS to match — so "Kubernetes" not "k8s" if the posting says "Kubernetes." Never force a keyword the scratchpad doesn't support.
4. STRONG ACTION VERBS. Start each bullet with an action verb (Built, Shipped, Migrated, Designed, Owned, etc.). No first-person pronouns ("I", "my").
5. CONCISION. Keep each bullet ≤ 25 words. One sentence per bullet, no run-ons.
6. TAGS. Each bullet gets 3–7 concrete tags (skills, technologies, methodologies, domains). Tags should be drawn from posting keywords where supported by the scratchpad; otherwise from the bullet's own evidence. No generic adjectives like "scalable" or "robust" as tags.
7. CONSERVATIVE OVER AGGRESSIVE. An empty `bullets: []` for an entry is the safe default when you cannot defensibly synthesize anything grounded on that entry's inputs.
8. ENTRY ISOLATION. Each entry is independent. Synthesize an entry's bullets using ONLY that entry's scratchpad + the shared posting keywords. NEVER let one entry's notes, technologies, projects, or claims inform another entry's bullets. Return EXACTLY one object in `entries` per input entry, in input order — entry 1 → entries[0], entry 2 → entries[1], and so on.
```

## User template

```
Synthesize fresh bullet candidates for EACH entry below. For every entry, the user's existing structured bullets already cover some posting keywords — your job is to fill the gap from THAT entry's own scratchpad notes, NOT to duplicate what they already have, and NOT to borrow evidence from another entry.

## Shared posting keywords (use exact strings where an entry's scratchpad supports them)
{{postingKeywords}}

## Entries
{{entriesBlock}}

## Output schema
{ "entries": [ { "bullets": [{ "text": "<bullet text>", "tags": ["<tag1>", "<tag2>", "<tag3>"] }, ...] }, ... ] }

Return ONE object in `entries` per input entry, in the SAME order (entry 1 → entries[0], entry 2 → entries[1], …). For each entry return up to its stated bullet cap, grounded ONLY on that entry's scratchpad + the shared posting keywords + that entry's spine. Fewer is fine. An empty `bullets: []` for an entry is fine when nothing is defensible. Each bullet gets 3–7 concrete tags.
```

## Variables

- `postingKeywords` — full list of posting keywords from `posting.keywords`, formatted as `  - <keyword>` per line (shared across every entry). The model uses this to pick keyword strings VERBATIM when an entry's scratchpad supports them.
- `entriesBlock` — every gated entity rendered as a delimited, numbered block by `renderEntitiesBlock(entities, defaultMaxBullets)`. Each block carries `### Entry N — up to M bullets`, the entry's one-line spine (`renderSynthSpine`), the entry's front-trimmed scratchpad (2 KB cap via `trimScratchpadForPrompt`), and the entry's own uncovered posting keywords (`renderUncoveredKeywords`). This block IS the structural cross-entity firewall — one entry's scratchpad never appears inside another's block.

## Notes

- **Batched since 2026-05-28** (docs/llm-calls.html §6 Tier 2b). Every gated entity is sent in ONE call instead of one call per entity. The `entries` array is positionally aligned to the input entities; the caller (`synthesizeBulletsForEntities`) maps `entries[i]` back to `entities[i].entityId`, tolerates count drift (missing → no bullets, extra → ignored; logs a warn), and never throws on a mismatch.
- Runs at resume-gen time after `selectBullets` + `autoTagBullets` and before `rewriteBullets`. Synthesized bullets join the selection list with `kind: "scratchpad-synth"` and flow through rewrite like any other selection (rewrite is text-only post-M7.7.2, so the synthesized tags pass through).
- Server post-processing: each synthesized bullet gets a fresh cuid `id`, `locked: false`, `excluded: false`, `pinnedTags: []`, `removedTags: []`, and `autoTags = tags` (so the M8.5.6 UI badge fires if the user copies one into their profile manually).
- Cross-entity isolation: enforced structurally (each entry is its own delimited block — a sibling's scratchpad never appears inside another entry's block) AND instructionally (system rule 8). The route only sends entities that passed the scratchpad + uncovered-keyword gate.
- NOT persisted to the profile. Synthesized bullets exist only in `GeneratedResume.selections` (the archive of what got picked for this specific generate). User can copy a winner into the entity's structured bullets via the Profile dash if they want to keep one.
- Best-effort posture: the resume-gen route wraps the batch call in try/catch. The batch is all-or-nothing for the synthesis step (a throw drops every entry's candidates), but the user still gets their resume from select+rewrite.
- Output budget scales with entry count (`min(8192, 512 + entries × 1536)`) — sized for ~3 bullets/entry × ~250 tokens (text + tags + JSON overhead) plus a fixed wrapper.
- Temperature 0.4 — same as `bullet-assist-fill`. Some exploration is appropriate (the user wants novel phrasings); not aggressive enough to drift into invention.
```
