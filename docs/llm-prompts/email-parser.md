# email-parser

**Callsite:** `lib/email-parser.ts:parseApplicationEmail` — **highest-volume caller in the app** (one call per inbound Gmail message + backfill).
**Model:** `gemini-3.1-flash-lite` (pinned inline — kept in sync with `MODEL_LITE` in `lib/ai/gemini.ts`)
**Temperature:** (Vercel AI SDK default — not explicitly set)
**Max output tokens:** (Vercel AI SDK default — schema-driven)
**Bypasses chatJSON?** **yes — uses Vercel AI SDK `generateObject` directly.** Tracing wired manually via `lunary.trackEvent` in LOP-5 (defensive — failures in trackEvent never disrupt ingest).

## System

No separate system field — Vercel AI SDK's `generateObject` takes a single `prompt` field. Everything below is one prompt with the instructions and the inputs interleaved.

## User template (the full `prompt` argument)

```
You are classifying an email related to a job, internship, or college/university application.

First, decide whether this email is actually about the user's own application (they submitted something and this is a status update or related message). Marketing, job-board digests, recruiter cold-outreach to someone who never applied, and "we're hiring" company announcements are NOT application-related — set isApplicationRelated=false.

If it IS application-related, extract company/institution, role/program, current status, next steps, and any dates.

For colleges, treat admission/decision/waitlist/deferral language as the corresponding status. Treat supplemental-material requests as ASSESSMENT.

When resolving relative dates like "Tuesday at 3pm" or "next week", use the email's send-date below as the anchor.

Email send-date (anchor): {{anchor}}
From: {{from}}
Subject: {{subject}}
Body:
{{body}}
```

## Variables

- `anchor` — ISO 8601 timestamp from the email header date (`sentAt`), or `new Date().toISOString()` at call time when sentAt is null. Used by the model to resolve relative date phrasing ("Tuesday at 3pm").
- `from` — the email's From header, or `(unknown)`.
- `subject` — the email's Subject header.
- `body` — extracted plaintext body, capped at 3 KB (`emailContent.slice(0, 3000) + "\n…[truncated]"`). Application emails put the signal up top (greeting → status verb → action ask); tail is signature blocks / legal / forwarded threads.

## Notes

- Schema is `applicationSchema` in `lib/email-parser.ts` — relevance gate (`isApplicationRelated`) is the load-bearing field. When false, the caller skips the upsert.
- Body cap tightened 6 KB → 3 KB on 2026-05-19 alongside the model swap to flash-lite (see `docs/llm-calls.md` change log).
- College/university handling is calibrated against specific past failures — the FULL OFFICIAL name rule prevents the same school appearing as 'MIT' and 'Massachusetts Institute of Technology' in different emails (would defeat `normalizedCompany` dedup).
- Tracing wiring: `lunary.trackEvent('llm', 'start' / 'end' / 'error', ...)` with `runId = 'email-parser:<base36-ts>:<random>'`. The Gmail msgId isn't in scope at this layer (caller has it); Lunary just needs uniqueness. See `safeTrack` helper in `lib/email-parser.ts`.
- This callsite is the only one in the codebase using `@ai-sdk/google` + `generateObject` directly. Migration path: if `chatJSON` ever gains a `generateObject`-compatible mode, this should move to it (LOP-3's `wrapModel` would automatically pick it up). For now, the manual trackEvent path is the canonical pattern for SDK-bypassing callers.
- Pinned to `gemini-3.1-flash-lite` inline because the Vercel AI SDK wraps the model name into a provider call before any code can intercept it. Comment in source flags the sync-with-MODEL_LITE invariant.
