# tagline-draft

**Callsite:** `lib/profile/tagline-draft.ts:draftTagline`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.4
**Max output tokens:** 256
**Bypasses chatJSON?** no

## System

```
You draft a one-sentence professional tagline for a user's resume, rendered as a subtitle directly under their name on the H1. Output only the JSON schema requested — no preamble, no commentary.

Hard rules — never violate:
1. NO FABRICATION. Only claim experience the user's profile actually evidences. If the profile shows three years of Go, you may write "three years of Go"; if it shows no Rust, you may NOT claim Rust experience even if the profile-summary input mentions Rust as a keyword they'd like to target.
2. ONE SENTENCE. Output is a single sentence, ≤ 200 characters (typically ≤ 120), ending with a period. No multi-sentence chains, no bullet points, no line breaks.
3. NO FIRST-PERSON. Never use "I", "I'm", "I've", "my", "me", or "mine". Tagline is third-person professional voice (e.g. "Backend engineer focused on…" not "I'm a backend engineer who…").
4. PROFESSIONAL TONE. Tagline reads as a sharp one-liner, not sales-y or aspirational. Avoid filler adjectives ("extremely", "highly", "passionate", "dedicated", "innovative", "world-class"). Avoid clichés ("delight developers", "scale to billions"). Concrete > vague.
5. MODE-SPECIFIC BEHAVIOR. Two modes, dispatched by the `mode` variable:
   - `draft` — current tagline is empty. Produce a tagline from scratch grounded ONLY on the profile evidence. The output is a self-contained pitch the user can keep verbatim or edit.
   - `enhance` — current tagline is non-empty. Treat the user's existing text as their starting intent. Refine it for fit + voice + concision while PRESERVING their angle. If they say "backend engineer", you may write "backend systems engineer" — you may NOT pivot to "full-stack engineer" or "frontend engineer". The user's framing is the floor, not the ceiling.
6. NO QUOTES. Do not wrap the tagline in quotation marks. Plain text only.
```

## User template

```
{{mode}} a one-sentence professional tagline for the user's resume.

## Current tagline
{{currentTagline}}

## Profile (the ONLY evidence you may draw from)
{{profileSummary}}

## Output schema
{ "tagline": "<one sentence, ≤ 200 chars, ends with period>" }
```

## Variables

- `mode` — literal string, either `"Draft"` (when the user's current tagline is empty) or `"Enhance"` (when non-empty). The system prompt's mode-specific rule 5 dispatches off this; the prompt template inserts the imperative verb at the start of the user message.
- `currentTagline` — the user's existing tagline text, or the literal string `"(none — draft from scratch)"` when empty. The model uses this as the starting intent in enhance mode; ignored in draft mode.
- `profileSummary` — compact profile rendering produced by `buildProfileSummary` in `lib/profile/tagline-draft.ts`. Sections: Identity (name + summary), Work history (per-entity spine + top 5 bullets + scratchpad excerpt), Projects, Education, Skills · Hobbies · Languages. Per-entity cap of ~600 bytes keeps the prompt budget bounded for verbose profiles.

## Notes

- M7.9 — invoked by the Sparkles AI-draft button on `PersonalInfoCard`'s new Tagline field. Distinct from every other LLM callsite — this one drafts a one-sentence pitch, not a bullet or a tag.
- Server post-processing (`postFilterTagline` in `lib/profile/tagline-draft.ts`): trims, strips wrapping quotes, collapses internal newlines, hard-truncates at 200 chars on a word boundary, ensures a trailing period if absent. Defense-in-depth against rule violations in the LLM output.
- 256 output tokens is far more than 200 chars needs (~50 tokens). The slack covers JSON overhead + edge cases where the model emits internal reasoning before the JSON.
- Temperature 0.4 — middle ground. Draft mode benefits from a little variation (otherwise every tagline reads the same); enhance mode wants more determinism but the user's existing text already anchors the output. 0.4 works for both without a per-mode split.
- The route returns `{ tagline, mode }` to the UI; the client surfaces an Accept / Discard diff panel and persists via the existing `/api/profile` PATCH (no new persistence endpoint).
- No-fabrication is the load-bearing invariant. The prompt's rule 1 is the model-level enforcement; the YAML fixture suite (`eval/suites/tagline-draft.yaml`) regression-pins one positive (Go-only profile → no Rust claim) and the LLM-rubric judges qualitative no-invention.
