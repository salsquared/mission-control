# discovery-suggest

**Callsite:** `lib/discovery/suggest.ts:suggestCompanies`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`, default)
**Temperature:** 0.9
**Max output tokens:** 4096
**Bypasses chatJSON?** no

## System

No `system` field — single-prompt call. The instruction set lives in the user prompt below.

## User template

```
You're helping a job seeker discover companies in the topic: "{{topic}}".

{{excludeBlock}}

Suggest {{count}} ADDITIONAL companies in this topic that are NOT in the excluded list. Prefer real companies actively hiring. Include both well-known players AND smaller / less-obvious ones — the user already has the canonical names, they need depth.

For each company return:
  - name        canonical company name
  - blurb       one short sentence about what they do, under 80 chars
  - careersUrl  the public careers-page URL you're confident exists (or "" if unsure)

Do NOT guess the ATS or fabricate slugs — we verify ATS connectivity ourselves downstream by probing greenhouse / lever / ashby with the company name. Focus on returning real companies; that's the only thing we need from you.

Return JSON: { "candidates": [ ... ] }. No prose, no markdown fence.
```

## Variables

- `topic` — user-supplied free-text topic, trimmed. E.g. `"space"`, `"climate tech"`, `"defense"`.
- `excludeBlock` — one of two forms:
  - When the user has companies in this topic already (the common case):
    ```
    EXCLUDED — do NOT suggest any of these (the user already has them):
    - Anduril
    - Anthropic
    - Blue Origin
    ```
  - When the topic is empty:
    ```
    (The user has nothing in this topic yet — suggest from scratch.)
    ```
- `count` — number of companies to ask for. Defaults to 20 (`opts.count ?? 20`).

The exclude list is built by combining: `COMPANY_DIRECTORY` entries for the topic + the user's existing watchlist company names + caller-supplied additional excludes.

## Notes

- **Anti-repetition is load-bearing** — see [[feedback-llm-anti-repetition]]. Without the exclude block, Gemini loops the same canonical 5-7 names for any topic. Successive "Refresh suggestions" clicks keep digging by accumulating into `exclude`.
- Highest temperature in the fleet (0.9) — discovery is the one place exploration matters more than determinism. Lower temps converge on the same handful of "Anduril, Anthropic, Blue Origin" responses regardless of the exclude list.
- The model gets explicit instructions to NOT guess ATS slugs — deterministic probing via `resolveCompanyToBoard()` in `lib/discovery/slug-probe.ts` happens after the LLM call. Gemini would guess `slug === companyname` and 404 on real boards otherwise.
- Provider-side defense: caller filters Gemini's response against the exclude set anyway (Gemini sometimes repeats excluded names when they're famous).
- Output schema: `{candidates: [{name, blurb?, careersUrl?}]}`. `blurb` and `careersUrl` default to empty string when omitted.
- Hermetic smoke at `scripts/tests/hermetic/discovery-suggest-smoke.ts` mocks the LLM via the `_suggestFn` test seam.
