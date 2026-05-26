# Implementation plan

Operational companion to [`docs/user-stories.md`](./user-stories.md). That doc says **what** we're building and **why**; this doc says **how** and **in what order** — concrete file paths, table shapes, API contracts, and acceptance criteria.

Cross-session running state lives in [`docs/next_steps.md`](./next_steps.md): what was just done, what's blocked on whom, today's critical path. This file is durable design; `next_steps.md` is fast-moving status. When a milestone ships, mark it ✅ here and `next_steps.md` gets compacted.

## Status legend

- ✅ Shipped (committed on `main`, smoked end-to-end)
- ◐ Partial (one half shipped, other half intentionally out-of-scope or pending)
- 🟢 In progress (active branch / open PR / current session)
- ⏳ Planned (designed, sequenced, not yet started)
- 💤 Deferred (intentionally backlogged — story priority is 🟡/🔵 or it's blocked)
- ⛔ Declined by user (kept in the doc so the decision doesn't get re-litigated)
- ❌ Killed (decided against on technical grounds)

Each milestone lists the **user stories** it satisfies (numbers refer to `user-stories.md`). Story priority emoji from that doc: **🔴** = must-have for next ship, **🟡** = important, **🔵** = nice-to-have. Those are *priority*, not status — every 🔴 in this plan is already ✅.

---

## Status snapshot (2026-05-25)

**TL;DR — every designed milestone phase is now shipped; the open backlog is the audit-found soft-bug list + deferred S7.6 rollback UX.** Three milestones landed in the past 72 hours: **M7.6** (LLM bullet assist + resume-upload archive, 2026-05-23) — `7ffd5ba`, `fffa038`. **M8.4** (resume card v2 UX refactor) and **M8.5** (LLM keyword coverage), both 2026-05-25 — commits `ea0fe7b` → `c69fcc6` + polish through `98e1daa`. Also 2026-05-25: [Close-detection probe gate](./close-detection-probe.md) across all 11 ATS kinds — fixes false-closures (LinkedIn 24h filter, Workday 200-per-crawl page cap) and recovered 921 dev + 629 prod erroneously-closed postings (`9fcd6df` → `9e29040`). **Forward motion now runs through real-world use** (apply, observe LLM rewrites, iterate prompts via the Promptfoo harness) plus the parked audit-bug list in `docs/next_steps.md`. **Deferred-by-design**: **Story S7.6** restore-from-snapshot UX, parked until the read-only safety net proves useful enough to justify a destructive path.

### Coverage by priority

| Priority | Shipped | Open | Declined | Total |
|---|---|---|---|---|
| 🔴 must-have | **20** | 0 | 0 | 20 (incl. §13 S13.1–S13.4 and story S7.3) |
| 🟡 important | **32** | 0 | 1 | 34 (S10.1 ◐ partial — resume side shipped, cover-letter side OOS; S8.4 ⛔ multi-template user-declined 2026-05-15) |
| 🔵 nice-to-have | **13** | 0 | 1 | 14 (excluding 4 future/OOS items S14.1–S14.4; story S8.7 ⛔ cover letter). Story S7.6 ◐ — capture side shipped, rollback deferred. |

### Per-track status

One row per `###` section below — this table is the doc's ToC.

| Track | Section | Status | Notes |
|---|---|---|---|
| **A** — Pipeline UX | MA — Pipeline writes + drill-in | ✅ | Kanban + drill-in + manual add + delete + inline edit + NOTE composer |
| A | MA-followup — Inline edits + document attachment + nudges | ✅ | All sub-items closed: S4.1, S4.3, S10.1 (resume side), S10.2, S11.1, S11.2; cover-letter half of S10.1 user-declined |
| **B** — Discovery | MB Phase 1 — Watchlists + crawler + in-app notifications | ✅ | careers-page + greenhouse, in-app notifications, Track/Hide |
| B | MB Phase 2a — Track→App + Lever/Ashby + closed detection | ✅ | Track→App (20), Lever + Ashby (18), closed-detection (22) |
| B | MB Phase 2b — Workday + LinkedIn + per-watchlist mode | ✅ | Workday + LinkedIn fetchers + Gmail OAuth email send + per-watchlist mode (each/digest/silent) + posting-digest daily job |
| B | MB Phase 3a — Application-side notifications | ✅ | Central dispatcher + decision-deadline nudges (27) |
| B | MB Phase 3b — Polish | ✅ | Stale (49), negative filters (23), comp parsing (24), quiet hours (28) all shipped |
| B | MB Phase 4 — Side-work pipeline | ✅ | Two-track parameterization (career + side); dedup-by-track; bulk-move (56–63) |
| **C** — Profile + resume + GitHub | M7 — Profile spine | ✅ | Profile + cards + bullet UX with lock/exclude/tags |
| C | M7.4 — Multi-resume import (append-merge) | ✅ | PDF/DOCX/TXT/JSON → LLM extract → append-merge |
| C | M7.5 — Profile snapshots | ◐ | Capture shipped (33); rollback/restore UX deferred until needed |
| C | M7.4 followups — Fuzzy dedup + extra formats | ◐ | Tag editing UI ✅; LLM fuzzy dedup, LinkedIn ZIP, legacy `.doc` 💤 |
| C | M7.6 — LLM bullet assist + resume-upload archive | ✅ | Stories S7.7 (🟡 fill) + S7.8 (🔵 rewrite) + S7.9 (🟡 archive). Shipped 2026-05-23 (`7ffd5ba`, `fffa038`). `ResumeUpload` table + `data/resume-uploads/`; `lib/profile/bullet-assist.ts` + `lib/profile/upload-archive.ts`; `MODEL_LITE` (`gemini-3.1-flash-lite`) with 20/10min rate limit. Three hermetic smokes (`archive-spans-smoke`, `bullet-assist-smoke`, `resume-uploads-smoke`). |
| C | M7.7 — Bullet tag/AI UX refactor | ⏳ | Stories S7.10 (🟡 split text rewrite from tag generation + 3-7 cap) + S7.11 (🟡 pin tags) + S7.12 (🔵 tag click no-op + bigger X). 8 tasks M7.7.1–M7.7.8. **Ships first** of the new C-track wave. New `bullet-tags-from-profile` LLM callsite on `MODEL_LITE`; narrows `bullet-assist-rewrite` to text-only; `Bullet.pinnedTags` field added to JSON shape (no Prisma migration). BulletRow refactor: split wand into two icons + pin toggle + chip-body click removed + X bumped to `w-3.5`. |
| C | M7.8 — Per-entity scratchpad: profile half | ⏳ | Story S7.13 (🟡) — first of two milestones covering this story. 6 tasks M7.8.1–M7.8.6. **Ships second.** Migration `add_entity_scratchpads` adds `scratchpad: String?` to `WorkRole`, `Project`, `Education`. New `components/overlays/ScratchpadOverlay.tsx`; entity rows get a `StickyNote` trigger button with empty/populated visual state. Bullet-assist grounding gains scratchpad as 5th source. |
| C | M8 Phase 1 — Tailored resume generation | ✅ | posting → keywords → selection → rewrite → PDF |
| C | M8 — DOCX export | ✅ | html-to-docx renderer + PDF/DOCX toggle |
| C | M8 Phase 2 — Archival + traceability + Application linkage | ✅ | `GeneratedResume` + "Why these bullets?" trace (S8.2, S8.6) |
| C | M8 Phase 2-followup | ✅ | Lock/exclude UI prominence (36) |
| C | M8 Phase 3 — Multi-template + cover letter + skills-gap | ✅ | Skills-gap (41) ✅; multi-template (37) ❌ killed; cover letter (40) ❌ killed |
| C | M8.4 — Resume card v2: UX refactor | ✅ | Stories S8.11 + S8.12 + S8.13 (🟡). Shipped 2026-05-25 (`ea0fe7b` → `c69fcc6` + polish through `98e1daa`). Migration adds `GeneratedResume.postingTitle` + `postingCompany`; new `app/api/applications/pipeline-picker/route.ts`; `GenerateResumeCard.tsx` gains Pipeline/URL/Paste segmented control (Pipeline default) + `InterestedAppPicker` + `PreviousResumesDropdown` popover. Three hermetic smokes (`pipeline-picker-smoke`, `resume-from-application-smoke`, `resume-list-smoke`). |
| C | M8.5 — Resume card v2: LLM keyword coverage | ✅ | Stories S8.9 + S8.10 (🟡). Shipped 2026-05-25 (same wave as M8.4: `ea0fe7b` → `87d81d0`). New `bullet-tags-from-posting` callsite on `MODEL_LITE`; `lib/profile/auto-tag.ts`; `docs/llm-prompts/bullet-tags-from-posting.md`; bullet JSON gains `autoTags` + `removedTags` (no Prisma migration). Fold-in rule 6a added to `resume-rewrite.md`. Four hermetic smokes (`auto-tag-smoke`, `auto-tag-merge-smoke`, `bullet-remove-tag-smoke`, `resume-rewrite-fold-in-smoke`) + Promptfoo green. |
| C | M8.6 — Resume-gen scratchpad synthesis | ⏳ | Story S7.13 (🟡) — second of two milestones covering this story. 6 tasks M8.6.1–M8.6.6. **Ships third** (depends on M7.8's `scratchpad` columns). New `scratchpad-synth` LLM callsite on `MODEL_LITE`; `lib/profile/scratchpad-synth.ts`; `docs/llm-prompts/scratchpad-synth.md`; new synthesis pass in `app/api/resumes/route.ts` POST after select + auto-tag. TraceList in `GenerateResumeCard.tsx` renders new `kind: "scratchpad-synth"` distinctly; skills-gap counts synthesized coverage. |
| C | M9 Phase 1 — GitHub-driven project metrics | ✅ | `scheduler/jobs/github-metrics.ts` refreshes `Project.metrics` for `portfolio=true` repos |
| C | M9 Phase 2 — GitHub UX polish | ✅ | Portfolio toggle UI on `ProjectRow`, suggested rewrites (45), README ingestion (46) |
| **D** — Mobile layout | MD-0 → MD-7 (incl. design Decisions + File touch estimate) | ✅ | Shipped 2026-05-23 in `893628a`. Viewport meta + `useEffectiveMobileLayout` + Dashboard fork into `DesktopShell` / `MobileShell` + swipe carousel + Launchpad sheet variant + inner-scroller `touch-pan-x` audit + Auto/Mobile/Desktop preference UI. ~450 lines, 11 files. |
| **Cross-cutting** | Route auth hardening | ✅ | 19/19 unguarded routes patched; all 24 RAH-N items closed (RAH-1/5/10/11/17–21/24 on 2026-05-16; RAH-12/13 on 2026-05-22) |
| Cross-cutting | Polish backlog (PB-N) | ✅ | PB-2/3/4/7/9/10/11/12/13 on 2026-05-16; PB-1/5/6/8/14/15 on 2026-05-17. All 15 items closed |
| Cross-cutting | Dev-server perf + stability | ✅ | Worker RSS −43 % median post-Turbopack + 9 fixes; investigation in [`docs/perf-profile.md`](./perf-profile.md) |
| Cross-cutting | LLM observability + prompt registry | ✅ | LOP-1 → LOP-11 landed 2026-05-24. Lunary tracing live on all 9 callsites via `wrapModel` + manual `trackEvent` for the SDK-bypassing email-parser. All 9 prompts uploaded to Lunary's registry via `scripts/sync-lunary-templates.ts`; runtime calls go through `lib/ai/prompts.ts:loadPrompt(slug, vars)` (Lunary-preferred, disk-fallback). Promptfoo harness at `eval/` with 9 suites + 13 starter fixtures, run via `npm run test:prompts`. LOP-9 starter fixtures are synthetic-but-realistic; real-fixture capture seam is still a TODO. |
| Cross-cutting | Close-detection probe gate | ✅ | Landed 2026-05-25 across all 11 ATS kinds — design in [`docs/close-detection-probe.md`](./close-detection-probe.md). `lib/postings/liveness.ts` (`probePostingLiveness` + `probeBatch` + per-ATS `PROBE_PROFILES`) GETs every stale candidate's `sourceUrl` and only flips to `status="closed"` on positive evidence of removal (404/410, source-specific redirect, body markers). LinkedIn 1×serial @ 1.5s, Workday 6×parallel cap 500, Greenhouse/Lever hit their public APIs. On HTTP 429 the batch aborts to avoid escalating bot-detection. Race-guarded `updateMany` re-asserts `status notIn [closed,hidden]` so a concurrent user "Hide" beats the gate. Recovery: `scripts/tests/debug/recover-false-closed.ts` reopened 921 dev + 629 prod false-closed postings. Commits `9fcd6df` `0deef8e` `2626760` `9e29040`. |
| Cross-cutting | Prompt tuning | ⏳ | Ongoing — blocked on real-user observation of resume rewrites. Now folds into §LLM observability via the live Promptfoo eval suite at `eval/suites/`; new free-text observations should land as canned fixtures + assertions rather than prose. |
| Cross-cutting | Decision log | — | Reference — Gemini model pin + DOCX converter choice |
| Cross-cutting | Smoke matrix | — | Reference — hermetic + integration + E2E coverage map |

### Story implementation map

One row per user story from [`user-stories.md`](./user-stories.md). **Phase** points at the section in this doc that ships the story; **Next action** is the concrete step for anything not yet closed. Stories S1.1–S1.4 and 9–12 predate this plan — they live in the foundational Gmail webhook / classifier / calendar-sync wiring documented in [`../CLAUDE.md`](../CLAUDE.md) (§Gmail webhook + ingest, §Auth) and have no implementation.md section of their own.

| # | Pri | Status | What | Phase | Next action |
|---|---|---|---|---|---|
| **§1 Capture from email** | | | | | |
| **S1.1** | 🔴 | ✅ | Auto-detect recruiter emails | Pre-plan (Gmail webhook + LLM classifier) | — |
| **S1.2** | 🔴 | ✅ | First-time 6-month inbox scan | Pre-plan (`POST /api/applications/backfill`) | — |
| **S1.3** | 🔴 | ✅ | Re-run scan idempotent | Pre-plan (`Application.normalizedCompany` + `WebhookDelivery` dedup) | — |
| **S1.4** | 🟡 | ✅ | Filter non-application mail pre-LLM | Pre-plan (`lib/email-parser.ts` heuristics) | — |
| **§2 Pipeline view** | | | | | |
| **S2.1** | 🔴 | ✅ | Kanban view | MA | — |
| **S2.2** | 🔴 | ✅ | Drag-to-status persists | MA | — |
| **S2.3** | 🔴 | ✅ | Manual add | MA | — |
| **S2.4** | 🔴 | ✅ | Drill-in timeline | MA | — |
| **§3 Calendar integration** | | | | | |
| **S3.1** | 🟡 | ✅ | Interview → Google Calendar | Pre-plan (`lib/calendar/sync.ts`) | — |
| **S3.2** | 🟡 | ✅ | Calendar edit flows back to MC | Pre-plan (`/api/calendar/event` webhook) | — |
| **S3.3** | 🟡 | ✅ | Link existing calendar event to app | Pre-plan (`/api/applications/events/adopt`) | — |
| **S3.4** | 🟡 | ✅ | Upcoming-events widget filter | Pre-plan (`ApplicationsView` widget) | — |
| **§4 Manual edits** | | | | | |
| **S4.1** | 🟡 | ✅ | Inline edit any field | MA-followup (MA-f.1) | — |
| **S4.2** | 🟡 | ✅ | Free-form note | MA (MA.5 composer) | — |
| **S4.3** | 🟡 | ✅ | Delete application | MA-followup (MA-f.2) | — |
| **§5 Job discovery** | | | | | |
| **S5.1** | 🔴 | ✅ | Declare watchlists | MB Phase 1 | — |
| **S5.2** | 🔴 | ✅ | Careers-page watchlists | MB Phase 1 | — |
| **S5.3** | 🟡 | ✅ | Aggregator strategies (Greenhouse/Lever/Ashby/Workday/LinkedIn) | MB Phase 1 (Greenhouse) + 2a (Lever/Ashby) + 2b (Workday/LinkedIn) | — |
| **S5.4** | 🔴 | ✅ | Deduped new-postings feed | MB Phase 1 | — |
| **S5.5** | 🟡 | ✅ | Track → draft Application | MB Phase 2a | — |
| **S5.6** | 🟡 | ✅ | Scheduled crawls + politeness | MB Phase 1 (scheduler) + 2b (LinkedIn hourly) | — |
| **S5.7** | 🟡 | ✅ | Closed-posting detection | MB Phase 2a | — |
| **S5.8** | 🔵 | ✅ | Negative filters | MB Phase 3b (MB-3.4) | — |
| **S5.9** | 🔵 | ✅ | Compensation parsing | MB Phase 3b (MB-3.4) | — |
| **§6 Notification pipeline** | | | | | |
| **S6.1** | 🔴 | ✅ | Posting → notification | MB Phase 1 | — |
| **S6.2** | 🟡 | ✅ | Per-watchlist notification mode | MB Phase 2b | — |
| **S6.3** | 🟡 | ✅ | Application-side notifications | MB Phase 3a | — |
| **S6.4** | 🔵 | ✅ | Quiet hours | MB Phase 3b (MB-3.3) | — |
| **§7 Profile / resume material** | | | | | |
| **S7.1** | 🔴 | ✅ | Structured profile | M7 | — |
| **S7.2** | 🔴 | ✅ | Import from PDF/DOCX/LinkedIn | M7.4 | — |
| **S7.3** | 🔴 | ✅ | Append-merge multi-resume | M7.4 | — |
| **S7.4** | 🟡 | ✅ | Edit any history entry | M7 | — |
| **S7.5** | 🟡 | ✅ | Tag bullets | M7.4 followups | — |
| **S7.6** | 🔵 | ◐ | Profile snapshots + rollback | M7.5 | **Rollback UI**: open snapshot row → destructive-overwrite confirm → single-transaction bulk-replace of `WorkRole` / `Project` / `Education` rows (+ bullet JSON) from the stored payload. Deferred until the read-only safety net proves useful enough to warrant a destructive path. |
| **S7.7** | 🟡 | ✅ | LLM bullet fill (empty entry → 3–5 starter bullets) | M7.6 | — |
| **S7.8** | 🔵 | ✅ | LLM bullet rewrite (existing bullet → diff + Accept/Discard) | M7.6 | — |
| **S7.9** | 🟡 | ✅ | Resume-upload archive (raw text + extracted JSON + bytes retained per import) | M7.6 | — |
| **S7.10** | 🟡 | ⏳ | Split per-bullet AI: text-only rewrite + tag-only generator + 3–7 cap | M7.7 | **Build M7.7 split + cap.** Narrow `bullet-assist-rewrite` to text-only; new `bullet-tags-from-profile` callsite on `MODEL_LITE` with `mode: 'tags'` API + 7-tag guard at the route layer. |
| **S7.11** | 🟡 | ⏳ | Pin tags so AI regenerate doesn't overwrite | M7.7 | **Build M7.7 pin.** `Bullet.pinnedTags: string[]` added to bullet JSON shape (no Prisma migration). LLM prompt receives pinned vs unpinned categorization; server-side patch-back if LLM drops a pinned tag. Invariants enforced in PATCH validator. |
| **S7.12** | 🔵 | ⏳ | Tag chip click is no-op; X-only delete; X ~1px bigger | M7.7 | **Build M7.7 click semantics.** Remove `onClick` from BulletRow tag chip body; X icon bumped from `w-3 h-3` to `w-3.5 h-3.5` + larger hit-target padding. `removeTag` semantics (clears tag + adds to `removedTags` blocklist per M8.5.6) unchanged. |
| **S7.13** | 🟡 | ⏳ | Per-entity scratchpad + resume-gen synthesis from scratchpad | M7.8 + M8.6 | **Build M7.8 then M8.6.** M7.8 adds `scratchpad: String?` to `WorkRole`/`Project`/`Education` + `ScratchpadOverlay` modal + `StickyNote` trigger button per row + bullet-assist 5th-grounding-source. M8.6 adds `scratchpad-synth` LLM callsite + synthesis pass in `app/api/resumes/route.ts` POST after select + auto-tag + trace-surface for `kind: "scratchpad-synth"` rows. |
| **§8 Tailored resume** | | | | | |
| **S8.1** | 🔴 | ✅ | Tailored generation from posting | M8 Phase 1 | — |
| **S8.2** | 🟡 | ✅ | "Why these bullets?" trace | M8 Phase 2 | — |
| **S8.3** | 🟡 | ✅ | Lock / exclude bullets | M7 (toggles) + M8 Phase 2-followup (UI prominence) | — |
| **S8.4** | 🟡 | ⛔ | Multi-template visual styles | M8 Phase 3 | **Killed 2026-05-15** — every target ATS-parses; `ats-plain.tsx` final. |
| **S8.5** | 🔴 | ✅ | PDF + DOCX export | M8 Phase 1 (PDF) + M8 — DOCX export | — |
| **S8.6** | 🟡 | ✅ | Archive per Application | M8 Phase 2 | — |
| **S8.7** | 🔵 | ⛔ | Cover letter generator | M8 Phase 3 | **Killed** — user writes cover letters by hand. |
| **S8.8** | 🔵 | ✅ | Skills gap report | M8 Phase 3 (M8-3.3) | — |
| **S8.9** | 🟡 | ✅ | LLM auto-tag pass (writes posting keywords as bullet tags where evidence exists) | M8.5 | — |
| **S8.10** | 🟡 | ✅ | Rewrite-time keyword fold-in (verbatim where natural) | M8.5 | — |
| **S8.11** | 🟡 | ✅ | Global previous-resumes dropdown on `GenerateResumeCard` | M8.4 | — |
| **S8.12** | 🟡 | ✅ | Generate against an Interested-column application (auto-attach via S8.6) | M8.4 | — |
| **S8.13** | 🟡 | ✅ | Pipeline / URL / Paste segmented input control (Pipeline default) | M8.4 | — |
| **§9 GitHub project metrics** | | | | | |
| **S9.1** | 🟡 | ✅ | Connect GitHub (public API per Decision 5) | M9 Phase 1 | — |
| **S9.2** | 🟡 | ✅ | Portfolio repos → resume bullets | M9 Phase 1 (metrics) + M9 Phase 2 (toggle UI) | — |
| **S9.3** | 🟡 | ✅ | Scheduled metrics refresh | M9 Phase 1 | — |
| **S9.4** | 🔵 | ✅ | Suggested rewrites on metric deltas | M9 Phase 2 (M9.4) | — |
| **S9.5** | 🔵 | ✅ | READMEs as source material | M9 Phase 2 (M9.5) | — |
| **§10 Application docs** | | | | | |
| **S10.1** | 🟡 | ◐ | Attach sent resume + cover letter | M8 Phase 2 (resume half) | Cover-letter half OOS — see story S8.7. |
| **S10.2** | 🔵 | ✅ | Resume diff view | MA-followup (MA-f.6) | — |
| **§11 Follow-up & nudges** | | | | | |
| **S11.1** | 🟡 | ✅ | Stale-application nudges | MA-followup (MA-f.4) + MB Phase 3b (MB-3.2 cross-ref) | — |
| **S11.2** | 🔵 | ✅ | Recruiter contacts | MA-followup (MA-f.5) | — |
| **§12 Multi-kind applications** | | | | | |
| **S12.1** | 🔵 | ✅ | Multi-kind (job / internship / college / other) | MA-followup (kind toggle) | — |
| **§13 Side-work pipeline** | | | | | |
| **S13.1** | 🔴 | ✅ | Second pipeline for gig leads | MB Phase 4 | — |
| **S13.2** | 🔴 | ✅ | Keyword-based side watchlists | MB Phase 4 | — |
| **S13.3** | 🔴 | ✅ | Separate side-track kanban | MB Phase 4 (MB-4.5 / 4.6) | — |
| **S13.4** | 🔴 | ✅ | Side new-postings feed | MB Phase 4 (MB-4.3 / 4.5) | — |
| **S13.5** | 🟡 | ✅ | Cold email defaults to career + 1-click reclassify | MB Phase 4 (MB-4.4 / 4.5) | — |
| **S13.6** | 🟡 | ✅ | Shared Calendar + Account Status across tracks | MB Phase 4 (MB-4.6) | — |
| **S13.7** | 🔵 | ✅ | Same employer allowed in both tracks | MB Phase 4 (MB-4.1 unique-by-track) | — |
| **S13.8** | 🔵 | ✅ | Bulk-move applications between tracks | MB Phase 4 (MB-4.8) | — |
| **§14 Future / out of scope** | | | | | |
| **S14.1** | 🔵 | 💤 | Browser extension "save this posting" | — | Future. Not blocking. |
| **S14.2** | 🔵 | 💤 | Auto-fill application forms | — | Future. Not blocking. |
| **S14.3** | 🔵 | 💤 | Interview prep tracker | — | Future. Not blocking. |
| **S14.4** | 🔵 | 💤 | Salary research | — | Future. Not blocking. |

**Actionable items**: three new milestone phases queued 2026-05-25 — **M7.7** (S7.10 + S7.11 + S7.12) → **M7.8** (S7.13 profile half) → **M8.6** (S7.13 resume-gen half). Beyond those, the remaining open work lives in `docs/next_steps.md` as the **10 audit-found soft bugs** parked from the 2026-05-24 audit (impact bounded, each a 5-line to ~30 min fix) and the **LOP-9 real-fixture capture** (CAPTURE_FIXTURES seam live in dev — needs ~30 min of app use + harvest into `eval/suites/`). **Story S7.6** (rollback UI for profile snapshots) remains deferred-by-design. Everything else is ✅ shipped, ⛔ user-declined, or 💤 future. Track D (mobile layout, not user-story-tied) shipped 2026-05-23.

### Open work, by leverage (next-up order)

Story S8.4 (multi-template) and Story S8.7 (cover letter) are ⛔ user-declined; not in this list. Track D (MD-0 → MD-7) shipped 2026-05-23 in `893628a`. Story S7.6 (snapshots) ◐ shipped capture-side 2026-05-22; rollback/restore-from-snapshot is parked until the safety net proves useful.

1. **M7.7 — Bullet tag/AI UX refactor** (S7.10 🟡 + S7.11 🟡 + S7.12 🔵, 8 tasks). Pure UI/UX surface plus one new `bullet-tags-from-profile` LLM callsite; no schema migration (just Bullet JSON shape evolution). Ships first because it's small, self-contained, and fixes two real UX footguns shipped with M7.6/M8.5 (combined wand-button conflates text + tags; click-to-remove tag is mis-trigger prone). See §M7.7 for the full design.
2. **M7.8 — Per-entity scratchpad: profile half** (S7.13 🟡, 6 tasks). Migration adds `scratchpad: String?` to three entity tables; new modal overlay editor; bullet-assist gets scratchpad as 5th grounding source. Immediate value via M7.6 bullet-assist paths reading user voice. See §M7.8 for the full design.
3. **M8.6 — Resume-gen scratchpad synthesis** (S7.13 🟡, 6 tasks). Ships third, depends on M7.8's schema. New `scratchpad-synth` LLM callsite + synthesis pass in resume-gen pipeline + trace-surface for synthesized bullets. The bigger payoff: synthesize fresh bullets from scratchpad text + posting keywords to close skills-gap. See §M8.6 for the full design.
4. **Audit-found soft bugs (10 parked items).** Full table in `docs/next_steps.md` §Audit-found soft bugs. Recommended order: **quick wins** (#4 email-parser model constant, #9 cache pruner startup-skip, #10 call-time `lunaryEnabled()` wrapper) → **high-value** (#2 Notification retention prune job, #5 `bulkMoveApplicationsTrack` notIn limit) → **real product calls** (#1 `nextSteps` wipe semantics, #7 resume-gen orphan row recovery) → **bigger lifts** (#3 Gmail history pagination, #6 cross-process mutex, #8 paid Gemini backfill for 4659 null employmentType rows).
5. **LOP-9 real-fixture capture.** The `CAPTURE_FIXTURES=1` seam is live on `mission-control-dev` + `mission-control-scheduler-dev` (`lib/ai/gemini.ts:chatJSON` + `lib/email-parser.ts` inline gates). Use the app ~30 min, then grep pm2 logs for `[FIXTURE]` lines and translate captures into `eval/suites/<name>.yaml` entries — replaces the synthetic-but-realistic seeds from LOP-9 landing.
6. **Story S7.6 — rollback/restore UX (🔵).** Capture side ✅ via `ProfileSnapshot`. "Restore from snapshot" needs a destructive-overwrite confirm + transactional bulk-replace of `WorkRole` / `Project` / `Education` (+ bullet json) from the stored payload. Deferred-by-design — wait until you've actually made an edit you want to undo.
7. **Manual visual smoke + Lunary trace check.** Verify GenerateResumeCard golden path (Pipeline tab default → pick INTERESTED-with-URL app → generate → resume appears under app's Resumes section + in previous-resumes dropdown without refresh) and confirm any LLM run in dev shows up in Lunary's dashboard tagged by `name`. Backend pipe is verified end-to-end by hermetic smokes; this is the visual confirmation gap.

### User-declined

- **Story S8.7** ⛔ Cover-letter generator. User writes cover letters by hand. By extension, the cover-letter half of story S10.1 is also out-of-scope; the resume half ships via `GeneratedResume.applicationId`.

### Future / OOS

- Stories S14.1–S14.4 (browser extension, app-form auto-fill, interview prep tracker, salary research). Not blocking.

---

## Track A — Pipeline UX & manual edits

### MA — Pipeline writes + drill-in ✅

Stories: S2.1, S2.2, S2.3, S2.4 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/applications-api-smoke.ts` (10/10 green) · Commit: `7986aed`.

Already-implemented work surfaced during review: full Kanban writes (drag-to-status with optimistic rollback), manual add modal, drill-in timeline overlay, note composer, applications API CRUD + events. PATCH on status auto-emits a `STATUS_CHANGED` event with correct `fromStatus`/`toStatus`.

Files (load-bearing): `app/api/applications/route.ts`, `app/api/applications/events/route.ts`, `components/views/ApplicationsView.tsx`, `components/overlays/AddApplicationModal.tsx`, `components/overlays/ApplicationDetailOverlay.tsx`.

### MA-followup — Inline edits + document attachment + nudges ✅

Stories: S4.1, S4.2, S4.3, S10.1, S10.2 (🟡) · S11.1, S11.2 (🟡).

- **MA-f.1** ✅ — Inline-edit of company/role/nextSteps on the detail overlay (story S4.1). `EditingField` state in `ApplicationDetailOverlay.tsx:37`.
- **MA-f.2** ✅ — Delete confirmation UI (story S4.3). `Trash2` button + `window.confirm` at line 218 of the overlay.
- **MA-f.3** ◐ — Document attachment (story S10.1 resume side). `GeneratedResume.applicationId` link is wired (M8 Phase 2). Diff between two sent versions (story S10.2) still open 🔵.
- **MA-f.4** ✅ — Follow-up nudges (story S11.1). `scheduler/jobs/stale-applications.ts` fires daily, finds apps with `lastUpdateAt < now - STALE_AFTER_DAYS`, emits `Notification(kind='application', payload.type='stale-nudge')` dedup'd against active prior nudges. `scripts/tests/hermetic/stale-nudge-smoke.ts` covers it.

**MA-f.6** ✅ — Resume-version diff (story S10.2). Shipped 2026-05-22. Pure read-side, no schema changes. `lib/resumes/diff.ts:computeResumeDiff(a, b)` compares two `GeneratedResume` rows along three axes — posting `parsedKeywords`, `selections` (set-diffed by `bulletId` so the same bullet appearing in both surfaces rewrite-text deltas), and `skillsGap`. Order is preserved from the A side so the UI can render keywords in their original posting order. `/api/resumes/diff?a=&b=` parses both rows in one Prisma round-trip, ownership-checks via `userId in where`, hydrates with tolerant per-field validators (legacy rows with missing fields default to empty arrays rather than 500ing the diff). UI lives in `ApplicationDetailOverlay.tsx:ApplicationResumesSection` — when ≥2 resumes are present, each row gets a checkbox; selecting 2 (FIFO past 2) enables a "Compare selected" button that reveals an inline `ResumeDiffPanel` showing summary stats + keyword chips (rose=only A, emerald=only B) + bullets-only-in-A / bullets-only-in-B / shared-but-rewritten-differently buckets. Hermetic: `scripts/tests/hermetic/resume-diff-smoke.ts` (31/31) covers identical-resume zero-deltas, A-order preservation, bullet set-diff, rewrite-changed + scoreDelta, per-bullet matchedKeywords/Tags deltas, skills-gap deltas.

**MA-f.5** ✅ — Recruiter contacts (story S11.2). Shipped 2026-05-22. New `Contact` Prisma model (id, applicationId, name, email?, role?, notes?, lastTouchedAt?, position) with cascade-on-application-delete; migration `add_application_contacts` applied to both dev.db and prod.db. `lib/repositories/contacts.ts` exposes CRUD with parent-application ownership scoping + `primaryContactForApplication(applicationId)` that orders by `lastTouchedAt desc nulls last → position asc → createdAt asc`. `/api/applications/contacts` route handles GET/POST/PATCH/DELETE under `requireSession`. UI: expandable "Contacts" footer on `ApplicationDetailOverlay` (sits between Timeline and Resumes) with inline add-form + per-row Touch button (bumps lastTouchedAt to now) + Trash. `scheduler/jobs/stale-applications.ts` now consults `primaryContactForApplication` and reshapes the nudge body — "Consider drafting a follow-up to <FirstName>" when a contact exists, falling back to the generic body otherwise. Hermetic: `scripts/tests/hermetic/contacts-smoke.ts` (25/25) covers CRUD + cross-user rejection + primary-contact ordering + cascade-on-application-delete.

---

## Track B — Job discovery + notifications

### MB Phase 1 — Watchlists + crawler + in-app notifications ✅

Stories: S5.1, S5.2, S5.4, S6.1 (🔴) — minimum viable "hunt on my behalf" loop.

**Scope IN:**
- Two source types: `careers-page` (HTML scrape + link pattern) **and** `greenhouse` (boards-api.greenhouse.io JSON). Greenhouse pulled forward from Phase 2 after discovering that most modern careers pages are SPAs that don't expose postings in initial HTML. Anthropic, Stripe, Rocket Lab, Vercel, and many more publish their boards via Greenhouse — covers the bulk of real-world targets without needing headless rendering.
- In-app notifications only.
- Manual + auto crawl (user "Run now" button + scheduler every 10 min).
- "Track" / "Hide" actions that move a posting between `status='new'|'tracked'|'hidden'`. No Application creation yet — that ships in MB Phase 2 with the rest of story S5.5.
- First-crawl notification digest: when a brand-new watchlist returns more than 20 postings on its first run, we still store every posting but emit a single `kind='system'` summary notification instead of one-per-posting. Subsequent runs always emit per-posting notifications for the (typically small) delta.

**Scope OUT** (deferred to MB Phase 2+):
- Lever, Ashby, Workday aggregator strategies
- LinkedIn (rate-sensitive, separate)
- "Track → draft Application" linkage
- Email delivery
- Closed-posting detection + UI
- Per-watchlist notification mode
- Compensation parsing, negative filters, quiet hours

#### MB.1 — Schema

Three new Prisma models. Migration name `add_watchlists_postings_notifications`.

```prisma
model Watchlist {
  id              String   @id @default(cuid())
  userId          String
  name            String
  kind            String           // "careers-page" (only value for Phase 1)
  config          String           // JSON: { rootUrl, linkPattern, companyName, location? }
  scheduleMinutes Int      @default(30)
  lastRunAt       DateTime?
  lastSuccessAt   DateTime?
  lastError       String?
  active          Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  user     User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  postings JobPosting[]
  @@index([userId, active])
}

model JobPosting {
  id           String   @id @default(cuid())
  watchlistId  String
  externalId   String   // sha256(company + title + sourceUrl) — stable dedup key
  company      String
  title        String
  location     String?
  postedAt     DateTime?
  snippet      String?
  sourceUrl    String
  status       String   // "new" | "tracked" | "hidden" | "closed"
  firstSeenAt  DateTime @default(now())
  lastSeenAt   DateTime @default(now())
  removedAt    DateTime?
  raw          String   // JSON of raw extracted fields, for debugging
  watchlist Watchlist @relation(fields: [watchlistId], references: [id], onDelete: Cascade)
  @@unique([watchlistId, externalId])
  @@index([status, lastSeenAt])
}

model Notification {
  id           String   @id @default(cuid())
  userId       String
  kind         String   // "posting" | "application" | "system"
  title        String
  body         String?
  payload      String   // JSON: { postingId? / applicationId? / ... }
  channels     String   @default("in_app")
  createdAt    DateTime @default(now())
  readAt       DateTime?
  dismissedAt  DateTime?
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, createdAt])
  @@index([userId, readAt])
}
```

Also adds `watchlists` and `notifications` relations to `User`.

Zod schemas: `lib/schemas/watchlists.ts`, `lib/schemas/notifications.ts`.

#### MB.2 — Careers-page fetcher

`lib/fetchers/careers-page-fetcher.ts`. Input config shape:
```ts
{ rootUrl: string; linkPattern: string; companyName: string; location?: string }
```
- Polite GET with `User-Agent: mission-control-watcher/1.0`, 5s timeout, cheerio parse.
- Extract every `<a>` whose `href` matches `linkPattern` (after resolution against `rootUrl`).
- Build `RawPosting[]` of `{ company, title, sourceUrl, snippet? }`. Title = link text (trimmed/dedup'd whitespace).
- Errors return `{ ok: false, error }` instead of throwing — caller logs `lastError` on the watchlist.

#### MB.3 — Scheduler job

`scheduler/jobs/job-watcher.ts` exports `runJobWatcher()`. Registered in `scheduler/index.ts` at 10-minute interval.

Per tick:
1. Query active watchlists where `lastRunAt IS NULL OR lastRunAt < now - scheduleMinutes`.
2. For each watchlist, call the fetcher.
3. For each `RawPosting`: compute `externalId = sha256(company + '|' + title + '|' + sourceUrl)` (decided 2026-05-15 — picked over `sha256(sourceUrl)` alone because some careers pages decorate URLs with tracking params that would defeat URL-only dedup) → upsert into `JobPosting`. If row didn't exist → status `'new'` + insert `Notification(kind='posting')`. If row existed → bump `lastSeenAt` (do nothing else).
4. Update watchlist `lastRunAt`, `lastSuccessAt` (on success), or `lastError` (on fail).
5. Broadcast `Posting` + `Notification` SSE events for everything that changed.

Closed-posting detection (story S5.7) deferred to MB Phase 2.

#### MB.4 — API routes

All session-gated; SSE broadcasts on write.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/watchlists` | GET, POST | list + create |
| `/api/watchlists/[id]` | PATCH, DELETE | edit / pause / delete |
| `/api/watchlists/[id]/run` | POST | trigger immediate crawl (calls into the scheduler job for one watchlist) |
| `/api/postings` | GET | feed; filters `?status=new&watchlistId=...&limit=50` |
| `/api/postings/[id]` | PATCH | set status (`tracked` / `hidden`) |
| `/api/notifications` | GET | list; filters `?unread=true` |
| `/api/notifications` | PATCH | mark-read by id list, or `markAllRead: true` |

`lib/api-client.ts` gets `api.watchlists.*`, `api.postings.*`, `api.notifications.*`. `hooks/useServerEvents.ts` extended with `'Watchlist'` / `'Posting'` / `'Notification'` channels.

#### MB.5 — Watchlists + postings UI (inside Applications dash)

**Decided 2026-05-15: option (b)** — no new top-level dash. Two new sections appended to `ApplicationsView.tsx` after the Kanban:

- **Watchlists** card — list with last-run timestamp + last-error chip, per-row actions: Pause toggle, Run now, Edit, Delete. "Add watchlist" modal: name + URL + linkPattern + companyName + scheduleMinutes.
- **New postings** card — list filtered to `status='new'`, each: company / title / location / `Track` / `Hide` / link to source. Hides as soon as status leaves `'new'`.

Notifications surface: inline within the Watchlists card for Phase 1 (recent posting-notifications shown in their own pane). A proper global notification bell is a Phase 3 concern.

#### MB.6 — End-to-end smoke

**Decided 2026-05-15: real URL** (option a). Smoke targets `https://www.rocketlabusa.com/careers/` (listed in story S5.2). Smoke is intentionally flakier than the others — if Rocket Lab restructures their page, this fails and the linkPattern needs updating. Acceptable trade-off; the user picked it.

`scripts/tests/integration/watchlist-e2e-smoke.ts`:
1. Forge a NextAuth session.
2. POST a watchlist with `rootUrl: https://www.rocketlabusa.com/careers/`, a permissive `linkPattern` matching job-detail hrefs, `companyName: 'Rocket Lab'`.
3. Call `POST /api/watchlists/[id]/run`.
4. Assert: ≥ 1 `JobPosting` row created with `status='new'`, ≥ 1 `Notification` row created.
5. Re-run the same trigger → no new postings, no new notifications (dedupe verified — `externalId` collision on second pass).
6. PATCH one posting to `status='tracked'`; verify it falls out of the `new` feed.
7. PATCH all notifications `markAllRead: true`; GET `?unread=true` → 0.
8. Cleanup: delete postings, watchlist, notifications; tear down session.

If Rocket Lab's careers page is unreachable from the test environment (offline, region-blocked, etc.), skip with a clear message; do not fail.

#### MB Phase 1 acceptance

- Create a watchlist for a real careers page in the UI; within one scheduler tick, ≥ 1 posting appears in the feed.
- Re-running the crawl doesn't duplicate.
- Notification fires on first-seen postings.
- Hide / Track move postings out of the "new" feed.

### MB Phase 2a — Track→App + Lever/Ashby + closed detection ✅

Stories: S5.3 (Lever/Ashby), S5.5 (Track→App), S5.7 (closed detection) — 🟡.
Shipped 2026-05-15. Smoke: `scripts/tests/integration/watchlist-phase2-smoke.ts` (10/10 green).

- **MB-2.3 Track→App** — new `POST /api/postings/[id]/track-as-application` creates `Application(status='INTERESTED', kind='job', postingId, role=posting.title)` in a single Prisma transaction and flips `posting.status='tracked'`. Idempotent on re-call (returns the existing Application + `created:false`). UI: "Track as App" button on NewPostingsCard. ApplicationDetailOverlay shows a "Tracked from: <sourceUrl>" line with a "Closed" badge if the underlying posting transitions to closed. Schema: `INTERESTED` added to `APPLICATION_STATUSES` (placed first so kanban order reads interest → applied → ...); `Application.postingId String? @unique` with `onDelete: SetNull` to JobPosting. Migration `add_interested_status_and_posting_link`.
- **MB-2.1 (partial) Lever + Ashby fetchers** — `lib/fetchers/lever-fetcher.ts` (api.lever.co/v0/postings/<slug>) and `lib/fetchers/ashby-fetcher.ts` (api.ashbyhq.com/posting-api/job-board/<slug>). WATCHLIST_KINDS expanded to `["careers-page", "greenhouse", "lever", "ashby"]`. AddWatchlistModal kind picker shows all four with per-kind help text.
- **MB-2.4 Closed-posting detection** — at the end of each scheduler tick (skipped on first run), any non-terminal JobPosting whose `externalId` wasn't in the current fetch set AND whose `lastSeenAt < runAt - 6h` is a candidate for closure. **As of 2026-05-25 the close path is probe-gated** ([`docs/close-detection-probe.md`](./close-detection-probe.md)) — before flipping a candidate to `status='closed'`, `lib/postings/liveness.ts:probeBatch` GETs its `sourceUrl` per a per-ATS profile (LinkedIn 1×serial with 1.5 s anti-bot delay, Workday 6×parallel cap 500, Greenhouse/Lever via their public APIs, etc.). Only candidates that probe `"closed"` get flipped; `"alive"` results bump `lastSeenAt` to runAt (the chronically-not-in-fetch-list-but-still-live case — LinkedIn 24h filter, Workday past page 10), `"unknown"` results (5xx / timeout / network glitch) leave the row alone for the next tick to retry. The 6h grace + the probe combine into: "missing AND silent for ≥ 6h AND positively confirmed gone." One `Notification(kind='system')` per watchlist summarizing confirmed closures. `RunResult.closed` + new `RunResult.refreshedAlive` counts exposed via `/api/watchlists/[id]/run`. `scripts/tests/debug/recover-false-closed.ts` retroactively un-closes the false-close backlog (dry-run by default, `--apply` mutates).

### MB Phase 2b — Workday + LinkedIn + per-watchlist mode ✅

Stories: S5.3 (Workday), S5.6 (LinkedIn), S6.2 (per-watchlist mode) (🟡) · Decision 2 (email — now resolved via OQ1).

- ✅ **Workday** (shipped 2026-05-15): `lib/fetchers/workday-fetcher.ts`. POST to `<tenantHost>/wday/cxs/<tenantSlug>/<careerSite>/jobs` with paginated `{appliedFacets, limit, offset, searchText}`. **Server caps `limit` at 20** (found empirically; values ≥ 25 return HTTP 400); the fetcher uses PAGE_SIZE=20 + MAX_PAGES=10 = up to 200 postings per crawl. **Total field is only populated on the first page** (offset=0); subsequent pages return `total: 0`, so the "stop when reached total" check is gated on `page === 0`. Real-browser UA required (Cloudflare in front of myworkdayjobs.com rejects bot UAs with HTTP 400). Verified live against Boeing (1,177 jobs, 200 fetched in 8s) and Blue Origin (957 jobs).
- ✅ **LinkedIn** (shipped 2026-05-15): `lib/fetchers/linkedin-fetcher.ts`. GET against the public guest endpoint `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=X&location=Y&start=N`. Returns HTML chunks; parsed with cheerio via `.base-search-card` selectors. Strips tracking params from `href` so dedup works. Cap PAGE_SIZE=25 × MAX_PAGES=2 = 50 postings/crawl + `f_TPR=r86400` (last 24h) filter to keep volume sane. **Fragile by design** — LinkedIn DOM-shifts often; the comment in the file flags the breakage path. Hourly cadence recommended. Verified live: 10 postings returned for "software engineer / Remote".
- ✅ **Email delivery** (shipped 2026-05-15 via OQ1): Gmail OAuth send through `lib/email/send.ts`, dispatched via `lib/notifications/dispatch.ts` at `tier='critical'`. See "Track A — Notification dispatcher" / OQ1 below.
- ✅ **Per-watchlist `each`/`digest`/`silent` mode** (story S6.2): `Watchlist.notificationMode` column shipped with the MB Phase 2b batch; `each` fires per-posting in real time, `digest` batches into the daily `posting-digest` scheduler job, `silent` skips delivery (postings still land in the DB so they show in the postings feed when the user opens the dash).

### MB Phase 3a — Application-side notifications ✅

Story S6.3 (🟡). Shipped 2026-05-15.

New helper `maybeNotifyForApplicationEvent(event, userId, companyHint?)` in `lib/repositories/applicationEvents.ts`. Emits a `Notification(kind='application', payload={applicationId, eventId, eventKind})` when an `ApplicationEvent` of kind `INTERVIEW_SCHEDULED` / `OFFER` / `REJECTION` / `ASSESSMENT_REQUESTED` is created. Skips the noisy/self-initiated kinds (APPLIED, STATUS_CHANGED, EMAIL_RECEIVED, NOTE). Wired into both create paths:

- `lib/applications/ingest.ts` (Gmail webhook + classifier funnel) — fires after `createApplicationEvents` for every inserted event, passing the parsed company name as the hint.
- `app/api/applications/events/route.ts POST` (manual create from the detail overlay) — fires after the row creates, with the joined `application.company` as the hint. Also broadcasts `Notification` SSE since the create runs in-process.

Best-effort: notification failures log to `console.warn` and don't fail the caller's create.

### MB Phase 3b — Polish ✅

Stories: S6.4 (🔵), S5.8 (🔵), S5.9 (🔵).

#### MB-3.2 — Stale-application nudges ✅

Story S11.1. Shipped as `scheduler/jobs/stale-applications.ts` (see MA-f.4).

#### MB-3.3 — Quiet hours (story S6.4) ✅

Shipped 2026-05-22. `GlobalSetting.quietHoursStart`, `quietHoursEnd`, `quietHoursTimezone` — all nullable; quiet hours are off until both Start and End are populated. Migration `add_quiet_hours`. `lib/notifications/quiet-hours.ts:isInQuietHours(now, config)` resolves `now` into the configured IANA zone via `Intl.DateTimeFormat` (DST handled by the host's zoneinfo) and tests against the window. Same-day windows are `[start, end)`; wrap-around windows (`22:00 → 08:00`) are `[start, 24:00) ∪ [00:00, end)`. `dispatchNotification` strips `email` from non-critical dispatches whose timestamp lands inside the window — the row still creates so the bell shows it, but no Gmail send fires. Critical tier (`tier === "critical"` — OFFER / INTERVIEW_SCHEDULED / etc.) bypasses entirely; the user has explicitly opted into 3 a.m. interruptions for those. Hermetic `quiet-hours-smoke.ts` (20/20) covers null-config disablement, invalid HH:MM/timezone degradation, same-day, wrap-around, zero-length window, and a non-UTC tz (`America/Los_Angeles`).

#### MB-3.4 — Negative filters ✅ / compensation parsing ✅

- ✅ **Negative filters** (story S5.8, shipped `9da9a2d`): per-watchlist `Watchlist.negativeFilters` JSON regex array. `/api/postings` GET applies case-insensitive matching against `title\nsnippet\nlocation`. `?includeFiltered=true` bypass for debug. UI: expandable editor on `WatchlistsCard` with regex validation + count chip. Hermetic smoke at `scripts/tests/hermetic/negative-filters-smoke.ts` (18/18).
- **Compensation** (story S5.9, shipped 2026-05-22): `lib/postings/compensation.ts:parseCompensation` regex over `(title + snippet + location)` → `compensationMin/Max/Currency/Cadence` columns on `JobPosting`. Migration `add_posting_compensation`. Wired into `scheduler/jobs/job-watcher.ts` at row-create time (legacy rows stay null until next crawl re-extracts). Cadence detection covers `/hr`, `per day/week/month/year`, `annually` / `annual` / `yearly` / `p.a.` (slash patterns rewritten to drop the leading `\b` since spaces before `/` aren't word boundaries). Plausibility guards reject "5,000 employees" / "$1 / hour" garbage. UI: emerald chip on `NewPostingsCard` rows formatted as `$120k–$150k/yr` (or `$60/hr` for hourly). Hermetic `compensation-smoke.ts` (18/18) covers the matrix.

---

### MB Phase 4 — Side-work pipeline ✅

Stories: S13.1, S13.2, S13.3, S13.4 (🔴) · 60, 61 (🟡) · 62, 63 (🔵 — single-row flip ships, bulk-select still open) · Shipped 2026-05-22.

Why: user is working as a security guard at Crypto Arena while career-hunting and wanted a second pipeline for pay-the-bills gigs so leads don't dilute the career kanban (or vice-versa). Touches both Track A (kanban, ingest, applications API) and Track B (watchlists, postings, scheduler) — filed under B because the bulk of the new wiring is discovery-side. Schema-thin: one new `Watchlist.track` column, one new `Application.track` column, one expanded `@@unique([userId, normalizedCompany, track])` constraint. UI duplicates three cards parameterized by a `track` prop.

Note on naming: the natural name "kind" was already taken on both `Watchlist` (ATS-type discriminator: greenhouse/lever/linkedin/...) and `Application` (pursuit-type: job/internship/college/other), so the new dimension is `track` instead. The two concepts are orthogonal — a side-track `internship` is conceptually fine, as is a career-track `job`.

- **MB-4.1 — Schema migration** ✅. Migration `add_side_track` (applied to dev.db + prod.db on 2026-05-22). Adds `Watchlist.track String @default("career")` with `@@index([userId, track, active])`; adds `Application.track String @default("career")` with `@@index([userId, track])`; replaces `@@unique([userId, normalizedCompany])` with `@@unique([userId, normalizedCompany, track])` so the same employer can coexist as both a career and side application (story S13.7). Existing 37 watchlists + 37 applications defaulted to `track="career"` on migrate — no backfill needed.
- **MB-4.2 — Watchlist API + scheduler audit** ✅. `lib/schemas/watchlists.ts` adds `WatchlistTrackSchema` + threads `track` through `WatchlistPostSchema` / `WatchlistPatchSchema` / `WatchlistSchema`. `app/api/watchlists/route.ts` GET accepts `?track=career|side` (omitted = all); POST defaults `track="career"`. PATCH on `[id]/route.ts` allows track edits (story S13.8 single-row flip). **Scheduler unchanged**: `runDueWatchlists()` at `scheduler/jobs/job-watcher.ts:362` filters only by `{active: true}` — both tracks share the same fetcher fleet, so no crawl-loop branching.
- **MB-4.3 — Postings API** ✅. `app/api/postings/route.ts` GET accepts `?track=` and joins via `watchlist: { userId, track }` so each track's `NewPostingsCard` gets its own postings feed. `PostingsListFilter` in `lib/api-client.ts` gains `track?` for query-key partitioning.
- **MB-4.4 — Applications API + ingest dedup** ✅. `lib/schemas/applications.ts` adds `ApplicationTrackSchema` + threads through Post/Patch/list schemas. `lib/repositories/applications.ts` `findApplicationByCompany(userId, company, track)` and `findApplicationBySenderDomain(userId, senderDomain, track)` now scope by track so the same employer-name in opposite tracks doesn't false-dedup. `lib/applications/ingest.ts` hard-codes `ingestTrack = "career"` per story S13.5 — cold Gmail emails always land on career and the user reclassifies via the inline toggle. `lib/postings/track-as-application.ts` inherits track from the parent watchlist so a side-watchlist posting becomes a side application automatically. All 4 hermetic dedup smokes (`app-race-dedup-smoke`, `find-app-by-company-smoke`, `sender-domain-smoke`, `ingest-retry-smoke`) updated to pass `"career"` and stay green.
- **MB-4.8 — Bulk track move (story S13.8)** ✅. Shipped 2026-05-22. Adds a `CheckSquare` button to the kanban card header that flips the card into "select mode" — checkboxes appear on each card, taps toggle selection (and stop opening the detail overlay), drag-to-status is suppressed (the same gesture can't simultaneously toggle a checkbox AND start a drag). A footer bar shows `N selected · Move to <other-track> · Cancel`. The bulk action calls `POST /api/applications/bulk-track` with `{ ids, track }`. The route wraps `bulkMoveApplicationsTrack(userId, ids, targetTrack)` from `lib/repositories/applications.ts`, which runs the whole move inside a single Prisma `$transaction`: pre-fetches the rows ownership-scoped by userId (cross-user ids silently drop), checks for same-employer-both-tracks conflicts via a second SELECT against `@@unique([userId, normalizedCompany, track])`, and either runs `updateMany` or returns the conflict list (no partial state). Conflicts come back as HTTP 409 with `{ error: "conflict", conflicts: [...] }`; the UI surfaces them as a toast listing the colliding company names so the user can resolve manually before retrying. Hermetic: `scripts/tests/hermetic/bulk-track-smoke.ts` (17/17) covers happy-path, idempotent re-move, cross-user drop, conflict pre-check, null-normalizedCompany non-conflict, and mixed (some moveable + some already-on-target) batches.
- **MB-4.5 — Card parameterization** ✅. `ApplicationsKanbanCard`, `WatchlistsCard`, `NewPostingsCard`, `AddApplicationModal`, `AddWatchlistModal` each take a new `track?: "career" | "side"` prop (default `"career"` for backward compat). Per-track `TRACK_PRESETS` swap title / icon / accent color / empty-state copy. Side cards use Briefcase icon + amber accents; career stays on existing Mail/Eye/Newspaper + cyan/blue. The 8 kanban status columns are reused as-is. `ApplicationDetailOverlay` gains a Track toggle row beneath Kind for single-click reclassification (story S13.8 single-row case).
- **MB-4.6 — ApplicationsView wiring** ✅. Two new `<Section>`s appended below `Job Discovery`: "Side Pipeline" (kanban only — calendar + account status are shared above per story S13.6) and "Side Discovery" (watchlists + new postings). Second `useQuery` keyed `['applications', 'side']` for the side kanban. Second `AddApplicationModal` instance with `defaultTrack="side"`. `invalidateApps` switched to a predicate match (`q.queryKey[0] === 'applications'`) so a single Application SSE event refreshes both kanbans — necessary because a track-flip on a row removes it from one cache and inserts into the other. Optimistic status-change handler detects which cache holds the dragged row and patches the matching one.
- **MB-4.7 — Smoke** ✅. All 33 hermetic suites pass with the new track-aware signatures. Pre-existing `applications-api-smoke.ts` (integration) covers POST/PATCH/DELETE; the track field flows through trivially since the API just passes it to the repository. No new hermetic file added — the dedup-by-track behavior is exercised end-to-end by the manual UI check (create same employer in both tracks; both succeed instead of P2002).

Why MB Phase 4 instead of a new Track D: this is an additive parameterization of existing Track A + B surfaces, not a new track of work. Filing it under MB keeps the cross-track-status-table on this doc readable.

---

## Track C — Profile + resume + GitHub

### M7 — Profile spine ✅

Stories: S7.1, S7.4, S7.5 (partial) (🔴/🟡) · Shipped 2026-05-14 · Commits: `0367263`, `e41b6c0` · Smokes: `scripts/tests/hermetic/profile-repo-smoke.ts` (19/19), `scripts/tests/integration/profile-api-smoke.ts` (17/17 + 9 SSE).

Schema: `Profile`, `WorkRole`, `Project`, `Education` with JSON `bullets` arrays. CRUD API + ProfileView dash + cards (Header / WorkRole / Project / Education / Bullet rows with lock/exclude toggles).

### M7.4 — Multi-resume import (append-merge) ✅

Stories: S7.2, S7.3 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/profile-import-smoke.ts` (PDF + DOCX → 1 work role created, 3 bullets deduped, 5 added, ~14s) · Commit: `329d765`.

Pipeline: `lib/profile/extract.ts` (PDF via pdf-parse v2, DOCX via mammoth, TXT/MD/JSON inline) → `lib/profile/import-llm.ts` (Gemini structured-output extraction) → `lib/profile/merge.ts` (deterministic dedup + append-merge against existing profile). Append-to-repository semantics enforced — no overwrite. `next.config.ts` carries `pdf-parse / mammoth / puppeteer-core / html-to-docx` in `serverExternalPackages`.

### M7.5 — Profile snapshots ◐ (capture shipped, rollback deferred)

Story S7.6 (🔵). Shipped 2026-05-22. Smoke: `scripts/tests/hermetic/profile-snapshots-smoke.ts` (17/17). Migration: `20260523024735_add_profile_snapshots`.

New `ProfileSnapshot` Prisma model — `(id, userId, takenAt, label?, payload, createdAt)` — captures the full hydrated `Profile` (header + workRoles + projects + education with parsed bullets) as a JSON string. Button-press only — there is **no** auto-snapshot on profile edits (would balloon row count and add a hidden write path the user can't see).

- `lib/repositories/profile-snapshots.ts` — `createProfileSnapshot`, `listProfileSnapshots` (summary projection, ordered newest-first), `getProfileSnapshot` (returns null on corrupt JSON rather than throwing), `deleteProfileSnapshot`. Owner check on every read/delete.
- API: `app/api/profile/snapshots/route.ts` (GET list, POST create) + `app/api/profile/snapshots/[id]/route.ts` (GET full payload, DELETE). All session-gated via `requireSession`.
- `lib/api-client.ts` — `api.profile.snapshots.{list, get, create, delete}` + new `queryKeys.profileSnapshots` / `queryKeys.profileSnapshot(id)`.
- `lib/events.ts` + `hooks/useServerEvents.ts` — `'ProfileSnapshot'` added to the `ModelName` / `ServerEventModel` unions so cross-tab create + delete invalidate the snapshot list.
- UI: `components/cards/ProfileSnapshotsCard.tsx` mounted in a new "History" section on `ProfileView`. Label input (optional, 120 char cap) + "Snapshot now" button + list with delete-per-row.

**Rollback is intentionally not wired yet.** First deliverable is just a read-only safety net so the user can see how their profile looked at past points in time. When/if they actually want to roll back, the path is: open snapshot row → confirm destructive overwrite → transactional bulk-replace of `WorkRole` / `Project` / `Education` rows from the stored payload. The destructive nature is the reason it's deferred — building a half-tested restore path before there's clear demand is more dangerous than the safety net it's meant to provide.

### M7.4 followups — Fuzzy dedup + extra formats 💤 / partial ✅

- ✅ **M7.4-f.4 — Tag editing UI** (story S7.5). Shipped 2026-05-15. BulletRow now renders each tag as a click-to-remove chip and has an inline "+ tag" affordance. Tags persist via the existing bullet PATCH path (the bullet shape already had `tags: string[]`). Autocomplete from other tags in the profile deferred — current entry experience is fine and autocomplete needs the parent component to thread `allTags` down.
- 💤 **M7.4-f.1 — LLM fuzzy bullet dedup**: current dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity, batched per role to keep token cost down. Deferred because the cost-vs-value of an extra Gemini call per import isn't obvious yet; tag-editing UI lets the user fix this manually.
- 💤 **M7.4-f.2 — LinkedIn export ZIP**: unzip → read `Positions.csv` / `Education.csv` / `Projects.csv` → run through the same merge layer. No LLM needed. Deferred — currently uploading the PDF version of a resume covers the same data.
- 💤 **M7.4-f.3 — Legacy `.doc`**: mammoth handles `.docx` only. Either skip `.doc` with a clearer error or wire a converter (libreoffice CLI? `textract`?). Defer — niche format these days.

### M7.6 — LLM bullet assist + resume-upload archive ✅

Stories: **S7.7** (🟡 fill empty entries) + **S7.8** (🔵 rewrite existing bullets) + **S7.9** (🟡 resume-upload archive as grounding). Shipped 2026-05-23 in commits `7ffd5ba` (initial 11-task wave) + `fffa038` (rewrite-tag enhancement). All 11 sub-tasks below landed; design content preserved as historical reference for the implementation.

S7.9 is the load-bearing primitive: today's M7.4 import path extracts → merges → discards. That discard is lossy — wording variants and details that lose the dedup race vanish forever. M7.6 closes the discard (raw text + extracted JSON + original bytes persisted) and exposes the archive as a retrieval surface that S7.7 and S7.8 query alongside the live profile. Ship order is **archive first** (M7.6.1–M7.6.4) → **prompt + route** (M7.6.5–M7.6.7) → **UI** (M7.6.8–M7.6.9) → **smoke + telemetry** (M7.6.10–M7.6.11). Each numbered task is a discrete shippable chunk.

**Model**: `MODEL_LITE` (`gemini-3.1-flash-lite`). User-direction was "3.1" — the non-lite `gemini-3.1-flash` SKU doesn't exist (Google only ships the `-lite` variant at the 3.1 tier; 404 on first live call 2026-05-24). Distinct from the `MODEL_FLASH` (`gemini-3.5-flash`) used by the resume-rewrite path — bullet-assist tolerates lower quality because the user vets every output (Accept/Discard on rewrite, edit-before-save on fill).

**Grounding surface for both modes**:
1. Entry spine — `company` / `title` / `location` / `startDate`–`endDate` (or `name` / `description` for Project, `institution` / `degree` for Education).
2. Sibling bullets in the same profile with tag overlap — picks up the user's voice and vocabulary.
3. **Archive spans (S7.9)** — up to 3 spans from `ResumeUpload.rawText` rows where the parent's `company` / `name` / `institution` appears case-insensitively. Ranked by upload recency. ±500 chars around the first match per upload.
4. Project README excerpt — reuses the existing `ProjectReadmeContext` builder from M9 Phase 2 / S9.5; 2 KB cap per project.

**Two modes behind one API**:
- **Fill** (`mode: 'fill'`) — entry has zero bullets. Returns 3–5 starter bullets in the standard `{id, text, tags[], locked: false, excluded: false}` shape. New cuids generated server-side.
- **Rewrite** (`mode: 'rewrite'`) — user picks one existing bullet. Returns a single proposal — same `id`, same `locked` / `excluded`; both `text` AND `tags` change. The LLM is instructed to update tags reflecting the new wording (the rewrite often shifts which skills / themes the bullet emphasizes; tags should follow). The UI's diff panel surfaces both the text diff AND the tag diff (removed in rose line-through, added in emerald), so the user can see exactly what's changing before Accept. User can hand-edit tags after Accept if a specific tag matters and was dropped.

**Hallucination guardrails** (system-prompt rules — same posture as the resume-rewrite path):
- "Do not invent specific quantitative claims (percentages, dollar amounts, user counts, performance numbers). If you have no source for a number, phrase the contribution qualitatively."
- "Preserve the user's existing tense and voice. Do not switch to first-person."
- "If you cannot produce a defensible bullet from the available context, return fewer bullets — never pad with generic filler."
- "When the archive shows the same role described with different wording across versions, prefer the most concrete / metric-bearing phrasing. When the current profile has a blank that the archive fills, prefer the archive's specifics over a generic restatement."

---

#### Task list

##### M7.6.1 — Schema: `ResumeUpload` table ✅ (S7.9)

Migration `add_resume_uploads` (both `dev.db` + `prod.db`). New Prisma model:

```prisma
model ResumeUpload {
  id            String   @id @default(cuid())
  userId        String
  filename      String              // original upload filename
  mimeType      String              // application/pdf, .../docx, text/plain, application/json
  sizeBytes     Int
  rawText       String              // post-extract plaintext, capped at 200 KB
  parsedJson    String              // the LLM extraction output that feeds merge; canonical structured form
  artifactPath  String?             // relative path to data/resume-uploads/<id>.<ext>
  importBatchId String?             // groups multi-file uploads from one /api/profile/import call
  uploadedAt    DateTime @default(now())
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, uploadedAt])
}
```

Reverse relation on `User.resumeUploads`. `rawText` cap of 200 KB matches the M7.4 import-pipeline ceiling. `artifactPath` mirrors how `GeneratedResume.artifactPath` works for the generation side. Storage root: `data/resume-uploads/` with `.gitkeep`, gitignored — symmetric to `data/resumes/`.

##### M7.6.2 — Persist raw upload at import time ✅ (S7.9)

Modify `app/api/profile/import/route.ts`:
- Before the existing merge step, write a `ResumeUpload` row per file: `{filename, mimeType, sizeBytes, rawText: extracted, parsedJson: JSON.stringify(llmExtraction), importBatchId: cuid()}`.
- Write the original bytes to `data/resume-uploads/<id>.<ext>` via the same `safeRelative` helper used by `lib/resumes/storage.ts` (extract / reuse).
- If the row write fails, log a warning and proceed with merge anyway — never block the user's import on archive failure.
- Existing append-merge semantics on the profile remain **unchanged** — the archive is purely additive.

`lib/profile/storage.ts` — new file or extend existing. Mirror the `data/resumes/` pattern: `STORAGE_ROOT = path.join(process.cwd(), "data/resume-uploads")`, `writeUpload(uploadId, ext, bytes)`, `readUpload(uploadId, ext)`.

##### M7.6.3 — Repository helpers ✅ (S7.9)

`lib/repositories/resume-uploads.ts`:
- `listResumeUploads(userId)` — summary projection (no `rawText` / `parsedJson` columns), ordered newest-first.
- `getResumeUpload(uploadId, userId)` — full row with owner check.
- `findUploadsMatchingParent(userId, parent: WorkRole | Project | Education)` — returns rows whose `rawText` contains the parent's identifying string (`company` / `name` / `institution`, case-insensitive). Capped at 5 rows by recency.
- `deleteResumeUpload(uploadId, userId)` — removes row + artifact file. (Out of scope for this phase to wire a delete UI, but the helper exists for future use.)

##### M7.6.4 — Archive retrieval helper ✅ (S7.7 / S7.8 / S7.9)

`lib/profile/upload-archive.ts:findArchiveSpansFor(parent, uploads)`:
- Input: a parent entity (`WorkRole` / `Project` / `Education`) plus pre-fetched `ResumeUpload[]` (caller scopes by userId).
- Output: `ArchiveSpan[]` — up to 3 entries shaped `{uploadId, uploadedAt, filename, span: string}`, where `span` is the ±500-character window around the first case-insensitive match of the parent's identifier in `rawText`.
- Ranking: most recent first. If multiple matches in one upload, only the first window per upload is included (avoids one upload dominating the prompt).
- Defensive: returns `[]` when the parent has no identifier (empty `company`), when no upload matches, or when `rawText` is null / empty.

Pure function — unit-testable without a DB. Hermetic smoke `archive-spans-smoke.ts` exercises the boundary cases.

##### M7.6.5 — Prompt builder ✅ (S7.7 / S7.8)

`lib/profile/bullet-assist.ts:buildBulletAssistPrompt(profile, parent, mode, currentBullet?, archiveSpans?, readmeContext?)`. Pure function — no I/O. Sections in order:

1. Mode-specific preamble + guardrails.
2. Spine fields of the parent.
3. Sibling tag-overlap bullets (top N by overlap score, capped to 1.5 KB).
4. Archive spans (M7.6.4 output, capped to 3 × 500 chars = 1.5 KB).
5. README excerpt (Project parents only, 2 KB cap).
6. (Rewrite mode only) Current bullet text + tags.
7. Output schema: fill → `{bullets: [{text, tags}]}`; rewrite → `{text}`.

Total prompt budget aims at ≤ 8 KB to leave headroom for the response. Hermetic-testable: feed canned inputs, assert sections present in correct order, assert size caps respected.

##### M7.6.6 — Gemini caller ✅ (S7.7 / S7.8)

`lib/profile/bullet-assist.ts:callBulletAssist({prompt, mode})`:
- Calls `chatJSON({model: MODEL_LITE /* gemini-3.1-flash-lite */, maxOutputTokens: mode === 'fill' ? 4096 : 2048, ...})`.
- Validates response against a zod schema per mode.
- Server fills in `id` (new cuid) / `locked: false` / `excluded: false` for fill bullets.
- Server preserves `id` / `tags` / `locked` / `excluded` for rewrite proposal; only `text` flows from the LLM.

##### M7.6.7 — API route + rate limit ✅ (S7.7 / S7.8)

`app/api/profile/bullets/assist/route.ts`. `POST`:
- Body schema: `{mode: 'fill' | 'rewrite', parentKind: 'work-role' | 'project' | 'education', parentId: string, bulletId?: string}`. Zod-validate: `bulletId` required when `mode === 'rewrite'`, rejected when `mode === 'fill'`.
- `requireSession`-gated. Loads parent row, asserts `profile.userId === session.user.id`, 404s on miss.
- Locked-rewrite guard: 400 with `{error: 'cannot-rewrite-locked'}` (defense-in-depth — UI hides the wand).
- Rate-limit at `profile:bullet-assist` scope, **20 calls / 10 min**. Higher than the 5 / 10 min on `profile:import` and `resumes:gen` because bullet-assist is per-bullet; tight enough that a stuck loop can't burn the Gemini budget. Returns 429 with `Retry-After`.
- Returns `{mode: 'fill', suggestions: Bullet[]}` or `{mode: 'rewrite', proposal: Bullet}`. Route does **not** persist — client persists via the existing entry PATCH on Accept.

##### M7.6.8 — Fill UI ✅ (S7.7)

Empty-state pane on the entry cards (`components/cards/WorkRoleCard.tsx` / `ProjectCard.tsx` / `EducationCard.tsx`, verify file locations at implementation time). "Draft with LLM" button below the existing "+ Add bullet" affordance. Click → API call → inline "Drafting…" spinner → response inserted as draft rows the user can edit / lock / exclude / delete before saving. Locked-or-excluded toggles on the draft rows behave as on saved bullets.

##### M7.6.9 — Rewrite UI + diff panel ✅ (S7.8)

`components/ui/BulletRow.tsx`:
- Wand / sparkle icon next to existing lock + eye-off icons. Hidden when `locked === true`. Excluded bullets keep the wand (user might want to revive).
- On click → API call → bullet row expands into a diff panel: original text line-through, proposed text in emerald, Accept / Discard buttons. Character-level diff via the `diff` library if span warrants; otherwise stacked before/after.
- Accept → calls the existing entry PATCH route with the bullets array containing the swapped `text`. Discard → closes the panel, no write.
- Errors surface as an inline rose chip; doesn't block other bullets in the entry.

##### M7.6.10 — Telemetry + llm-calls doc ✅

- Each assist call logs `[LLM] bullet-assist:<mode>:<parentKind>:<parentId>` to the in-app log buffer (`lib/logger.ts`). Surfaces on the Internal Systems dash via the existing log-tail SSE — no new metric.
- Add a row to `docs/llm-calls.md`: caller `lib/profile/bullet-assist.ts`, model `MODEL_LITE` (`gemini-3.1-flash-lite`), `maxOutputTokens` 2048 (rewrite) / 4096 (fill), scope "Profile bullet drafting + rewriting + archive grounding (S7.7 / S7.8 / S7.9)".

##### M7.6.11 — Hermetic smokes ✅

- `scripts/tests/hermetic/archive-spans-smoke.ts` — covers M7.6.4 `findArchiveSpansFor`. Asserts: empty uploads → `[]`; no-match parent → `[]`; multi-match in one upload returns only first window; ranking by `uploadedAt desc`; ±500-char window; case-insensitive match.
- `scripts/tests/hermetic/bullet-assist-smoke.ts` — covers M7.6.5–M7.6.7. Mocks `chatJSON` with fixture responses. Asserts: fill returns 3–5 cuids + correct shape; rewrite preserves id / tags / locked / excluded and only changes text; rate-limit returns 429 with `Retry-After`; locked bullets get 400 at the API layer; cross-user `parentId` returns 404; archive spans appear in the prompt when uploads match.
- `scripts/tests/hermetic/resume-uploads-smoke.ts` — covers M7.6.3 repository helpers. CRUD + cross-user rejection + cascade-on-user-delete + `findUploadsMatchingParent` ranking and cap.
- All three wired into `scripts/pre-push.sh`.

---

#### Acceptance (whole phase)

- Existing M7.4 imports continue to work; each import additionally writes a `ResumeUpload` row + artifact.
- Empty WorkRole → "Draft with LLM" → 3–5 editable draft bullets appear within ~5 s. If past uploads mentioned the same company, the draft visibly reuses wording or details from them (verify manually after the next real upload).
- Existing bullet → click wand → diff panel within ~3 s. Accept persists, Discard closes without write.
- Locked bullet → no wand visible; forged request returns 400.
- Excluded bullet → wand visible; rewrite succeeds.
- 21st call within 10 min → 429 with `Retry-After`.
- `npm run test:hermetic` green; three new smokes wired into pre-push.

#### Backfill posture

The archive is populated **going forward** — pre-M7.6 uploads aren't preserved (the import pipeline discarded them). No retroactive backfill is shipped; the current profile is treated as the v0 baseline. If, post-M7.6, the user finds a meaningful gap, an emergency backfill could be wired by reading sent-mail attachments from Gmail (`/api/applications/backfill` already touches this surface) — flagged as 💤 future, not a blocker.

#### Out of scope for this phase

- Bulk "polish all bullets in this entry" one-click action — future, if S7.8 sees enough single-shot use.
- LLM-suggested tag changes (tags preserved verbatim through both modes).
- Streaming the proposal (fits in a single response; SSE adds complexity for no UX win on a ~3 s call).
- Embedding-based semantic retrieval of archive spans — keyword match on parent identifier is the MVP; embeddings only if keyword retrieval underperforms in practice.
- UI for browsing / deleting individual archive uploads — repository helpers exist (M7.6.3) but no surface yet. Future polish.

### M7.7 — Bullet tag/AI UX refactor ⏳

Stories: **S7.10** (🟡 split text rewrite from tag generation + 3-7 cap) + **S7.11** (🟡 pin tags) + **S7.12** (🔵 tag click no-op + bigger X). Added 2026-05-25, designed not started. **Ships first** of the three new C-track milestones — pure UI/UX surface, one new LLM callsite, no Prisma migration (just Bullet JSON shape evolution).

**Why now.** M7.6 shipped bullet-assist with a single wand icon that does both text rewrite AND tag updates; M8.5 added auto-tagging from posting keywords. Two pain points in real use: (a) a sentence-polish click clobbers carefully chosen tags, and (b) clicking a tag chip removes it (footgun on busy bullets). This milestone separates concerns: text rewrite narrows to text-only; new tag-only generator handles tag churn with explicit accept/discard; pinned tags lock specific choices against either flow; tag removal moves to an explicit X-icon affordance.

**Surfaces touched.**
- `components/ui/BulletRow.tsx` — split wand into two icon buttons, add pin toggle per tag chip, remove chip-body onClick, bump X size.
- `lib/profile/types.ts` + `lib/schemas/profile.ts` — Bullet JSON shape gains `pinnedTags: string[]`.
- `lib/profile/bullet-assist.ts` — rewrite mode narrows to text-only.
- New `lib/profile/bullet-tags-from-profile.ts` — per-bullet tag generator.
- `app/api/profile/bullets/assist/route.ts` — new `mode: 'tags'` + 7-tag cap guard.
- New `docs/llm-prompts/bullet-tags-from-profile.md` + `eval/suites/bullet-tags-from-profile.yaml`.

**LLM model.** `MODEL_LITE` (same tier as M7.6 + M8.5 — per-bullet tag suggestion is bounded judgment, not free-form generation).

---

#### Task list

##### M7.7.1 — Schema: `Bullet.pinnedTags` + invariants ⏳ (S7.11)

Bullets are stored as JSON inside parent entity columns (Decision 4) — no Prisma migration. Update `lib/profile/types.ts`:

```typescript
export interface Bullet {
    id: string;
    text: string;
    tags: string[];
    autoTags: string[];
    removedTags: string[];
    pinnedTags: string[];    // NEW
    locked: boolean;
    excluded: boolean;
}
```

Read-time defaults in `lib/profile/bullets.ts:hydrateBulletDefaults` (the M8.5.1 helper): missing `pinnedTags` defaults to `[]`. Write-time zod schema: `pinnedTags: z.array(z.string()).default([])`.

Invariants enforced via `.refine()` on the bullet PATCH schema:
- `pinnedTags ⊆ tags` (can't pin a tag that isn't applied)
- `pinnedTags ∩ removedTags = ∅` (blocklist wins; pinning a blocked tag is rejected)

Side-effects in the PATCH validator:
- Removing a tag from `tags` also strips it from `pinnedTags` (a pinned tag deletion implicitly unpins).
- Adding a tag to `removedTags` strips it from `pinnedTags` (blocklist eviction).

##### M7.7.2 — Narrow `bullet-assist-rewrite` to text-only ⏳ (S7.10)

`lib/profile/bullet-assist.ts` rewrite mode currently returns `{text, tags}` and persists both — that was the M7.6 `fffa038` enhancement to S7.8. After this task it returns `{text}` only; server preserves the input bullet's `tags` / `autoTags` / `removedTags` / `pinnedTags` / `locked` / `excluded` verbatim.

Edit `docs/llm-prompts/bullet-assist.md` rewrite-mode section to drop the tag-update directive. Update `eval/suites/bullet-assist-rewrite.yaml` fixtures: add assertion that proposal does NOT include `tags`; assertion that persisted bullet keeps original tags. Sync via `npx tsx scripts/sync-lunary-templates.ts`.

Same prompt slug (`bullet-assist-rewrite`); behavior change only.

##### M7.7.3 — New `bullet-tags-from-profile` LLM callsite ⏳ (S7.10 + S7.11)

New file `lib/profile/bullet-tags-from-profile.ts`:

```typescript
export async function suggestTagsForBullet(opts: {
    userId: string;
    parentKind: 'work-role' | 'project' | 'education';
    parentId: string;
    bulletId: string;
}): Promise<{ tags: string[]; reason?: string }>;
```

Grounds on:
1. Bullet's current text.
2. Bullet's current `tags`, with each tag marked as `pinned` / `auto` / `user` so the LLM knows which are anchors vs replaceable candidates.
3. Bullet's `removedTags` (blocklist — don't propose these).
4. Profile-wide tag vocabulary (top N tags across all bullets, for consistency — encourages reuse over inventing new tags every call).

Output: `{tags: string[]}` — the proposed final tag list. Must include all `pinned` tags verbatim, must respect the 3-7 cap, may swap out unpinned tags. Server post-filters defensively: any pinned tag missing from proposal gets re-added; any tag from `removedTags` gets stripped; if the result is still > 7 after re-adding pins, the unpinned tail is truncated; if the result is < 3, return what we have (soft floor).

`chatJSON({name: 'bullet-tags-from-profile', model: MODEL_LITE, maxOutputTokens: 1024, ...})`.

##### M7.7.4 — Prompt + Promptfoo fixtures for `bullet-tags-from-profile` ⏳ (S7.10 + S7.11)

New `docs/llm-prompts/bullet-tags-from-profile.md`. System prompt enumerates:
- Output **3 to 7 tags total** (count includes pinned + unpinned).
- Every tag in the input's `pinned` list MUST appear verbatim in the output.
- Never propose a tag in the input's `removedTags` list.
- Prefer reusing tags from the profile vocabulary over inventing new ones.
- Tags should be concrete skills, technologies, or methodologies — not generic adjectives.
- Conservative over aggressive — if you can't defend 3, return what you can defend.

New `eval/suites/bullet-tags-from-profile.yaml` with fixtures:
- **Pin preservation**: input `{text: "Built Python API", tags: [{label: "Python", state: "pinned"}, {label: "API", state: "user"}]}` → assert `Python` in output.
- **Cap respected**: input with 0 existing tags + tag-rich text → assert 3–7 in output.
- **Blocklist filtered**: input with `removedTags: ["JavaScript"]` and text mentioning JS → assert `JavaScript` not in output.
- **Vocabulary reuse**: input with profile vocabulary `["TypeScript"]` + bullet text mentioning JS → assert proposal includes `TypeScript` rather than inventing a synonym.

Provider handler: add `bullet-tags-from-profile` case to `eval/provider.ts:HANDLERS`.

##### M7.7.5 — API route + 7-tag cap guard ⏳ (S7.10)

Extend `app/api/profile/bullets/assist/route.ts` POST body schema to accept `mode: 'fill' | 'rewrite' | 'tags'` (was `'fill' | 'rewrite'`).

Handler logic when `mode === 'tags'`:
1. Load parent + bullet, ownership-check (same as fill/rewrite paths).
2. Locked-bullet guard: 400 with `{error: 'cannot-suggest-tags-locked'}` (defense-in-depth — UI hides the button).
3. **Cap guard**: if `bullet.tags.length >= 7`, return 400 `{error: 'tag-limit-reached'}` **before** calling the LLM. No token spend; UI catches this status and shows a "remove or unpin a tag first" hint.
4. Call `suggestTagsForBullet`, return `{mode: 'tags', proposal: {tags, reason?}}`.

Same `profile:bullet-assist` rate-limit scope (shared 20 / 10 min) — tag suggestions are cheap but count against the budget.

##### M7.7.6 — BulletRow refactor: split buttons + pin toggle + click semantics + bigger X ⏳ (S7.10 + S7.11 + S7.12)

In `components/ui/BulletRow.tsx`:

- **Split AI buttons**: wand icon (existing) → text-only rewrite (per [[M7.7.2]]). New `Tags` (lucide) icon next to it → tag-suggest (per [[M7.7.5]]). Both hidden when `locked === true`.
- **Tag chip rendering**:
  - Click on chip body: `onClick` removed — chip body is non-interactive.
  - **Pin toggle**: small `Pin` lucide icon inside the chip (left of text), click toggles membership in `pinnedTags` via existing entity PATCH. Pinned chips render with the Pin icon visible + an amber-tinted border (`border-amber-500/30`) to differentiate from regular tags.
  - **Delete X**: existing X icon stays but bumped from `w-3 h-3` to `w-3.5 h-3.5` (~1px larger). Hit-target padding increased proportionally (chip padding goes from `px-1` to `px-1.5` on the X-side). This is the only tag-removal trigger.
  - **Auto-tag + pinned**: a chip can be in both `autoTags` AND `pinnedTags` — both glyphs (Sparkles + Pin) render inside the chip, expressing "auto-suggested but locked in" state from S7.11.
- **`removeTag` semantics unchanged from M8.5.6**: clears tag from `tags`, `autoTags`, `pinnedTags` (pinned deletion implicitly unpins); adds to `removedTags`.

##### M7.7.7 — Tag-suggest accept/discard UI ⏳ (S7.10)

On tag-suggest API response: bullet row expands into a diff panel — current tags (with pin/auto annotations) on the left, proposed tags on the right (added in emerald, removed in rose line-through). Pins are visually distinct in both columns so the user can verify they survived.

Accept persists via existing entity PATCH path with updated `tags` + `autoTags` (any newly proposed tag gets marked `autoTags`, same semantic as M8.5.3 auto-tag merge). Discard closes panel.

Error states surface as inline rose chip (same pattern as M7.6.9 rewrite UI). 400 `{error: 'tag-limit-reached'}` shows "Tag limit reached — remove or unpin a tag first."

##### M7.7.8 — Hermetic smokes ⏳

- `bullet-tags-from-profile-smoke.ts` — covers M7.7.3, M7.7.5 end-to-end. Mocks `chatJSON`. Asserts: proposal preserves pinned tags; LLM proposal that drops a pinned tag → server-side patched back in; respects 3–7 cap (server-side trims if LLM over-shoots); `removedTags` blocklist filtered; 7-tag bullet → 400 `tag-limit-reached` BEFORE LLM call (verify chatJSON was not invoked); locked bullet → 400; cross-user → 404; rate-limit 429.
- `bullet-rewrite-text-only-smoke.ts` — covers M7.7.2. Mocks `chatJSON`. Asserts: rewrite proposal only contains `text`; persisted bullet keeps original `tags` / `autoTags` / `removedTags` / `pinnedTags` / `locked` / `excluded` unchanged.
- `bullet-pin-tag-smoke.ts` — covers M7.7.1 invariants. Pure-function via PATCH schema. Asserts: PATCH with `pinnedTags` containing a tag not in `tags` → 400; PATCH with `pinnedTags ∩ removedTags ≠ ∅` → 400; removing a tag from `tags` via PATCH also strips it from `pinnedTags`; adding a tag to `removedTags` strips it from `pinnedTags`.

All three wired into `scripts/pre-push.sh`'s `SUITES` array.

---

#### Acceptance (whole phase)

- Wand on a bullet rewrites text only; tags are visibly unchanged after Accept.
- New Tags-icon button on a bullet generates tag suggestions; pinned tags survive the proposal; 3–7 cap is enforced; 7-tag bullet shows "remove or unpin a tag first" hint, no LLM call fires.
- Pin a tag → run tag-suggest → pinned tag is in the proposed output verbatim.
- Click on a tag chip body does nothing; click the X removes the tag (and adds to blocklist per existing M8.5.6).
- Locked bullets: no wand, no Tags button (defense-in-depth: forged requests return 400).
- `npm run test:hermetic` green; three new smokes wired into pre-push.

#### Out of scope for this phase

- **Bulk pin/unpin all tags on a bullet** — single-tag toggle only; bulk affordance is YAGNI until use proves otherwise.
- **Cross-bullet pin** — pin is per-bullet-tag, not "globally pin Python everywhere on the profile."
- **Tag-suggest provenance log** — the trace already shows which tags drove a selection; per-tag history not stored.
- **Tag-suggest grounded on posting** — that's [[S8.9]] auto-tag pass (M8.5), runs at resume-gen time. Per-bullet manual flow is posting-agnostic by design.
- **Confidence score per tag proposal** — LLM returns a flat list. If quality varies wildly, revisit and add per-tag confidence display.

### M7.8 — Per-entity scratchpad: profile half ⏳

Story: **S7.13** (🟡 per-entity scratchpad) — first of two milestones covering this story. Added 2026-05-25, designed not started. **Ships second** of the new C-track wave (after M7.7). Schema migration touches three entity tables. Resume-gen synthesis half ships separately in [[M8.6]].

**Why now.** Generated bullets sometimes read in generic resume-speak rather than the user's voice — and bullets are constrained to whatever's in the structured profile, so a role's *new* experiences (post-import) get under-represented. A per-entity free-form scratchpad gives the user a place to dump unfiltered context about each role / project / education in their own words. The LLM uses it as voice + experience grounding for bullet-assist (M7.6 paths) immediately, and as the substrate for resume-gen synthesis later ([[M8.6]]).

**Surfaces touched.**
- `prisma/schema.prisma` — `scratchpad: String?` on `WorkRole`, `Project`, `Education` (migration `add_entity_scratchpads`).
- `lib/schemas/profile.ts` — three PATCH schemas accept `scratchpad`.
- New `components/overlays/ScratchpadOverlay.tsx` — modal editor.
- `components/ui/WorkRoleRow.tsx` + `ProjectRow.tsx` + `EducationRow.tsx` — trigger button + visual state.
- `lib/profile/bullet-assist.ts` — fifth grounding source after archive spans.

---

#### Task list

##### M7.8.1 — Schema migration: `scratchpad` on three entity tables ⏳

Migration `add_entity_scratchpads` (dev + prod). Adds `scratchpad String?` to `WorkRole`, `Project`, `Education`. Existing rows default null — pure additive.

Apply against dev.db first: stop `mission-control-dev` + `mission-control-scheduler-dev`, run `npx prisma migrate dev --name add_entity_scratchpads`, restart. Then against prod.db: stop `mission-control` + `mission-control-scheduler-prod`, point `DATABASE_URL` at `prisma/prod.db`, run `npx prisma migrate deploy`, restart. (Same protocol as M8.4.1 — SQLite WAL hold from PM2 blocks the migrate without the stop.)

##### M7.8.2 — Repository + PATCH schema updates ⏳

Extend `WorkRolePatchSchema` / `ProjectPatchSchema` / `EducationPatchSchema` in `lib/schemas/profile.ts`:

```typescript
scratchpad: z.string().max(8192).nullable().optional(),
```

Cap at 8 KB to bound prompt budgets. Existing PATCH routes pass through unchanged — no new routes needed. Existing repository helpers in `lib/repositories/profile.ts` need their `select` projections updated to include the new column on read (otherwise GET responses won't surface it).

##### M7.8.3 — Scratchpad overlay component ⏳

New `components/overlays/ScratchpadOverlay.tsx`. Modal mounts via portal to `document.body` (matching `NotificationBell` / M8.4.6 popover pattern — escapes CardGrid's `overflow-hidden`). Props:

```typescript
interface Props {
    entityKind: 'work-role' | 'project' | 'education';
    entityLabel: string;         // e.g. "Acme Corp — Senior Engineer" for header
    initialValue: string | null;
    onSave: (value: string | null) => void;  // null when textarea is empty after save
    onClose: () => void;
}
```

Body: large multi-line `<textarea>` (rows={12}), placeholder *"In your own words: what did you build at this role, what problems did you solve, what was hard, what energizes you?"*, character count badge (`X / 8000`), Save / Cancel buttons. Esc closes (= cancel); Ctrl/Cmd+Enter saves. Click outside the modal body = cancel (matches Launchpad overlay behavior). Backdrop is `bg-black/60 backdrop-blur-sm`.

##### M7.8.4 — Entity row trigger button + visual state ⏳

Update `components/ui/WorkRoleRow.tsx`, `ProjectRow.tsx`, `EducationRow.tsx`. New `<ScratchpadTriggerButton>` inline (extract to shared `components/ui/ScratchpadTriggerButton.tsx` only if it grows past ~60 LOC):

- Icon: lucide `StickyNote`.
- **Empty state**: outlined, `text-white/30` border + icon stroke. Title attribute: `"No notes yet — click to add"`.
- **Populated state**: filled tinted icon in the row's theme color (purple for WorkRole, cyan for Project, emerald for Education), with a small filled dot to the side. Title attribute: `"{N} chars of notes — click to edit"` (where N = `scratchpad.length`).
- Click → opens `ScratchpadOverlay` for this entity. On save → PATCH the entity → TanStack invalidate (`['profile']` is already invalidated by the existing PATCH path; just verify the projection from M7.8.2 includes scratchpad).

##### M7.8.5 — Bullet-assist grounding (5th source) ⏳

Update `lib/profile/bullet-assist.ts:buildBulletAssistPrompt`. Insert a new grounding section after archive spans (M7.6.4 output) and before the README excerpt:

5. **Parent scratchpad** (if non-empty) — up to 2 KB of the entity's own scratchpad. Truncated from the end with an ellipsis if longer. Header in the prompt: `"User's notes about this role/project/education (their own voice):"`.

**Cross-entity isolation**: only `parent.scratchpad` is included; sibling entities' scratchpads never leak in. Tested explicitly in M7.8.6.

Update `docs/llm-prompts/bullet-assist.md` to reference the new section in both fill and rewrite modes' grounding lists. The 8 KB overflow logic in `buildBulletAssistPrompt` already drops sections oldest-first when over budget — scratchpad sits between archive spans and README in the drop order. Sync via `npx tsx scripts/sync-lunary-templates.ts`.

Promptfoo fixtures in `eval/suites/bullet-assist-fill.yaml` + `bullet-assist-rewrite.yaml`: add one scratchpad-grounded fixture per suite, assert the generated bullet picks up wording from the scratchpad text.

##### M7.8.6 — Hermetic smokes ⏳

- `scratchpad-patch-smoke.ts` — covers M7.8.2. Asserts: PATCH accepts `scratchpad` string, persists, GET returns it for all three entity kinds; cap enforcement (8001 chars → 400); null-clear works (PATCH `{scratchpad: null}`); cross-user → 404.
- `bullet-assist-scratchpad-smoke.ts` — covers M7.8.5. Mocks `chatJSON`. Asserts: prompt body includes `parent.scratchpad` text when entity has non-empty scratchpad; doesn't include the section header when empty; sibling entities' scratchpads NEVER appear in the prompt for entity X (cross-entity isolation).

Both wired into `scripts/pre-push.sh`'s `SUITES` array.

---

#### Acceptance (whole phase)

- Each WorkRole / Project / Education row has a Notes button.
- Empty entity: button is outlined and muted. Populated entity: button is theme-colored and filled with a small dot.
- Click button → modal opens with the scratchpad textarea, character count, Save/Cancel.
- Save persists; cross-tab SSE updates the button visual state on other open tabs.
- Bullet-assist fill on an entity with scratchpad → generated bullets visibly use scratchpad wording/cadence (manual sanity check; Promptfoo fixture covers automated regression).
- `npm run test:hermetic` green; two new smokes wired into pre-push.

#### Out of scope for this phase

- **Resume-gen synthesis** — ships in [[M8.6]].
- **Profile-level scratchpad** — per-entity only per user direction 2026-05-25 (initial design was profile-level; user redirected to per-entity for scoping clarity). Easier to extend to profile-level later if cross-entity narrative becomes useful.
- **Auto-summarize scratchpad** — out. Scratchpad is intentionally raw; summarization changes voice.
- **Versioning of scratchpad edits** — out. `ProfileSnapshot` (M7.5) can extend to capture scratchpad columns when rollback UX ships (story S7.6 deferred).

### M7.9 — Profile tagline + LLM draft ⏳

Story: **S7.14** (🟡 LLM-drafted tagline). Added 2026-05-26, designed not started. **Splits the dual-purpose `profile.headline` field** — today it's used as both the user's name (resume H1, per M8.4 canonical naming) AND any tagline-y content they happen to put there. M7.9 adds a separate `tagline` column + AI-draft UX so the two concerns stop colliding. UI label rename "Headline" → "Name" on `PersonalInfoCard` ships alongside (already in tree).

**Why now.** The user uses `profile.headline` for their name, but the existing placeholder ("Click to add a headline (e.g. 'Senior Engineer · Distributed Systems')") was confusing. Resume H1 prints the name; a one-sentence tagline as subtitle is a common resume convention but currently the user has no place to put it without overloading the name field. The LLM-draft is the lever — drafting a defensible tagline from scratch is hard, refining a starting point is easier; both flows ground on the full profile so the LLM stops at evidence the profile actually shows.

**Surfaces touched.**
- `prisma/schema.prisma` — `Profile.tagline String?` (migration `add_profile_tagline`).
- `lib/schemas/profile.ts` — `ProfileSchema` + `ProfilePatchSchema` accept `tagline` (cap 200 chars at zod).
- `lib/repositories/profile.ts` — `ProfileHeaderUpdate` + `updateProfileHeader` thread `tagline`.
- New `lib/profile/tagline-draft.ts` — caller (loads profile, builds prompt, dispatches chatJSON, returns proposal).
- New `docs/llm-prompts/tagline-draft.md` + `eval/suites/tagline-draft.yaml` + provider handler in `eval/provider.ts`.
- New `app/api/profile/tagline/draft/route.ts` — POST, session-gated, per-user rate-limit.
- `components/cards/profile/PersonalInfoCard.tsx` — new Tagline field below Name + AI-draft button + inline diff panel (Accept / Discard).
- `lib/resumes/templates/ats-plain.tsx` — render `profile.tagline` as a subtitle line under the H1 when non-null.

**LLM model:** `MODEL_LITE` (`gemini-3.1-flash-lite`) — bounded judgment, conservative voice rewrite. Promote to `MODEL_FLASH` only if Promptfoo evals show LITE is poor at the enhance path.

---

#### Task list

##### M7.9.1 — Schema migration: `Profile.tagline` ⏳ (S7.14)

Migration `add_profile_tagline` (dev + prod). Adds `tagline String?` to `Profile`. Pure additive; existing rows default null. Apply against dev.db first; then prod.db with PM2 stopped (same protocol as M7.8.1).

##### M7.9.2 — PATCH schema + repository accept `tagline` ⏳ (S7.14)

- `lib/schemas/profile.ts`: extend `ProfileSchema` (wire-format) with `tagline: z.string().nullable().optional()`; extend `ProfilePatchSchema` with `tagline: z.string().max(200).nullable().optional()`. 200-char cap matches the prompt's hard rule.
- `lib/repositories/profile.ts`: extend `ProfileHeaderUpdate` type + `updateProfileHeader` payload assembly so the column flows through.
- `lib/profile/types.ts`: no change (tagline isn't part of the Bullet shape).
- The existing `/api/profile` PATCH route already accepts the full `ProfilePatchSchema` shape, so no route change is needed for plain text writes — only the new draft endpoint at M7.9.5 needs route wiring.

##### M7.9.3 — `tagline-draft` LLM caller ⏳ (S7.14)

New `lib/profile/tagline-draft.ts:draftTagline({userId})`. Loads the full hydrated profile via `findOrCreateProfile`. Builds a compact profile-summary block (one section per WorkRole / Project / Education with spine + bullets text + scratchpad excerpt; plus skills/hobbies/languages summary; plus current summary; plus current tagline if any). Two dispatch modes:
- **Empty current tagline** → `mode: 'draft'`. Prompt instructs the LLM to produce a one-sentence tagline grounded ONLY on the profile evidence.
- **Non-empty current tagline** → `mode: 'enhance'`. Prompt instructs the LLM to refine the user's existing text while preserving their angle — the user's framing is the floor.

Calls `chatJSON({ name: 'tagline-draft', model: MODEL_LITE, maxOutputTokens: 256, temperature: 0.4 })`. Zod-validates the response: `{tagline: z.string().min(1).max(200)}`. Server post-processes: trim, strip trailing newlines, ensure trailing period if absent.

Pure caller — does NOT persist. Returns `{tagline, mode, durationMs}`. Client persists via the existing profile PATCH on Accept.

##### M7.9.4 — Prompt + Promptfoo fixtures ⏳ (S7.14)

- New `docs/llm-prompts/tagline-draft.md`. System prompt enumerates: no fabrication (only claim experience the profile evidences), one sentence ≤ 200 chars typically ≤ 120, no first-person pronouns/possessives, ends with a period, professional one-liner not sales-y, mode-specific behavior (draft from scratch vs enhance user's existing). User template interpolates `{{mode}}` + `{{currentTagline}}` + `{{profileSummary}}`.
- New `eval/suites/tagline-draft.yaml` with fixtures:
  - **Draft from empty** — profile with rich work history → output is one sentence covering the profile's most defensible claim.
  - **Enhance preserves angle** — current tagline "Backend engineer who likes systems" → output keeps "backend systems" focus, doesn't pivot to "full-stack" or invent new domain.
  - **No-invention** — profile has no Rust experience → output never claims Rust even if "Rust" appears as a posting-keyword-style hint in the input.
  - **Length cap** — output ≤ 200 chars; assertions check both length and that the rewrite didn't truncate mid-sentence.
- Provider handler in `eval/provider.ts:HANDLERS["tagline-draft"]`. Mirrors the bullet-tags-from-profile handler shape: fixture supplies profile summary directly so the suite is DB-agnostic.

##### M7.9.5 — API route + rate limit ⏳ (S7.14)

New `app/api/profile/tagline/draft/route.ts` `POST`:
- `requireSession`-gated.
- Body: `{}` (no payload — server reads `profile.tagline` to decide mode).
- Rate-limit scope `profile:tagline-draft`, 10 calls / 10 min per user (looser than bullet-assist's 20 since tagline drafts are larger-output, but tighter than resumes:gen since they're cheaper per call).
- Calls `draftTagline({ userId })`. Returns `{ tagline, mode }`.
- 502 on AIError (mirror bullet-assist's error shape).

##### M7.9.6 — UI: Tagline field + AI-draft button + diff panel ⏳ (S7.14)

`components/cards/profile/PersonalInfoCard.tsx`:
- New props: `tagline: string | null`, `onSave({tagline})` already covered by `PersonalInfoPatch` once M7.9.2 lands.
- New field below Name. Plain text input via `EditableField` for direct edits.
- AI-draft button: purple `Sparkles` icon, hover state. Click → POST `/api/profile/tagline/draft`, surface "Drafting…" state, render proposal in inline diff panel.
- Diff panel: original text (line-through if non-empty; "(empty)" placeholder if null) vs proposed text (emerald). Accept → call `onSave({tagline: proposal})`. Discard → close panel. Error → inline rose chip.
- Cap-hint UX: input has a 200-char counter that turns rose at 180+.

##### M7.9.7 — Resume template subtitle render ⏳ (S7.14)

`lib/resumes/templates/ats-plain.tsx`: extend the header block to render `profile.tagline` as a subtitle line directly under the name H1 when non-null and non-empty. Style: smaller font, muted color, single line. Empty tagline = no subtitle line (no empty row). Matches the existing visual convention used by the location/email/phone metadata block.

Regression-pin via `scripts/tests/hermetic/resume-render-smoke.ts`: extend the fixture profile with a tagline; assert the rendered PDF contains the tagline text. Already a non-AI smoke, so cheap to extend.

##### M7.9.8 — Hermetic smokes ⏳

- `scripts/tests/hermetic/tagline-patch-smoke.ts`: PATCH `/api/profile` with `{tagline: "..."}` persists; 201-char string → 400 (cap enforced); null clears; cross-user → 404 (existing ownership guard).
- `scripts/tests/hermetic/tagline-draft-smoke.ts`: mocks `chatJSON`; asserts mode dispatch (empty → 'draft', non-empty → 'enhance'); asserts server-side post-filter (trim + trailing period); asserts rate-limit 429 on 11th call; asserts AIError → 502.

Both wired into `scripts/pre-push.sh`'s `SUITES` array.

---

#### Acceptance (whole phase)

- "Headline" label on `PersonalInfoCard` reads "Name" (already shipped pre-M7.9 alongside the rename); placeholder reads "Your full name (e.g. 'Salvador Salcedo')".
- New Tagline field appears below Name on `PersonalInfoCard` with a Sparkles AI-draft button.
- Click AI-draft when tagline empty → one-sentence proposal grounded in the profile appears in a diff panel; Accept persists.
- Click AI-draft when tagline non-empty → proposal preserves the user's existing angle; refined for voice/fit; Accept persists.
- Generated resume (PDF + DOCX) renders the tagline as a subtitle line under the H1.
- Forged request to draft endpoint without `profile.tagline` set still works (empty mode dispatches correctly).
- `npm run test:hermetic` green; two new smokes wired into pre-push.

#### Out of scope for this phase

- **Schema rename `headline` → `name`** — too many cascading consumers (resume renderer, M8.4 canonical-naming helpers, every Promptfoo fixture, two Prisma migrations). UI label rename only.
- **Multi-tagline variants per posting** — tagline is profile-level, not posting-tailored. The resume rewrite step already tailors bullets per posting; pivoting the tagline per posting too is a future story if it becomes a real need.
- **Tagline auto-refresh on profile edits** — manual button only. Auto-trigger would surprise the user.
- **Versioning of tagline edits** — out. `ProfileSnapshot` (M7.5) can extend to capture the column when rollback UX ships.

### M8 Phase 1 — Tailored resume generation ✅

Story S8.1 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/resume-e2e-smoke.ts` (47KB PDF in ~11s) · Commit: `b2cbeb6`.

Pipeline: `lib/resumes/posting.ts` (Gemini keyword extraction) → `lib/resumes/select.ts` (deterministic tag-overlap scoring, locked +Infinity, excluded skipped) → `lib/resumes/rewrite.ts` (single Gemini call with hard guardrails) → `lib/resumes/templates/ats-plain.tsx` → `lib/resumes/render-pdf.ts` (puppeteer-core via system Chrome). `GenerateResumeCard` on the Profile dash.

### M8 — DOCX export ✅

Story S8.5's second half (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/resume-docx-smoke.ts` (30KB DOCX, mammoth round-trip verified) · Commit: `12bfa8c`.

`?format=docx` on the route; same selection + rewrite pipeline; html-to-docx renderer; PDF/DOCX toggle on the trigger card persisted to localStorage. Also bumped default model from `gemini-2.5-flash` to `gemini-flash-latest` (~30–42% faster).

### M8 Phase 2 — Archival + traceability + Application linkage ✅

Stories: S8.2 (🟡 traceability), S8.6 (🟡 archival). Shipped 2026-05-15. Smoke: `scripts/tests/integration/resume-archival-smoke.ts` (17/17 green).

- New `GeneratedResume` Prisma model (userId, applicationId?, postingInput, profileSnapshot, selections, templateKey, format, status, artifactPath?, error). Migration `add_generated_resumes`. Reverse relations on User + Application; `Application.posting onDelete:SetNull` so deleting a posting doesn't nuke the archived resume.
- `lib/resumes/storage.ts` — filesystem-backed at `data/resumes/<id>.<ext>` (gitignored with `.gitkeep` retained). `safeRelative` rejects traversal.
- `/api/resumes POST` now persists after a successful render: write artifact → row insert → return bytes + `X-Resume-Id` header. Best-effort: a persistence failure doesn't fail the user's generation.
- New routes: `GET /api/resumes` (list, filter by applicationId), `GET /api/resumes/[id]` (full row including selections, `?includeSnapshot=1` for the heavy profile blob), `GET /api/resumes/[id]/download` (streams artifact, owner-only).
- `POST /api/resumes` body now accepts `applicationId` (defensive: route verifies owner before linking; 400 otherwise).
- **Traceability UI (story S8.2)**: `GenerateResumeCard` has a "Why these bullets?" expander on the last generation — per selection: source label, original vs rewritten text (line-through diff), matched tags + keywords as chips, score.
- **Per-Application linkage (story S8.6)**: `ApplicationDetailOverlay` has a new "Resumes for this application" expandable section — lists every linked `GeneratedResume` with format badge + timestamp + download link, plus an inline form to generate one scoped to this application.

Story S8.3 (lock/exclude UI surfacing) deferred — toggles already exist; just needs better discoverability. Polish-tier.

### M8 Phase 2-followup ✅

- ✅ **M8-2.5** — Lock/exclude bullet UI prominence (story S8.3). Shipped 2026-05-15. Locked bullets get amber border + always-visible lock icon; excluded bullets get rose border + line-through text + always-visible eye-off icon. Tooltips on hover explain "always include" vs "never include". Section description on the Profile dash's Work History section legends the symbols. Locking and excluding are now mutually exclusive (setting one clears the other).

### M8 Phase 3 — Multi-template + cover letter + skills-gap ✅

**M8-3.1 (multi-template) — ❌ Killed 2026-05-15.** User decision: every target company runs resumes through an ATS parser first (Boeing, Blue Origin, Greenhouse/Lever/Ashby hosts). Visual-polish gain isn't worth the parsing risk on a non-plain template. ATS-plain is final.

**M8-3.2 (cover letter) — ❌ Killed 2026-05-15.** User writes cover letters by hand.

**M8-3.3 (skills-gap report) — ✅ shipped.** `lib/resumes/skills-gap.ts:computeSkillsGap(profile, posting.keywords)` returns the set of posting keywords with no profile bullet (tag or word-boundary substring) evidence. Persisted as `GeneratedResume.skillsGap` (JSON), surfaced under the "Why these bullets?" expander as `SkillsGapBlock` in `GenerateResumeCard.tsx`. Hermetic smoke at `scripts/tests/hermetic/skills-gap-smoke.ts`. PB-4 (2026-05-16) ported the same word-boundary helper into `lib/resumes/select.ts` so the bullet scorer and the gap report agree on what counts as a match.

Stories: S8.4 (🟡 templates), S8.7 (🔵 cover letter), S8.8 (🔵 skills-gap).

### M8.4 — Resume card v2: UX refactor ✅

Stories: **S8.11** (🟡 global previous-resumes dropdown) + **S8.12** (🟡 generate against an Interested-column application) + **S8.13** (🟡 Pipeline / URL / Paste segmented control). Shipped 2026-05-25 in commits `ea0fe7b` (Wave 0 schema + design) → `54d558f` + `98761e6` (Wave 1 Agent A backend) → `87d81d0` (Wave 2 frontend + route wiring) → `c69fcc6` (smoke cleanup) → polish through `98e1daa`. All 10 sub-tasks below landed; design content preserved as historical reference. Resolved [user-stories.md Decision 6](./user-stories.md#-6-s89s813-resumecard-v2--five-product-calls).

**Surfaces touched.**
- `components/cards/GenerateResumeCard.tsx` — segmented control + Pipeline tab UI + previous-resumes dropdown.
- `app/api/resumes/route.ts` — GET enriched with `postingTitle` / `postingCompany`; POST accepts `applicationId`.
- `app/api/applications/pipeline-picker/route.ts` (new) — read-only projection for Pipeline picker.
- `prisma/schema.prisma` — `GeneratedResume.postingTitle: String?` + `postingCompany: String?` columns.

**Pipeline picker filter.** Per Decision 6.4, hides Interested apps without a linked posting URL. Concretely: `application.status === 'INTERESTED' && application.posting?.sourceUrl != null`. Manual-add Apps (S2.3) and cold-email Apps (S1.1) lack a linked `JobPosting` → excluded. The posting URL lives at `JobPosting.sourceUrl` (the Application model itself has no `url` field — the relation is via `Application.postingId`).

**Auto-link to Application.** POST sets `GeneratedResume.applicationId = body.posting.applicationId` when present, so the artifact attaches to the kanban card's Resumes section via [[S8.6]] with no extra step.

---

#### Task list

##### M8.4.1 — Schema: `GeneratedResume` posting-metadata columns ✅ (S8.11)

Migration `add_generated_resume_posting_metadata` (dev + prod). Adds two optional columns to `GeneratedResume`:

```prisma
model GeneratedResume {
  // ... existing fields ...
  postingTitle    String?  // hydrated at gen time from posting.title
  postingCompany  String?  // hydrated at gen time from posting.company
}
```

Pure additive; existing rows leave columns null and the dropdown shows "(no metadata)" for them. No backfill — historical resumes pre-M8.4.1 stay null-labeled.

##### M8.4.2 — POST `/api/resumes` writes posting metadata ✅ (S8.11)

In `app/api/resumes/route.ts` POST handler, after `parsePostingFromInput()` runs, capture `parsedPosting.title` + `parsedPosting.company` into the `GeneratedResume.create()` payload. The two fields are already in scope — the route currently emits them as the `X-Resume-Title` / `X-Resume-Company` response headers — just persist them too.

##### M8.4.3 — GET `/api/resumes` returns posting metadata ✅ (S8.11)

Extend the response projection in `app/api/resumes/route.ts:GET` (currently lines 78–103) to include `postingTitle` and `postingCompany`. Two optional fields; existing callers (`ApplicationDetailOverlay`'s resume diff) ignore extras.

Already ordered `createdAt desc` — verify and confirm the projection caps via a `limit` query param (default 100). Past 100 is paginate-or-search territory and is OOS for v1.

##### M8.4.4 — Pipeline picker endpoint ✅ (S8.12)

New `app/api/applications/pipeline-picker/route.ts`. `GET`:

- `requireSession`-gated through the existing `getServerSession` → `findUserByEmail` flow (mirror `app/api/applications/route.ts:GET`).
- Repository helper at `lib/repositories/applications.ts`: `findInterestedWithPostingForUser(userId)`. Single Prisma call: `prisma.application.findMany({ where: { userId, status: 'INTERESTED', NOT: { postingId: null } }, include: { posting: { select: { sourceUrl: true, title: true } } }, orderBy: { lastUpdateAt: 'desc' } })`. Post-filter rows where `posting?.sourceUrl == null` (defensive — schema doesn't strictly require sourceUrl).
- Projects to `{ items: Array<{ id, company, role, postingUrl, postingTitle }> }`. `postingTitle` falls back to `application.role` if `posting.title` is empty.
- No `?status` param — endpoint is purpose-built for the picker; the filter is hardcoded to `INTERESTED`.

##### M8.4.5 — POST `/api/resumes` accepts `applicationId` ✅ (S8.12)

Extend the existing zod body schema in `app/api/resumes/route.ts`:

```typescript
const PostingInputSchema = z.object({
    url: z.string().url().optional(),
    text: z.string().min(1).optional(),
    applicationId: z.string().cuid().optional(),  // NEW
}).refine(p => !!(p.url || p.text || p.applicationId), {
    message: "Provide one of: url, text, or applicationId",
});
```

Handler logic when `posting.applicationId` is set:
1. Load `application = prisma.application.findUnique({ where: { id }, include: { posting: true }})`.
2. Verify `application.userId === session.user.id` → 404 on mismatch (cross-user isolation; do not leak existence).
3. Verify `application.status === 'INTERESTED'` → 400 with `{stage: 'input', error: 'application-not-interested'}`. Guard against generating off applications in other columns; the picker only surfaces Interested but defense-in-depth.
4. Verify `application.posting?.sourceUrl != null` → 400 with `{stage: 'input', error: 'application-missing-url'}`.
5. Set the canonical url for the parse step: `posting.url = application.posting.sourceUrl`.
6. Set `generatedResume.applicationId = application.id` at create time → auto-attach per [[S8.6]].

All four error codes reuse the existing `STAGE_LABELS['input']` ("Bad input") in `GenerateResumeCard.tsx`.

##### M8.4.6 — Previous-resumes dropdown UI ✅ (S8.11)

In `components/cards/GenerateResumeCard.tsx`, replace the lone `Download last: <filename>` anchor (currently lines 218–226) with a popover-style dropdown:

- New `useQuery({ queryKey: queryKeys.resumes(), queryFn: api.resumes.list })` — add `list` to `lib/api-client.ts`.
- Use the same hand-rolled popover pattern as `components/overlays/NotificationBell.tsx` (no shadcn `Popover` available per `components.json`).
- Row format: `{postingCompany ?? '(unknown)'} · {postingTitle ?? '(no title)'}` left; `{format.toUpperCase()}` chip; `{formatRelative(createdAt)}` right. Click row → download via `/api/resumes/[id]/download`.
- Visible cap 20 rows; scroll if more. Empty state: hide the dropdown affordance entirely. Loading + error follow the trace-block pattern (lines 242–248).

API client addition at `lib/api-client.ts`:
```typescript
resumes: {
    list: async (): Promise<{ resumes: ResumeListItem[] }> => fetcher('/api/resumes'),
    get: async (id: string) => fetcher(`/api/resumes/${id}`),
}
```
Plus `queryKeys.resumes()` returning `['resumes']` and a `ResumeListItem` type co-located with the API.

##### M8.4.7 — Pipeline picker UI ✅ (S8.12)

New child component in `GenerateResumeCard.tsx` (inline; extract to `components/cards/InterestedAppPicker.tsx` only if it grows past ~80 LOC):

- Fetches via TanStack `useQuery({ queryKey: ['applications', 'pipeline-picker'], queryFn: api.applications.pipelinePicker })`.
- Single-select list. Row format: `{company} — {role}` on line one; subdued `{new URL(postingUrl).host}` on line two.
- Click row → `setSelectedApplicationId(item.id)`; selected row gets a purple-tinted border (`border-purple-400/40`), matching the card's existing accent.
- Empty state: "No Interested-column applications with a posting URL yet." with a small link to the Applications dash.
- **No multi-select** — single-pick per [user-stories.md Decision 6.5](./user-stories.md#-6-s89s813-resumecard-v2--five-product-calls)'s S8.12 framing.

##### M8.4.8 — Segmented control ✅ (S8.13)

Refactor the input area at the top of `GenerateResumeCard.tsx` (currently lines 163–187: URL `<input>` + textarea):

- New `inputMode: 'pipeline' | 'url' | 'paste'` state. **Default `'pipeline'`** per Decision 6.5.
- Segmented control above the input area — three buttons, same visual treatment as the existing PDF / DOCX format toggle (lines 189–209). Reuse the format-toggle's classes (`bg-purple-500/30 text-purple-100` when selected; `text-white/50 hover:text-white/80` otherwise) for visual consistency.
- One input visible at a time:
  - `pipeline` → `<InterestedAppPicker>` from M8.4.7.
  - `url` → existing URL `<input>`.
  - `paste` → existing textarea.
- State for each input persists across tab switches (don't blow away typed URL when user toggles to Paste and back).
- `canSubmit` derivation: `!busy && (selectedApplicationId || url.trim() || text.trim())`.
- POST payload selector: `inputMode === 'pipeline' ? { applicationId: selectedApplicationId } : inputMode === 'url' ? { url } : { text }`.
- Localstorage persistence of last-used tab is **explicitly out of scope** — Pipeline is always the default per Decision 6.5.

##### M8.4.9 — TanStack invalidation + SSE ✅

- POST `/api/resumes` already broadcasts `Application.upsert` for `applicationId`-linked rows (verify in `lib/events/broadcaster.ts`). **Add** a `GeneratedResume.create` broadcast topic so the previous-resumes dropdown auto-refreshes after a generate, not just on next mount.
- Subscriber side: `GenerateResumeCard.tsx` subscribes to the broadcast on mount; invalidates `queryKeys.resumes()`.

##### M8.4.10 — Hermetic smokes ✅

- `scripts/tests/hermetic/pipeline-picker-smoke.ts` (covers M8.4.4):
  - Setup: one user with four Apps — `APPLIED` (excluded by status), `INTERESTED` + posting+URL (included), `INTERESTED` no postingId (excluded per Decision 6.4), `INTERESTED` + posting but `sourceUrl=null` (excluded). Plus second user with valid Interested+URL App (must be excluded — cross-user isolation).
  - Asserts: response shape; only the one valid row; correct `postingUrl` + `postingTitle` values; cross-user invisibility; ordering by `lastUpdateAt desc`.
- `scripts/tests/hermetic/resume-from-application-smoke.ts` (covers M8.4.5):
  - Setup: User + Application(`INTERESTED`) + JobPosting(sourceUrl). Mock `lib/resumes/posting.ts:parsePostingFromInput` so it doesn't hit the network.
  - Asserts: POST with `{ posting: { applicationId } }` succeeds; `GeneratedResume.applicationId` linked; `postingTitle` / `postingCompany` persisted from the parsed posting; wrong-user `applicationId` → 404; non-Interested status → 400 (`application-not-interested`); URL-less application → 400 (`application-missing-url`).
- `scripts/tests/hermetic/resume-list-smoke.ts` (covers M8.4.3):
  - Asserts: GET returns rows ordered `createdAt desc`; includes `postingTitle` / `postingCompany` columns; cross-user isolation; null columns for pre-M8.4.2 rows.

All three wired into `scripts/pre-push.sh`'s `SUITES` array.

---

#### Acceptance (whole phase)

- Generate flow from a freshly-Tracked Interested-column application: pick the row from the Pipeline tab (the default tab), click Generate. No URL typing. The generated resume appears under the application's Resumes section automatically (auto-link via M8.4.5 step 6).
- Previous-resumes dropdown lists every resume across all applications; click a row → downloads the artifact. Empty state when none exist.
- Segmented control: Pipeline default; URL + Paste preserve their typed input across tab switches.
- Cross-user isolation verified for both the pipeline-picker endpoint and the applicationId-gated POST.
- `npm run test:hermetic` green; three new smokes wired into pre-push.

#### Out of scope

- Search / filter on the previous-resumes dropdown — out until the archive grows past ~20 rows for the user.
- Generating from non-Interested-status applications — defensive 400; future story if a workflow emerges.
- Auto-fill resume metadata when generating without an `applicationId` — title/company come from the posting parse, fine as-is for direct URL/paste flows.
- Last-used-tab persistence — Pipeline is always default per Decision 6.5.

---

### M8.5 — Resume card v2: LLM keyword coverage ✅

Stories: **S8.9** (🟡 LLM auto-tag pass) + **S8.10** (🟡 rewrite-time keyword fold-in). Shipped 2026-05-25 in the same M8.4/M8.5 wave: commits `ea0fe7b` (Wave 0 — Bullet JSON shape + invariant) → `6aae335` + `ab5e8f4` (Wave 1 Agent B — LLM scaffold + fold-in directive) → `b5ff824` + `861e0ee` (Wave 1 Agent C — BulletRow auto-badge + remove-to-blocklist) → `7b2ee07` (smokes wired + prompt-render invariants extended) → `87d81d0` (Wave 2 — route wiring). All 9 sub-tasks below landed; design content preserved as historical reference. Resolved [user-stories.md Decision 6](./user-stories.md#-6-s89s813-resumecard-v2--five-product-calls).

**Mechanism.** On every resume generate, after the posting is parsed but before bullet selection, a single batched LLM call ("auto-tag pass") iterates the user's profile bullets: for each `(bullet, posting_keyword)` pair, decide if the bullet's existing text already evidences the work the keyword describes. If yes, **add** the keyword as a tag on that bullet — unless the keyword is in the bullet's `removedTags` blocklist (Decision 6.1). Newly added tags also land in a per-bullet `autoTags` array that the UI uses to render an "auto" badge until the user touches the tag (Decision 6.3). Selection runs as today — `lib/resumes/select.ts:scoreBullet` reads `tags` directly, so auto-tagged tags become indistinguishable from user-set tags at selection time. The rewrite prompt gets a new fold-in directive (S8.10): where a bullet's tags ∩ posting keywords is non-empty, weave the keyword verbatim into the rewritten text — subject to existing no-invention + ≤25-word rules.

**No-fabrication invariant.** The auto-tag prompt enumerates the rule explicitly: *"Only add a tag where the bullet's current text already evidences the work that keyword describes. Never invent coverage. When in doubt, omit."* Promptfoo fixtures (M8.5.9) cover the positive case (bullet text mentions Python → tag added) and the negative (bullet text doesn't mention Python → no tag).

**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`) per Decision 6.2 — same tier as bullet-assist (M7.6). Per-(bullet, keyword) yes/no is a bounded judgment, not free-form generation. Promote to `MODEL_FLASH` only if Promptfoo evals show LITE is subjectively poor.

**Best-effort posture.** If the auto-tag pass throws (timeout, malformed response, rate-limit), the generate falls through to selection with the un-modified profile. The user still gets their resume; auto-tag is never load-bearing.

---

#### Task list

##### M8.5.1 — Schema: `Bullet.autoTags` + `Bullet.removedTags` ✅ (S8.9)

Bullets are stored as JSON inside their parent entity's `bulletsJson` column (per Decision 4). **No Prisma migration is needed** — the JSON shape evolves and all readers default-fallback unknown fields.

Update `lib/profile/types.ts`:

```typescript
export interface Bullet {
    id: string;
    text: string;
    tags: string[];
    autoTags: string[];     // NEW — subset of tags pending user review (Decision 6.3)
    removedTags: string[];  // NEW — blocklist excluding keywords from auto-tag (Decision 6.1)
    locked: boolean;
    excluded: boolean;
}
```

Read-time defaults: in the loader that hydrates `bulletsJson` (verify at impl-time; likely a helper in `lib/profile/storage.ts` or `lib/repositories/profile.ts`), normalize loaded bullets so missing `autoTags` / `removedTags` default to `[]`. Write-time zod schema: `autoTags: z.array(z.string()).default([])`, same for `removedTags`.

**Invariant**: a tag cannot be in both `tags` AND `removedTags` simultaneously. Enforce via `.refine()` in the bullet PATCH schema.

##### M8.5.2 — Auto-tag prompt + callsite registration ✅ (S8.9)

New LLM callsite, slug `bullet-tags-from-posting`. Steps per the LLM-observability invariants in CLAUDE.md:

- **Prompt file**: `docs/llm-prompts/bullet-tags-from-posting.md`. System + user template. System enumerates the no-fabrication rule. User template interpolates posting keywords + flattened bullet list (`{id, text, tags, removedTags}` per bullet — `tags` shown so the LLM doesn't re-propose existing ones; `removedTags` shown so it doesn't propose blocked ones; `text` is the evidence the LLM judges against).
- **Lunary registry upload**: extend `scripts/sync-lunary-templates.ts`'s slug list; re-run to push to Lunary. Disk fallback automatic via `lib/ai/prompts.ts:loadPrompt('bullet-tags-from-posting', vars)`.
- **Inventory entry**: append to `docs/llm-calls.md` — caller `lib/profile/auto-tag.ts`, model `MODEL_LITE`, `maxOutputTokens` 2048, scope "Auto-tag bullets with posting keywords during resume gen (S8.9)".
- **Promptfoo suite**: new `eval/suites/bullet-tags-from-posting.yaml`. Four starter fixtures:
  - **Positive**: bullet `"Built a Python API"`, keyword `"Python"` → expect `addedTags: ["Python"]`.
  - **Negative (no evidence)**: bullet `"Built a Go API"`, keyword `"Python"` → expect `addedTags: []`.
  - **Blocklist**: bullet `"Built a Python API"` with `removedTags: ["Python"]`, keyword `"Python"` → expect `addedTags: []`.
  - **Already tagged**: bullet `"Built a Python API"` with `tags: ["Python"]`, keyword `"Python"` → expect `addedTags: []` (don't re-propose).
- **Provider handler**: add `bullet-tags-from-posting` case to `eval/provider.ts:HANDLERS`.

Output schema (single batched call):
```typescript
{
  proposals: Array<{
    bulletId: string;       // echo of input id
    addedTags: string[];    // posting keywords to add; pre-filtered against tags + removedTags
  }>
}
```

##### M8.5.3 — Caller library + write-merge logic ✅ (S8.9)

New `lib/profile/auto-tag.ts`. Exports:

```typescript
export async function autoTagBullets(opts: {
    userId: string;
    postingKeywords: string[];
}): Promise<{ tagsAdded: number; bulletsAffected: number; durationMs: number }>;
```

Internals:
1. Load full profile via `lib/repositories/profile.ts:loadProfile(userId)` — WorkRoles + Projects + Educations with bullets.
2. Flatten bullets into `{ parentKind, parentId, bullet }` triples. Skip `excluded === true` bullets (no point tagging hidden ones).
3. Build prompt via `loadPrompt('bullet-tags-from-posting', { keywords: postingKeywords, bullets: flattened })`.
4. Call `chatJSON({ name: 'bullet-tags-from-posting', model: MODEL_LITE, maxOutputTokens: 2048, ...})`. Zod-validate the response shape.
5. Post-filter each proposal defensively: `proposal.addedTags = proposal.addedTags.filter(t => !bullet.removedTags.includes(t) && !bullet.tags.includes(t))` — defense-in-depth even though the prompt is also instructed to filter.
6. Drop proposals with empty `addedTags` after filter.
7. Apply merge per affected bullet:
   - `bullet.tags = [...bullet.tags, ...proposal.addedTags]` (dedup).
   - `bullet.autoTags = [...bullet.autoTags, ...proposal.addedTags]` (dedup; only new additions get the "auto" mark per Decision 6.3).
8. Persist via `prisma.$transaction` — one `WorkRole.update` / `Project.update` / `Education.update` per affected parent with its updated `bulletsJson`.
9. Return summary stats for trace logging.

Hallucination guardrails in the system prompt (additional to the no-fab rule in M8.5.2):
- "Output only the keywords you genuinely believe are evidenced by the bullet's text. Conservative is better than aggressive."
- "Do not propose tags already in the bullet's `tags` array."
- "Do not propose tags in the bullet's `removedTags` array."
- "Return an empty `addedTags` array for any bullet you're unsure about."

##### M8.5.4 — Wire auto-tag pass into POST `/api/resumes` ✅ (S8.9)

In `app/api/resumes/route.ts` POST handler, between `parsePostingFromInput()` and `selectBullets()`:

```typescript
// Auto-tag pass (S8.9) — write-through to profile before selection.
// Best-effort: errors logged but never block the generate.
try {
    const autoTagResult = await autoTagBullets({
        userId: session.user.id,
        postingKeywords: parsedPosting.keywords,
    });
    console.info(`[bullet-tags-from-posting] +${autoTagResult.tagsAdded} tags / ${autoTagResult.bulletsAffected} bullets / ${autoTagResult.durationMs}ms`);
} catch (e) {
    console.warn(`[bullet-tags-from-posting] skipped: ${errMessage(e)}`);
}
// Re-load profile so selection sees updated tags. (Or pass updated profile through directly.)
```

The reload-then-select sequence is intentional: profile mutation + read are not racy on the same request because the request is single-threaded; concurrent requests are gated by the existing `resumes:gen` per-user rate limit (5 / 10 min) so cross-request races are minimal.

##### M8.5.5 — Fold-in directive in `resume-rewrite` prompt ✅ (S8.10)

Modify `docs/llm-prompts/resume-rewrite.md`. Insert a new rule **6a** between rules 6 and 7:

> **6a. Posting-keyword fold-in.** When a bullet's `tags` list contains a posting keyword (i.e. `tags ∩ posting_keywords ≠ ∅`), prefer wording that uses that exact keyword verbatim — subject to all other rules (no invention, ≤25 words, strong action verb). If folding the keyword in would force the bullet awkwardly or violate rules 1–2, **leave the bullet unchanged**; do not force the keyword.

Push to Lunary registry via `npx tsx scripts/sync-lunary-templates.ts`.

Update `eval/suites/resume-rewrite.yaml`:
- New fixture: bullet `text: "Built a service in Python"`, `tags: ["Python"]`; posting keyword `"Python"` → assert rewritten text contains `"Python"` (case-insensitive substring).
- New negative fixture: bullet `text: "Built a service in Go"`, `tags: []`; posting keyword `"Python"` → assert rewritten text does NOT contain `"Python"` (no-invention).

No code change to `lib/resumes/rewrite.ts` — the prompt-template + fixtures cover this.

##### M8.5.6 — Tag-edit UI: "auto" badge + remove → blocklist ✅ (S8.9)

`components/ui/BulletRow.tsx` — tag rendering at lines 146–183:

- Tags in `bullet.autoTags` render with a small `Sparkles` icon (lucide) prepended **inside the chip** + cyan-tinted border (`border-cyan-500/30` replacing the default `border-white/10`). Title attribute: `"Auto-added — saves as a regular tag when you next save this bullet."`
- Tags **not** in `autoTags` render with current styling.
- `removeTag(tag)` updates the bullet payload as: `tags = tags.filter(t => t !== tag)`; `autoTags = autoTags.filter(t => t !== tag)`; `removedTags = [...new Set([...removedTags, tag])]`. **Any tag removal — auto or user-set — adds to the blocklist.** Symmetric and predictable. Manually re-adding a tag (via the existing "+ tag" input) removes it from `removedTags` as a side effect; document in the schema's PATCH validator.
- On bullet save (existing PATCH path): server-side validator clears `autoTags` to `[]` whenever the bullet body is touched (M8.5.1's schema `transform`). Implicit "next save" accept per Decision 6.3.

##### M8.5.7 — Selection trace shows auto-source tags ✅ (S8.9 — minor)

`GeneratedResume.selections` already records `matchedTags` per selected bullet (see schema). Auto-added tags appear here indistinguishably from user-set tags — which is the correct semantic; selection doesn't care about provenance. No code change required; just verify the trace surfaces correctly in M8.5.8's smoke.

(If you later want provenance in the trace — "this match was auto-tagged this run" — extend `selections` shape and `GenerateResumeCard.tsx`'s trace list. Not in scope for M8.5.)

##### M8.5.8 — Hermetic smokes ✅

- `scripts/tests/hermetic/auto-tag-smoke.ts` (covers M8.5.2 + M8.5.3 end-to-end):
  - Mocks `chatJSON` with fixture responses.
  - Asserts: positive case writes `tags` + `autoTags`; negative case writes nothing; blocklist filters out a proposal; already-tagged keyword doesn't get re-marked into `autoTags`; LLM call throwing → `autoTagBullets` propagates as error (M8.5.4 wraps it).
- `scripts/tests/hermetic/auto-tag-merge-smoke.ts` (covers M8.5.3 merge logic — pure function):
  - Test dedup, `removedTags` filter, `autoTags` only-new-additions semantic, the post-filter `addedTags.filter(t => !existing && !blocked)`.
- `scripts/tests/hermetic/bullet-remove-tag-smoke.ts` (covers M8.5.6 server-side):
  - PATCH a bullet with one tag removed → assert `removedTags` gains the removed tag (regardless of source); `autoTags` cleared after PATCH.
- `scripts/tests/hermetic/resume-rewrite-fold-in-smoke.ts` (covers M8.5.5 — Promptfoo handles the real eval):
  - Mocks `chatJSON` for the rewrite call; asserts the prompt body includes the fold-in directive when bullet has matching tags. Does NOT assert LLM output (that's M8.5.9's job).

All four wired into `scripts/pre-push.sh`'s `SUITES` array.

##### M8.5.9 — Promptfoo eval pass ✅

Run `npm run test:prompts` end-to-end after prompts + fixtures land. Expected:
- Two new `bullet-tags-from-posting` fixtures pass against `MODEL_LITE`.
- Two new `resume-rewrite` fold-in fixtures pass against `MODEL_FLASH`.
- Added Gemini spend ~$0.01 per full eval run.

If LITE fails the auto-tag fixtures (false positives proposing tags without evidence), bump to `MODEL_FLASH` in `lib/profile/auto-tag.ts:callBulletAutoTag` and re-run. Document the actual model picked in `docs/llm-calls.md`.

---

#### Acceptance (whole phase)

- Generating a resume against a Python-heavy posting auto-tags any bullet whose text already mentions Python (verified by inspecting the Profile dash after the run); no bullets without Python in their text gain the tag.
- Re-removing an auto-added tag from the Profile UI → next generate against the same posting does **not** re-add it.
- "auto" badge (Sparkles icon + cyan-tinted chip border) appears next to auto-added tags; falls off after the bullet is next saved.
- Rewritten bullet text contains the posting keyword verbatim where the bullet had the matching tag (manual sanity check on one real generate).
- `npm run test:hermetic` green; four new smokes wired into pre-push.
- `npm run test:prompts` green for the two new fixture suites.
- No regression in M8.4 surfaces: previous-resumes dropdown + Pipeline picker + segmented control all unchanged.

#### Out of scope

- **Per-tag accept button** for auto-tags — implicit-accept-on-save (Decision 6.3) is simpler and covers the review flow. Add explicit per-tag accept only if implicit proves confusing in real use.
- **Run-provenance log** (which generate run added which tag) — not stored. Trace UI from M8 Phase 2 already shows which keywords matched which bullets per generate; sufficient.
- **Confidence score per tag proposal** — the LLM returns binary add/don't-add. If false-positive rate is high in practice, revisit + store + display confidence.
- **Cross-profile bullet similarity grounding** — auto-tag prompt grounds only on the bullet's own text + posting keywords. Could improve with sibling-bullet context if quality is poor.
- **Cover-letter fold-in** — story S8.7 user-declined; no fold-in target.

---

### M8.6 — Resume-gen scratchpad synthesis ⏳

Story: **S7.13** (🟡 per-entity scratchpad) — second of two milestones covering this story. Added 2026-05-25, designed not started. **Ships third** of the new C-track wave (after M7.7 + M7.8). **Depends on M7.8's `scratchpad` columns being live.** New LLM callsite + new pipeline pass in resume-gen.

**Why now.** M7.8 puts user-voice scratchpad text on every entity. M8.6 puts that text to work at resume-gen time — when a posting's keywords aren't well-covered by an entity's structured bullets but the scratchpad mentions relevant work, synthesize fresh bullets that close the gap using posting terminology + scratchpad evidence. Mixes into the existing selection pool so the rewrite step can pick scratchpad-synthesized bullets when they're stronger evidence than what's in the structured profile.

**Surfaces touched.**
- New `lib/profile/scratchpad-synth.ts` — synthesis caller.
- New prompt `docs/llm-prompts/scratchpad-synth.md` + Promptfoo suite `eval/suites/scratchpad-synth.yaml`.
- `app/api/resumes/route.ts` POST handler — new synthesis pass between select (and auto-tag) and rewrite.
- `components/cards/GenerateResumeCard.tsx` `TraceList` — render `kind: "scratchpad-synth"` rows distinctly.
- `lib/resumes/skills-gap.ts` — count synthesized coverage as gap-closing.

**LLM model.** `MODEL_LITE` initially. Promote to `MODEL_FLASH` if Promptfoo evals show LITE under-uses scratchpad detail in synthesis.

---

#### Task list

##### M8.6.1 — Scratchpad-synth caller ⏳

New `lib/profile/scratchpad-synth.ts`:

```typescript
export async function synthesizeBulletsForEntity(opts: {
    entityKind: 'work-role' | 'project' | 'education';
    entityId: string;
    entitySpine: {
        company?: string;
        title?: string;
        name?: string;
        institution?: string;
        startDate?: string;
        endDate?: string | null;
    };
    scratchpad: string;          // non-empty (caller filters)
    postingKeywords: string[];
    uncoveredKeywords: string[];  // posting keywords with no existing bullet evidence
    maxBullets?: number;          // default 3
}): Promise<{ bullets: Array<{ id: string; text: string; tags: string[] }>; durationMs: number }>;
```

Internals:
1. Build prompt via `loadPrompt('scratchpad-synth', vars)`.
2. Call `chatJSON({name: 'scratchpad-synth', model: MODEL_LITE, maxOutputTokens: 2048, ...})`.
3. Zod-validate response shape.
4. Server fills bullet ids (cuid), defaults `autoTags: tags`, `removedTags: []`, `pinnedTags: []`, `locked: false`, `excluded: false`.

**Does NOT persist** — synthesized bullets exist only in the in-memory resume-gen selection list and in the `GeneratedResume.selections` archive. User's stored profile is untouched. (Persisting synthesized bullets back to the profile is a future story.)

##### M8.6.2 — Prompt + Promptfoo fixtures ⏳

New `docs/llm-prompts/scratchpad-synth.md`. System prompt enumerates:
- Output up to N bullets grounded ONLY on the scratchpad text + the posting's uncovered keywords + the entity spine.
- Use posting keywords VERBATIM where the scratchpad evidences the work.
- **No invention**: do NOT add metrics, dates, technologies, or claims that aren't in the scratchpad or the posting.
- If the scratchpad has no evidence for any uncovered keyword, return an empty array. **Conservative over aggressive.**
- Match the user's voice from the scratchpad — keep their cadence, don't over-formalize.
- Tag the synthesized bullet with concrete skills/technologies the bullet actually demonstrates (3–7 tags, same convention as M7.7.4).

New `eval/suites/scratchpad-synth.yaml`:
- **Positive coverage**: scratchpad mentions "ran the data pipeline migration to PostgreSQL"; posting needs "PostgreSQL" → assert synthesized bullet contains "PostgreSQL" + references migration work.
- **No-invention**: scratchpad mentions Go work; posting needs "Rust" → assert empty `bullets` array (no fabricated Rust experience).
- **Voice preservation**: scratchpad reads colloquially ("we hacked together a quick prototype"); assert synthesized bullet is professional but recognizably first-person-experience-derived, not generic resume-speak (rubric assertion).
- **Empty scratchpad guard**: handler should short-circuit before LLM (caller-level check) — covered in M8.6.3 smoke, not Promptfoo.

Provider handler in `eval/provider.ts:HANDLERS`.

##### M8.6.3 — Resume-gen pipeline: synthesis pass ⏳

In `app/api/resumes/route.ts` POST handler, after `selectBullets()` runs AND after the M8.5 `autoTagBullets` pass:

```typescript
// Compute uncovered keywords (skills-gap signal).
const uncovered = parsedPosting.keywords.filter(kw =>
    !selectedBullets.some(b => b.tags.includes(kw) || textEvidencesKeyword(b.text, kw))
);

// For each entity already represented in selection AND with non-empty scratchpad
// AND at least one uncovered keyword the scratchpad mentions (heuristic):
const synthesizedPromises = entitiesInSelection.map(async entity => {
    if (!entity.scratchpad?.trim()) return [];
    const relevant = uncovered.filter(kw =>
        entity.scratchpad!.toLowerCase().includes(kw.toLowerCase())
    );
    if (relevant.length === 0) return [];
    try {
        const result = await synthesizeBulletsForEntity({
            entityKind: entity.kind,
            entityId: entity.id,
            entitySpine: spineOf(entity),
            scratchpad: entity.scratchpad,
            postingKeywords: parsedPosting.keywords,
            uncoveredKeywords: relevant,
        });
        return result.bullets.map(b => ({
            kind: 'scratchpad-synth',
            sourceId: entity.id,
            sourceLabel: spineToLabel(entity),
            bulletId: b.id,
            originalText: b.text,
            rewrittenText: b.text,    // synthesized bullets pass through rewrite as-is on first emission
            score: 0,
            matchedTags: b.tags,
            matchedKeywords: relevant.filter(kw => b.text.toLowerCase().includes(kw.toLowerCase())),
            locked: false,
        }));
    } catch (e) {
        console.warn(`[scratchpad-synth] entity ${entity.id} skipped: ${errMessage(e)}`);
        return [];
    }
});
const synthesized = (await Promise.all(synthesizedPromises)).flat();
```

Synthesized rows append to the selection list. They flow through the existing rewrite step like any other selection (rewrite may polish further or leave alone — but rewrite is now text-only per M7.7.2 so tags are preserved). **Best-effort posture**: synthesis errors never block the generate, mirroring the auto-tag pass shape from M8.5.4.

##### M8.6.4 — Trace surface for `scratchpad-synth` ⏳

`components/cards/GenerateResumeCard.tsx` `TraceList`: existing renderer already iterates `selections[].kind`. Add a styling branch for `kind === 'scratchpad-synth'` — distinct color (suggest: amber chip for "user's own notes turned into a bullet" — visually distinct from purple `work-role` / cyan `project` / emerald `education` kinds, and from M8.5's `auto` Sparkles convention).

Update `SkillsGapBlock` so synthesized coverage counts toward closing the gap: a posting keyword evidenced by a `scratchpad-synth` bullet's `matchedKeywords` should not appear in the "skills gap" list. `lib/resumes/skills-gap.ts:computeSkillsGap` currently runs against the profile pre-synthesis — refactor to run post-synthesis against the full selection list (or compute twice: pre-synth for an internal audit signal, post-synth for user display).

##### M8.6.5 — Hermetic smokes ⏳

- `scratchpad-synth-smoke.ts` — covers M8.6.1 + M8.6.3 end-to-end. Mocks `chatJSON`. Asserts:
  - Synthesis pass fires only for entities with non-empty scratchpad (empty scratchpad → no LLM call).
  - Synthesis pass fires only when there's at least one uncovered keyword the scratchpad mentions (no relevant uncovered → no LLM call, no token spend).
  - Synthesized rows land in selections array with `kind: 'scratchpad-synth'` and the entity's spine as `sourceLabel`.
  - Resume-gen route still succeeds when synthesis throws (best-effort posture, mirrors M8.5.4 try/catch).
  - **Cross-entity scratchpad bleed prevented** — entity A's scratchpad never appears in entity B's synth prompt (verify by asserting the prompt body for entity B's synth call doesn't contain entity A's scratchpad string).

Wired into `scripts/pre-push.sh`'s `SUITES` array.

##### M8.6.6 — Promptfoo eval pass ⏳

Run `npm run test:prompts` after prompts + fixtures land. Expected:
- The four `scratchpad-synth` fixtures pass against `MODEL_LITE`.
- Added Gemini spend ~$0.01 per full eval run.

If LITE fails the positive-coverage fixture (e.g. fabricates technologies not in scratchpad) or the no-invention fixture, bump to `MODEL_FLASH` in `lib/profile/scratchpad-synth.ts` and re-run. Document the actual model picked in `docs/llm-calls.md`.

---

#### Acceptance (whole phase)

- Generate a resume against a posting with keywords your structured bullets don't cover; if those keywords appear in the relevant entity's scratchpad, the generated PDF/DOCX includes synthesized bullets that use the posting's terminology in your scratchpad's voice.
- "Why these bullets?" trace shows synthesized rows distinctly (amber `scratchpad-synth` kind chip).
- Skills-gap report doesn't double-count keywords that synthesized bullets now cover.
- Entity with empty scratchpad → no synthesis pass for that entity (no token spend).
- Synthesis throws for one entity → other entities still synth; resume still generates.
- `npm run test:hermetic` green; one new smoke wired into pre-push.
- `npm run test:prompts` green for the new fixture suite.

#### Out of scope for this phase

- **Persisting synthesized bullets back to the profile** — synthesized bullets exist only in the generated resume's selection record (already serialized in `GeneratedResume.selections`). User can copy-paste a winner into the entity's bullets via the Profile dash if they want to keep one.
- **Per-entity opt-in/opt-out of synthesis** — global on. Empty scratchpad already opts out; explicit per-entity toggle is YAGNI.
- **Cross-entity scratchpad synthesis** — scope is per-entity. Cross-entity narrative ("at Acme then at Beta I did X across both") doesn't fit single-entity-row bullet structure.
- **Synthesis without posting** — synthesis requires posting keywords as the targeting signal. Per-bullet on-demand scratchpad-driven bullet generation (no posting) overlaps with [[S7.7]] fill mode + scratchpad grounding (M7.8.5) — covered there.
- **Streaming synthesis to UI** — synthesis runs server-side as part of POST, no streaming. Total request time ~3–8 s on top of existing rewrite; acceptable.

---

### M9 Phase 1 — GitHub-driven project metrics ✅

Stories: S9.1, S9.2, S9.3 (🟡). Shipped 2026-05-15.

- Schema additions (migration `add_project_github_metrics`): `Project.githubRepo` (`owner/repo`), `Project.portfolio` (Boolean default false), `Project.metricsUpdatedAt`. `metrics` JSON already existed from M7.
- `lib/fetchers/github-public-fetcher.ts` — public GitHub REST only (Decision 5). Three calls per repo: `/repos/{o}/{r}`, `/repos/{o}/{r}/languages`, `/repos/{o}/{r}/commits?per_page=1` (the link-header `rel="last"` page approximates `commitsTotal`). Goes through `assertExternalHttpUrl` for symmetry with other fetchers. Errors returned, not thrown.
- `scheduler/jobs/github-metrics.ts` — new PM2 scheduler job at 6h cadence, with a 20h freshness gate inside so each repo is effectively refreshed daily. Skips projects without `portfolio=true` AND `githubRepo` set. Registered as the third job in `scheduler/index.ts`.
- API: `app/api/profile/projects/route.ts` POST/PATCH accept `githubRepo` (zod-validated as `[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`) and `portfolio`. Repository helpers + Prisma types updated.
- Resume template: `lib/resumes/templates/ats-plain.tsx`'s `formatMetricsLine()` renders e.g. "★ 142 · 2,300 commits over 14 months · Go / TypeScript / Python" under the project name when metrics are present. Skip threshold: stars only render at ≥ 5.

### M9 Phase 2 — GitHub UX polish ✅

- **Project portfolio toggle UI** ✅ — `components/ui/ProjectRow.tsx` has the portfolio checkbox + repo input so projects can be flipped to portfolio mode without going through Prisma.
- **M9.4 — Suggested-rewrites (story S9.4) ✅ shipped 2026-05-22.** `lib/profile/metric-deltas.ts:computeMetricDeltas(prev, next)` runs after every metrics refresh. Detects star-threshold crossings against `STAR_MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000]` (highest-only — 4→26 fires once at 25), primary-language flips, new ≥5%-share languages (filters out one-off shell scripts), and commit-count jumps ≥25% AND ≥10 absolute (so tiny repos don't churn). First-ingest (`prev === null`) is silent — only changes fire. Each delta dispatches a `kind='system' tier='standard'` notification with dedupKey `portfolio-rewrite:${projectId}:${type}:${milestone}` so a milestone never re-fires; the commit-jump uses `nextCommits` as the milestone so subsequent jumps key uniquely. Hermetic `metric-deltas-smoke.ts` (16/16).
- **M9.5 — README-as-source (story S9.5) ✅ shipped 2026-05-22.** `Project.readme` + `readmeUpdatedAt` columns (migration `add_project_readme`, both DBs). New `fetchGithubReadme(ownerRepo)` in `lib/fetchers/github-public-fetcher.ts` — separate from `fetchGithubRepoMetrics` so the metrics hot path stays at 3 API calls. `scheduler/jobs/github-metrics.ts` refreshes README weekly (independent cadence from the 20h metrics gate) — README failures don't tank the metrics refresh for the same project. Stored markdown is truncated at 16 KB at write time to bound row size. Resume rewrite prompt: new optional `ProjectReadmeContext` param on `rewriteBullets`; `app/api/resumes/route.ts` builds the context for project-source bullets actually in the selection (avoids paying tokens on READMEs that aren't surfaced) and slices an additional 2 KB excerpt per project before prompt assembly. Pure prompt builder extracted as `buildRewriteUserPrompt` so the README-context branch is unit-testable; hermetic `readme-prompt-smoke.ts` (13/13) covers no-ctx, empty-ctx, project-only inclusion, multi-bullet dedup (one README per project, not per bullet), selective inclusion (only sourceIds in the selection), truncation at the prompt limit, and empty-string-readme as no-readme.

---

## Track D — Mobile layout

First-class platform work: make the dashboard usable on a phone. **Shipped 2026-05-23 in `893628a`** — ~450 lines net across 11 files, no schema / API / repository / scheduler changes. The pre-existing desktop "card-on-a-canvas" frame (`max-w-7xl mx-auto bg-card/80 ... rounded-3xl p-12`) is preserved verbatim in `<DesktopShell>`; narrow viewports get a new edge-to-edge swipe-carousel `<MobileShell>` selected by `useEffectiveMobileLayout()`.

Not tied to a `user-stories.md` entry — this is platform UX rather than feature work — but treated as canonical phase work because the surface area (Dashboard shell, every view, Launchpad, NotificationBell) cuts across all three feature tracks and any future track ships into both shells from day one.

State of the tree (2026-05-23): all 8 phases shipped. Files added: `hooks/useMobileLayout.ts`, `components/dashboard/{DesktopShell,MobileShell,useDashCarousel,dashes}.tsx`. Files modified: `app/layout.tsx`, `components/Dashboard.tsx`, `components/providers/state/index.ts`, `components/overlays/LaunchpadOverlay.tsx`, plus three inner horizontal scrollers tagged `touch-pan-x` for MD-5.

### Decisions (2026-05-22)

- **Activation = viewport + override.** `matchMedia('(max-width: 768px)')` flips it on automatically; a `mobileLayoutPreference: 'auto' | 'force-on' | 'force-off'` field on the DevicePrefs slice lets the user pin it. Default `'auto'`. Pure viewport felt brittle (tablet edge cases, no desktop-testing escape hatch); pure toggle hurt first-mobile-visit UX before the user discovered the switch.
- **Hidden-nav access = tap-title + edge-swipe-down.** Tap the dash title at top opens a bottom-sheet Launchpad; an edge-swipe-down from the very top opens the same sheet (iOS-style redundancy, single discoverable surface). Library and AI Companion become rows inside that sheet — they have no other home once the bottom controls bar disappears.
- **Swipe model = real drag-with-finger carousel.** framer-motion `drag="x"` with `dragDirectionLock`; the active view tracks the finger and snaps to neighbor on release when `Math.abs(offset.x) > 50 || Math.abs(velocity.x) > 500`. Only `[prev, current, next]` mount at any time so the lazy-load argument from `Dashboard.tsx:16–23` (dev-worker memory floor) still holds.
- **MD-0 lands first as a standalone PR.** Viewport meta + safe-area-inset audit is independently verifiable (open `https://mc.local` on a phone, confirm device-width render) and decoupling it from the carousel rewrite makes regression triage cheaper.

### MD-0 — Viewport prep ✅

Standalone PR. Single file.

- Add a `viewport` export to `app/layout.tsx` alongside the existing `metadata` export (line 19): `width: 'device-width'`, `initialScale: 1`, `viewportFit: 'cover'`. The `viewportFit: 'cover'` is what lets the rest of the stack reach `env(safe-area-inset-*)` on notched iPhones.
- Audit fixed-position elements in `Dashboard.tsx` (`NotificationBell` top-right, bottom controls bar at line 249) for `env(safe-area-inset-bottom)` padding — once the viewport meta lands, the iOS home-indicator chin otherwise eats the controls bar.

Acceptance: load the Cloudflare-tunnel URL on a phone, confirm the layout renders at device width (not zoomed-out 980 px) and nothing fixed-positioned overlaps the home indicator.

### MD-1 — Detection + preference ✅

- New hook `hooks/useMobileLayout.ts`: `matchMedia('(max-width: 768px)')`, SSR-safe (returns `false` until mounted to avoid hydration mismatch).
- New field `mobileLayoutPreference: 'auto' | 'force-on' | 'force-off'` on `DevicePrefsSlice` in `components/providers/state/index.ts:98`. Default `'auto'`. Add to the `partialize` whitelist at line 173 so it persists in `app-state` localStorage. Bump `version: 7 → 8` and add a default-injection case to the existing `migrate` function at line 181 (existing users inherit `'auto'`).
- Composite `useEffectiveMobileLayout()`: if preference is `force-on`/`force-off` return that, else fall back to `useMobileLayout()`.

### MD-2 — Dashboard shell fork ✅

Refactor `components/Dashboard.tsx`:

- Extract the shared logic — `orderedDashes` memo (line 106), `currentIndex` state, the mount-effect (line 124), the `activeViewId` sync (line 165), the `nextSlide` / `prevSlide` / `goToSlide` callbacks — into a `useDashCarousel()` hook.
- Split rendering into `<DesktopShell>` (current JSX moved verbatim) and `<MobileShell>` (new). The top-level Dashboard becomes ~15 lines: `return isMobile ? <MobileShell {...carouselProps} /> : <DesktopShell {...carouselProps} />`.

No behavioral change on desktop — DesktopShell is a verbatim move.

### MD-3 — MobileShell ✅

New file `components/dashboard/MobileShell.tsx`. Drops the `max-w-7xl mx-auto bg-card/80 ... rounded-3xl p-12 pt-16 pb-4` wrapper entirely — the view renders edge-to-edge against the page background, with hue accent at the top edge and a page-dot row at the bottom.

```
┌─ top bar (h-12, hue accent) ───────────┐
│  Space                          🔔     │  ← title tap → Launchpad sheet
├────────────────────────────────────────┤
│                                        │
│   <SpaceView />   ← edge-to-edge       │
│                                        │
├────────────────────────────────────────┤
│         · · · ● · · · ·                │  ← page dots, hue-tinted
└────────────────────────────────────────┘
```

Carousel:

- Outer wrapper `<motion.div drag="x" dragDirectionLock dragConstraints={{ left: 0, right: 0 }} dragElastic={0.2}>`.
- Render only `[prev, current, next]`. The other 5 lazy chunks stay un-fetched until the user swipes near them — the same invariant that keeps the dev-worker memory floor honest.
- `onDragEnd`: snap to neighbor if `Math.abs(info.offset.x) > 50 || Math.abs(info.velocity.x) > 500`, else spring back to centre.
- `touchAction: 'pan-y'` on the outer container so the browser handles vertical scroll natively; framer-motion only intercepts horizontal.
- Edge-swipe-down: a 24 px-tall invisible strip pinned to `top: 0` with its own `onPanEnd` that opens the Launchpad sheet when `info.offset.y > 80`.

Bottom dots: 8 dots (one per dash, hue-tinted from `viewHues[currentDashId]`), active dot enlarged. Tap a dot to jump directly — cheaper than discovering the swipe gesture.

`NotificationBell` stays top-right at smaller scale; its existing `AnimatePresence` dropdown rerolls as a full-height bottom sheet on narrow viewports.

### MD-4 — Launchpad bottom sheet ✅

Add a `variant?: 'fullscreen' | 'sheet'` prop to `components/overlays/LaunchpadOverlay.tsx`.

- `'sheet'`: a `motion.div` rising from bottom to ~90 vh, rounded top corners, backdrop-blur. Drag-down on the handle dismisses.
- Body content (dash grid, reorder logic, edit-mode toggle) is unchanged — the existing JSX runs verbatim, just inside a sheet container instead of taking the canvas.
- Two new rows appended below the dash grid: "Library" (opens `SavedPapersOverlay`, currently the `Library` button at `Dashboard.tsx:265`) and "AI Companion" (the `MessageSquare` button at line 282, gated on `aiCompanionEnabled`). They have no home on mobile once the bottom bar is gone, so they live here.

Desktop keeps `variant="fullscreen"`. MobileShell's title-tap handler passes `variant="sheet"`.

### MD-5 — Inner-view audit ✅

A few horizontal scrollers inside cards may fight the outer carousel. Audit + verify each on a real device:

- `components/views/SpaceView.tsx:279` — lunar cycle strip (`overflow-x-auto`). Inside the swipe area; needs verification that the inner scroller's pointer capture wins below the 50 px outer threshold.
- `components/cards/ApplicationsKanbanCard.tsx` — kanban lanes have framer-motion card drag (already uses pointer capture, expected fine but real-device check).
- `components/grids/CardGrid.tsx:29` — already collapses to `grid-cols-1` at `< md:`, so masonry-style space-news views render single-column on phones with no further work.
- `components/Section.tsx:22` per-section `px-6` headers are fine as-is.

Strategy: rely on `dragDirectionLock` + the 50 px / 500 px · s⁻¹ outer threshold. Inner horizontal scrollers under that threshold keep the gesture by default.

### MD-6 — Preference UI ✅

Add a "Layout" segmented control inside the Launchpad sheet (Auto / Mobile / Desktop) bound to `mobileLayoutPreference`. Mirror on Internal Systems for grep-discoverability — that's where other device prefs already surface.

### MD-7 — Validation ✅

- Manual: iOS Safari on a real phone (notch handling, edge swipe, momentum). Chrome DevTools mobile emulation at 375 × 812. Desktop browser resized below 768 px.
- DevTools network panel: confirm only 3 dash chunks fetch at a time — the lazy-mount-neighbors invariant from MD-3.
- `npm run test:hermetic` stays green. The Dashboard isn't covered there but the suite should remain unaffected (no API, schema, or repository changes).

No new hermetic file. The carousel is gesture / animation behavior that DOM-level assertions can't meaningfully cover; verification is "feels right on a real phone."

### File touch estimate

| File | Change | Lines |
| --- | --- | ---: |
| `app/layout.tsx` | MD-0 — `viewport` export | ~5 |
| `hooks/useMobileLayout.ts` | new (MD-1) | ~30 |
| `components/providers/state/index.ts` | MD-1 — new field + v7→v8 migration | ~15 |
| `components/Dashboard.tsx` | MD-2 — extract `useDashCarousel()`, shell fork | ~80 net |
| `components/dashboard/MobileShell.tsx` | new (MD-3) | ~150 |
| `components/dashboard/DesktopShell.tsx` | extracted from Dashboard | ~140 |
| `components/overlays/LaunchpadOverlay.tsx` | MD-4 — `variant` prop + Library/AI rows | ~40 |

~7 files, ~450 lines net. No schema, API, repository, or scheduler changes.

---

## Cross-cutting

### Route auth hardening ✅

Cross-cutting security pass against the public Cloudflare-tunnel surface (`https://ms-prod.salsquared.xyz`). The intended model — "LAN trusts, tunnel requires session" via `lib/auth-guards.ts` — was correctly applied to 21 user-data routes (applications, watchlists, profile, resumes, etc.) but a 2026-05-15 audit found 19 read-side / SSE / external-data routes with no guard at all.

Shipped 2026-05-15 · Commit: `db8a9bf` · Smoke: `scripts/tests/hermetic/route-auth-smoke.ts` (57/57) · Wired into pre-push (suite 2 of 14).

**✅ Closed routes (19):**

- **`requireSession` — always-on, 4 routes.** Data class is too sensitive even for LAN bypass: SSE event stream + log ring buffer + a write-shaped enrich endpoint.
  - `/api/events` — streams every `{model, action, id, timestamp}` cross-row event.
  - `/api/system/logs` — streams the in-memory console ring buffer + new entries.
  - `/api/system/logs/historical` — reads the PM2 JSON log file.
  - `/api/research/import` — POST, accepts external IDs and enriches via Semantic Scholar + arXiv.
- **`requireLocalOrSession` — LAN skip, tunnel requires session, 15 routes.** Read-only external-data passthroughs cached via `withCache`. LAN dev tools / curl from the laptop keep zero friction; tunnel traffic gates against external-API quota drain.
  - `/api/system`, `/api/research`, `/api/research/historical`, `/api/research/review`, `/api/research/hf`, `/api/company-news`, `/api/ai`, `/api/ai/llmleaderboard`, `/api/finance`, `/api/finance/history`, `/api/space`, `/api/space/solar`, `/api/space/launches`, `/api/space/moon`, `/api/space/satellites`.
- **`withCache` wrapper pattern.** Routes wrapped in `withCache` use the guard-before-cached-handler pattern so the 401 happens before any external fetch / cache lookup:
  ```ts
  const cachedGET = withCache(getHandler, { ttlSeconds, upstreamHost });
  export const GET = async (req: Request) => {
      const guard = await requireLocalOrSession(req);
      if ('error' in guard) return guard.error;
      return cachedGET(req);
  };
  ```

**✅ Verified non-issues** (full grep of `app/api/**/route.ts` for missing guards):
- `app/api/auth/[...nextauth]/route.ts` — NextAuth itself; can't guard the guard.
- `app/api/gmail/webhook/route.ts` — verifies a Google-issued OIDC JWT against `PUBSUB_AUDIENCE` instead of a session (see `docs/hosting.md` §1).

**✅ Follow-up hardening (flagged by second-pass review, all shipped):**

- ✅ **RAH-1 — Host-header spoof defense in `requireLocalOrSession`.** Shipped 2026-05-16. LAN bypass now also requires that every hop in `X-Forwarded-For` is a loopback / RFC1918 / IPv6-private address. Cloudflare tunnel populates the leftmost XFF with the original public client IP — a LAN client (direct or via Next.js's internal proxy, which auto-adds `::1`) only ever shows local hops. New `isPrivateOrLoopback` helper handles IPv4 loopback, RFC1918, IPv4-mapped IPv6, and unique-local / link-local IPv6. Behavioral-tested via curl: LAN direct = 200, `Host: localhost` + `XFF: 8.8.8.8` = 401, LAN client at `192.168.1.5` = 200. `lib/auth-guards.ts:requireLocalOrSession`.
- ✅ **RAH-5 — `withCache` user-identity hook.** Shipped 2026-05-16. Added an optional `userKeyFn` to `WithCacheOptions` in `lib/cache.ts` — when set, the returned key is prepended to the cache key so per-user routes can opt into isolation. No current callers (all wrapped routes return shared external feeds), but the hook is in place for any future user-specific route.

#### Second-pass review (2026-05-16) — additional findings

Triple-track review on 2026-05-16 (mutating-route auth · data-leak / fs / external-calls · correctness / races / silent failures). All items below were spot-verified against the source before recording — speculative agent findings dropped.

**🔴 High** (real correctness holes — measurable wrong behavior or recovery hole):

**🟡 Medium** (real exploits, narrow impact today — single-user, LAN-trust, or cost-bounded):

- ✅ **RAH-10 — OIDC signer identity check.** Shipped 2026-05-16. After `verifyPubSubOIDC` returns, `app/api/gmail/webhook/route.ts` now asserts `payload.email === process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL && payload.email_verified === true`. When the env var is unset the route logs a warning and accepts (to not break existing deploys before the env is set) — populate it in `.env` per `docs/hosting.md` §1.
- ✅ **RAH-11 — Service-token bearer constant-time compare.** Shipped 2026-05-16. `lib/auth-guards.ts:requireServiceToken` now uses `crypto.timingSafeEqual` on equal-length buffers (length pre-check still fails fast without leaking length).
- ✅ **RAH-12 — Per-userId rate limit on Gemini-call routes.** Shipped 2026-05-22. New `lib/api/user-rate-limit.ts:checkUserRateLimit(scope, userId, now, opts)` sliding-window limiter — state on `globalThis` so HMR doesn't reset, scope-keyed so different routes don't share a budget, pure-function with caller-supplied `now` for testability. Rejected calls do NOT advance the bucket (a refresh loop won't permanently DoS itself). Wired into both `POST /api/resumes` ("resumes:gen") and `POST /api/profile/import` ("profile:import") at 5 calls per 10 minutes — generous for human use, tight against a stuck loop. Returns 429 with `Retry-After` header. Hermetic `user-rate-limit-smoke.ts` (14/14) covers first-call admission, cap-hit, window roll-off re-admission, per-user isolation, per-scope isolation, retry-after precision, and the "rejected calls don't count" invariant.
- ✅ **RAH-13 — Backups now encrypted with age.** Shipped 2026-05-22. `scripts/backup-db.sh` reworked: auto-discovers an age recipient at `~/.config/mission-control/backup.pub`, encrypts each artifact in place (DB hot-backup + resume-artifacts tar) before either local retention or rclone upload sees it, falls back to plaintext with a loud warning if no recipient is configured (so cron doesn't break before initial key setup) and fail-closes if a recipient is configured but `age` is missing. New `scripts/backup-decrypt.sh` companion auto-discovers the identity at `~/.config/mission-control/backup.key`. Local retention also prunes `.age` variants. CLAUDE.md §Backups + recovery rewritten with the one-time setup steps (brew install + age-keygen + 1Password store) and the recovery runbook (which now includes decrypt-from-Drive). Round-trip verified end-to-end against the live keypair on the setup machine.
**🔵 Low** (latent multi-user bugs, defense-in-depth, UX papercuts):

- ✅ **RAH-17 — `/api/notifications/test` rate limit.** Shipped 2026-05-16. 30s in-memory token bucket per userId; `globalThis`-attached so HMR doesn't reset it in dev. Returns 429 with `Retry-After` header.
- ✅ **RAH-18 — `/api/applications/events/adopt` user-scoped.** Shipped 2026-05-16. Duplicate-check now filters on `application.userId` so cross-user Gcal event IDs don't trigger spurious 409s.
- ✅ **RAH-19 — `PATCH /api/applications/events` drops `kind`.** Shipped 2026-05-16. The route handler ignores `parsed.data.kind` when building the update; schema still accepts it for client-compat but it's a no-op. Rewriting REJECTION → OFFER is no longer possible.
- ✅ **RAH-20 — `DELETE /api/calendar/event` requires MS tag.** Shipped 2026-05-16. The DELETE handler does a `calendar.events.get` first and refuses (403) if `extendedProperties.private[GCAL_EVENT_TAG]` is absent. Service-token callers can only delete events mission-control created.
- ✅ **RAH-21 — `safeRelative` rejects path separators.** Shipped 2026-05-16. `lib/resumes/storage.ts:safeRelative` now also throws on `normalized.includes(path.sep)`. Future callers can't quietly write nested directories under STORAGE_ROOT.

**ℹ️ Info — auth surface housekeeping:**

- ✅ **RAH-24 — `applications/backfill` uses `requireSession`.** Shipped 2026-05-16. Replaced inline `getServerSession` with the shared guard helper for grep-ability.

### Polish backlog ✅

Non-security follow-ups that don't fit a story-track milestone. RAH is reserved
for route-auth / security / abuse-prevention hardening; bug-correctness and UX
polish items live here. Add new items by appending at the bottom with a `PB-N`
(polish backlog) id.

**Migration table — old → new ids (2026-05-17 recategorization):**

| Old id | New id | Reason for move |
|---|---|---|
| RAH-2 | PB-2 | posting-digest off-by-one — correctness, not auth |
| RAH-3 | PB-3 | posting-digest fail-retry — correctness, not auth |
| RAH-4 | PB-4 | Skills-gap word-boundary parity — UX/correctness |
| RAH-6 | PB-5 | Gmail webhook crash recovery — correctness |
| RAH-7 | PB-6 | Pub/Sub messageId dedup — correctness |
| RAH-8 | PB-7 | `findApplicationByCompany` substring → exact — correctness |
| RAH-9 | PB-8 | Notification dedup unique constraint — correctness/race |
| RAH-14 | PB-9 | Resume artifact rollback — correctness |
| RAH-15 | PB-10 | Calendar sync timezone — correctness |
| RAH-16 | PB-11 | Skip notify on user POST — UX |
| RAH-22 | PB-12 | ASCII-sanitize headers — UX/correctness |
| RAH-23 | PB-13 | `middleware.ts` doc drift — documentation |

Source-code comments using `RAH-N` for moved items were updated to the new `PB-N` id in the same change. Commit history retains the original `RAH-N` labels; cross-reference via this table.

**🔴 High — open / unshipped:**

(none — all open PB-N items shipped 2026-05-17)

**✅ Shipped (historical — kept for traceability):**

- ✅ **PB-2 — posting-digest off-by-one.** Shipped 2026-05-16. Reworked the watermark logic in `scheduler/jobs/posting-digest.ts`: advance `lastDigestAt` to the MAX `firstSeenAt` actually included (not to `runAt`), and don't advance at all on empty windows. Eliminates the boundary collision where a new posting's `now()` could equal the just-advanced watermark and fail `gt: since`.
- ✅ **PB-3 — posting-digest fail-retry.** Shipped 2026-05-16. `scheduler/jobs/posting-digest.ts` now only updates `lastDigestAt` when `dispatchNotification` succeeds — a thrown dispatch leaves the watermark behind so the next tick re-includes the same window plus new postings.
- ✅ **PB-4 — Skills-gap word-boundary parity.** Shipped 2026-05-16. Ported the `matchesWord` helper from `lib/resumes/skills-gap.ts` to `lib/resumes/select.ts`. The bullet scorer now uses the same word-boundary regex (with symbol-edge substring fallback) so "ai" no longer score-matches inside "available".
- ✅ **PB-7 — `findApplicationByCompany` substring → exact.** Shipped 2026-05-16. Switched to `$queryRaw` with `LOWER(company) = LOWER(?)` for case-insensitive equality (SQLite doesn't support Prisma's `mode: "insensitive"`). Short LLM tokens like "AI" no longer match unrelated rows; case-only differences ("acme corp" vs "Acme Corp") still merge correctly.
- ✅ **PB-9 — Resume artifact rollback.** Shipped 2026-05-16. Inner try/catch around the write + row-update in `app/api/resumes/route.ts`. On update failure after a successful write, the orphan file is `unlink`'d and the row is marked `status="errored"` with the failure message captured.
- ✅ **PB-10 — Calendar sync uses server IANA timezone.** Shipped 2026-05-16. `lib/calendar/sync.ts` and `app/api/calendar/event/route.ts` now pass `timeZone: USER_TIMEZONE` (resolved once at module load from `Intl.DateTimeFormat().resolvedOptions().timeZone`) instead of hard-coded `"UTC"`. Mission-control runs on one Mac mini, so server tz === user tz.
- ✅ **PB-11 — User-created events no longer self-mail.** Shipped 2026-05-16. `app/api/applications/events/route.ts POST` no longer calls `maybeNotifyForApplicationEvent` — the ingest path (Gmail webhook) keeps it. Manual "I got an offer" entries don't fire a critical-tier email.
- ✅ **PB-12 — Resume response headers ASCII-sanitized.** Shipped 2026-05-16. `app/api/resumes/route.ts` filters `[^\x20-\x7e]` from `X-Resume-Title` / `X-Resume-Company` before setting headers. Em-dashes / accented chars no longer 500 the response.
- ✅ **PB-13 — CLAUDE.md `middleware.ts` claim dropped.** Shipped 2026-05-16. The "API routes + caching" section now correctly describes the observability surface: the in-app log viewer captures every server-side `console.*` (including the per-query `[DATABASE]` lines from the Prisma middleware in `lib/prisma.ts`). No `middleware.ts` exists at the repo root.
- ✅ **PB-14 — Directory→watchlist drift closed via `directoryKey` hydration.** Shipped 2026-05-17. Schema migration `20260517171844_add_watchlist_directory_key` adds nullable `Watchlist.directoryKey`. `lib/watchlists/hydrate.ts:hydrateWatchlistConfig` replaces the stored `config` JSON with the live `COMPANY_DIRECTORY` entry on every read (GET serializer + job-watcher fetch path). `resolveCreatePayload` overrides client-submitted config on POST when the key resolves (defense against stale clients). PATCH to `config` clears `directoryKey` so manual overrides stick. `scripts/archive/migrations/backfill-watchlist-directory-key.ts` keyed the 2 existing dev rows; hermetic smoke at `scripts/tests/hermetic/watchlist-hydrate-smoke.ts` (6/6) wired into pre-push.
- ✅ **PB-1 — Company-name normalizer.** Shipped 2026-05-17. New `lib/applications/normalize-company.ts:normalizeCompanyName` runs NFKC + whitespace collapse + leading "The " strip + iterative trailing-suffix strip (Inc / Corp / LLC / Co / Limited / GmbH / SA / SAS / BV / PLC / PBC / multi-word "Limited Liability Company" etc) + trailing-punct trim. Called in `lib/applications/ingest.ts` after classifier success, before both `findApplicationByCompany` and `createApplication`. Hermetic smoke at `scripts/tests/hermetic/normalize-company-smoke.ts` (28/28) — Bell Smoke / Bell Smoke Co / Bell Smoke Company / Bell Smoke, Inc. all converge to "Bell Smoke". Idempotent.
- ✅ **PB-5 — Gmail webhook crash-recovery via per-event checkpoints.** Shipped 2026-05-17. Schema migration `20260517181252_pb5_pb6_webhook_recovery` adds `ApplicationEvent.notifiedAt` + `gcalSyncedAt`. `lib/applications/ingest.ts` no longer hard-skips on `lastEmailMsgId === msgId` — instead re-fetches ALL events for `(applicationId, msgId)` after `createApplicationEvents` and fires notify/gcal only for events whose checkpoint is still null. Early skip preserved only when `events.length > 0 && every(eventFullyCommitted)`. `eventFullyCommitted` accounts for `NOTIFY_EVENT_KINDS` membership + future-vs-past `scheduledAt`. Also: webhook now catches per-msg throws so one bad email doesn't abort the batch. Hermetic smoke at `scripts/tests/hermetic/ingest-retry-smoke.ts` (7/7).
- ✅ **PB-6 — Pub/Sub messageId dedup + historyId checkpoint.** Shipped 2026-05-17. Same migration adds `WebhookDelivery(messageId @id, source, receivedAt)` table + `User.lastSyncedHistoryId`. `app/api/gmail/webhook/route.ts` does `INSERT OR IGNORE` on the envelope's messageId BEFORE any side-effect work — duplicate envelope = 200 + `deduped: true` immediately. `PubSubEnvelopeSchema.messageId` is now `.min(1)` required (was optional). Webhook resumes from `min(user.lastSyncedHistoryId, envelope.historyId)` so a multi-day outage doesn't lose messages (within Gmail's 7-day history window), and advances the checkpoint on every successful batch. Hermetic smoke at `scripts/tests/hermetic/webhook-dedup-smoke.ts` (3/3). Audit found and addressed: bare `messageId` schema being optional; per-msg uncaught throws aborting the batch; missing historyId checkpoint.
- ✅ **PB-8 — Notification dedupKey @unique.** Shipped 2026-05-17. Migration `20260517182000_pb8_notification_dedup_key` adds `Notification.dedupKey String? @unique`. `dispatchNotification` accepts optional `dedupKey`, catches P2002, returns `Notification | null`. New `utcDateBucket()` helper (UTC-anchored — DST-safe). Callers updated: `stale-applications` → `stale-nudge:${appId}:${YYYY-MM-DD}`; `deadline-nudges` → `deadline:${appId}:${YYYY-MM-DD}`; `posting-digest` → `posting-digest:${watchlistId}:${maxIncluded.toISOString()}` (keyed on batch watermark, not day, so legitimate second-cohort runs still fire); `job-watcher` per-posting → `posting:${postingId}`; per-event notify → `event:${eventId}`; closure-summary → `watchlist-closures:${watchlistId}:${YYYY-MM-DD}`. Hermetic smoke at `scripts/tests/hermetic/notification-dedup-smoke.ts` (9/9) including a concurrent Promise.all race test that confirms exactly one dispatcher wins. Audit found and addressed: SQLite null-vs-unique semantics, return-type null handling at every caller, posting-digest dedup granularity (day → watermark).
- ✅ **PB-15 — New-postings filter UI (type / remote / location).** Shipped 2026-05-17. Schema migration `20260517172344_add_posting_employment_type` adds `JobPosting.employmentType String?`. `lib/fetchers/employment-type.ts` exports `normalizeEmploymentType` (ATS field) + `inferEmploymentTypeFromTitle` (word-boundary regex, won't match "intern" in "international") + `pickEmploymentType` (combined). Wired into all six fetchers (Lever/Ashby use ATS field, Greenhouse/Workday/LinkedIn/careers-page use title heuristic). `components/cards/NewPostingsCard.tsx` got a Filters drawer: 5 employment-type chips, "Remote only" toggle, "Location contains…" free-text. Filter state persists on `useAppStore` (per-device via the existing `app-state` zustand persist; bumped version 1→2 with a migrate). Each row now shows its employment-type chip inline next to location. Hermetic smoke at `scripts/tests/hermetic/employment-type-smoke.ts` (31/31). Note: existing JobPosting rows have `employmentType=null` until next crawl re-extracts them.

### Dev-server perf + stability ✅

Cross-cutting cleanup pass against the **mission-control-dev** PM2 process. Symptoms (reported 2026-05-19): dev process climbing past 1 GB RSS at idle, CPU pegged at 100 % even with no foreground interaction, Safari occasionally reloading the page mid-use, and an unexplained pattern of `code [0] via signal [SIGINT]` exits stretching back to 2026-05-15 in `~/.pm2/pm2.log`. **Closed 2026-05-20** — all 9 originally-identified fixes + 4 follow-on bundle-side wins + a Turbopack flip shipped, with measured deltas at each step.

Investigation lives in [`docs/perf-profile.md`](./perf-profile.md); the ranked fix list mirrors that file. Production is unaffected (prod `mission-control` idles at ~50 MB and has the same SIGINT-exit pattern only when system memory pressure is high — i.e. PM2 → OS kill cascade, not an in-tree bug).

**Findings (2026-05-19, corrected 2026-05-20):**

- Dev worker RSS sample (via `/api/system`, which reads `process.memoryUsage()` *inside* the worker) with one browser tab open: **1.13 GB / 2 GB** `--max-old-space-size`, CPU **100 %**. Post-fixes-1–3 the same worker idles at ~700 MB after 3 hours uptime (38 % lower than baseline, but still high — the remaining queued fixes 4–6 are load-bearing, not optional).
- **Measurement gotcha:** `pm2 list` / `pm2 jlist` watch the **npm wrapper** PID, not the `next-server` worker that actually serves HTTP. The wrapper sits at ~54 MB regardless of worker load, so it'll quietly mislead you into thinking dev is healthy. The corrected `scripts/perf-monitor.ts` walks `ps -eo pid,ppid` to find the worker and reports both worker RSS and tree-total RSS (npm + next dev + worker).
- The dominant feedback loop is `lib/prisma.ts:$allOperations` → `console.info('[DATABASE] …')` → patched logger ring buffer (`lib/logger.ts`) → fan-out to every `/api/system/logs` SSE subscriber → Internal Systems dash recomputes `computeHealth` across 500 logs and rebuilds its `staticCards` JSX on **every push**. One HTTP request that runs ~5 Prisma queries produces ~5 full re-renders.
- `hooks/useServerEvents.ts` opens a fresh `EventSource` per call site (no sharing). Mount sites: `CacheInvalidationListener` (always), `NotificationBell` (always), plus 1–2 per active view. Two tabs on Applications = ~8 long-lived streams pinned in the dev process. Compounded by `next.config.ts: reactStrictMode: true`, which contradicts CLAUDE.md and double-mounts every effect in dev (every `useServerEvents` opens → closes → opens again).
- `CacheInvalidationListener` does a blanket `queryClient.invalidateQueries()` on every `'Cache'` SSE — every server-side `invalidateCacheKey()` refetches every active TanStack query on every connected tab.
- `/api/system` polls every 5 s from the Internal dash and runs a Prisma `pingDatabase()` per tick, feeding back into the `[DATABASE]` log loop.
- The SIGINT exit pattern is **clean** (`code 0`), not OOM/SIGKILL. Suspects: macOS sleep/wake (Mac mini, but configurable), pm2-logrotate (config inspected, rotation is benign at midnight), an external agent running `pm2 restart all` (no in-tree caller; `grep` clean), or system-memory-pressure kills surfaced as SIGINT to the npm wrapper. None reproducible on-demand — instrumented in fix 2 so the next event tells us where it came from.

**✅ Shipped (commits `dc85f44` → `faa410b`, all on `main`):**

- **Fix 1 — `[DATABASE]` log gated on `DEBUG_PRISMA=1` in dev** (`lib/prisma.ts`). Prod unchanged.
- **Fix 2a — `reactStrictMode: false`** (`next.config.ts`). Reconciled with CLAUDE.md's stated invariant; killed the per-mount EventSource double-open.
- **Fix 2b — SIGINT/SIGTERM/SIGHUP + uncaught/unhandled diagnostic** (`instrumentation.ts`). Caught one mystery restart in the wild (`Stopping app:mission-control-dev id:2` from PM2's IPC socket — another concurrent Claude Code session running `pm2 restart all`, not an in-tree bug).
- **Fix 2c — PM2 memory ceilings** (`~/salsquared/ecosystem.config.cjs`). `mission-control-dev: max_memory_restart: 1700M`, prod 900M, `min_uptime: 30s`, `max_restarts: 8`. *Caveat:* PM2 watches the npm wrapper, not the worker, so these caps are largely cosmetic for worker leaks. Useful for catching wrapper-level pathology.
- **Fix 3 — shared `/api/events` `EventSource`** (refcounted, auto-reconnect after the server's 60 s SSE timeout) — `hooks/useServerEvents.ts`. One stream per tab instead of N.
- **Fix 4 — `InternalView` memoised + `computeHealth` moved to a 5 s timer** — `components/views/InternalView.tsx`. Log buffer capped at 200 (was 500); rendered list capped at last 100.
- **Fix 5 — debounced `CacheInvalidationListener` (300 ms)** — `components/providers/CacheInvalidationListener.tsx`. Collapses scheduler-tick bursts into one refetch wave.
- **Fix 6 — `/api/system` caches `pingDatabase()` + `pulsarOnline` for 15 s** — `app/api/system/route.ts`. Eliminates the self-feeding telemetry poll loop.
- **Fix 7 — L1 cache expiry sweep** every 5 min — `lib/cache.ts`. Was unbounded prior.
- **Fix 8 — `[CACHE HIT/MISS]` + `[API Request]` muted in dev** unless `DEBUG_VERBOSE_LOG=1` — `lib/cache.ts`, `proxy.ts`. Caveat: Internal Systems "Fetcher Health" card reads empty in dev (relied on the log scrape) — Cache Telemetry card still works.
- **Fix 9 — Pulsar WS reconnect backoff** extended to 5 min after 10 failed attempts — `lib/pulsar-ws-relay.ts`. Was 30 s indefinitely.
- **Lazy-load dashes via `next/dynamic`** — `components/Dashboard.tsx`. Biggest single dev-floor lever; before, all 8 views compiled at boot.
- **Dropped `react-icons` (83 MB)** — `components/views/SpaceView.tsx` (moon icons → U+1F311 – U+1F318 unicode), `package.json`.
- **`experimental.optimizePackageImports`** for `lucide-react`, `framer-motion`, `@radix-ui/*` — `next.config.ts`. Compile-time barrel transforms.
- **`next dev --turbopack`** — `package.json`. Single biggest measured improvement once the above landed. Production `build` stays on webpack (verified path).

**Measurement infra (kept around for future work):**

- **`scripts/perf-monitor.ts`** — walks the PM2 process tree to the actual `next-server` worker (not the npm wrapper that `pm2 jlist` reports). Writes JSONL + markdown summary to `data/perf/`. Supports `MC_PERF_RESTART=1` for cold-baseline AB comparisons, `MC_PERF_PROCESS=mission-control` to switch to prod-tier observation.
- **`docs/perf-profile.md`** — the original investigation snapshot + the shipped-fix log + measured deltas.

**Final measured numbers** (cold 5-min idle, worker RSS, vs original baseline):

| Run | RSS median | RSS max | CPU max |
| --- | ---: | ---: | ---: |
| baseline (pre-fix) | 1263 MB | **1464 MB** | 14.8 % |
| **dev (Turbopack, all fixes)** | **722 MB** | **951 MB** | 73 % |
| prod (`mission-control`, webpack-built) | 279 MB | 387 MB | 13.5 % |

Total dev cut: −43 % median, −35 % max. The 100 % CPU peg is gone. Dev/prod ratio is now ~2.6 ×, normal for a Next app of this size.

### LLM observability + prompt registry ✅

Cross-cutting infra. Shipped 2026-05-24 (LOP-1 → LOP-11) in commits `d9ecd07` (infra: tracing + naming convention + Promptfoo scaffold) → `a02ace1` + `5089b88` (LOP-6 cutover: all 9 callsites moved off inline prompts onto `lib/ai/prompts.ts:loadPrompt`). One open caveat: **LOP-9 real-fixture capture** seam is live (`CAPTURE_FIXTURES=1` gate in `lib/ai/gemini.ts:chatJSON` + `lib/email-parser.ts`) but the starter fixtures in `eval/suites/*.yaml` are still synthetic-but-realistic; ~30 min of app use + harvest from pm2 logs will replace them with real captures. Today LLM calls fan out from 7 callsites through `chatJSON` in `lib/ai/gemini.ts` + 1 callsite (`lib/email-parser.ts`) that bypasses it via the Vercel AI SDK. Every prompt lives inline in code; every call is fire-and-forget aside from a single `[AI] ... tokens: ...` line in the log buffer. No way to A/B prompts, no way to regression-test a prompt change, no per-callsite cost breakdown beyond grepping logs.

This phase wires three things:
1. **Tracing** — every call (all 8 sites) lands in Lunary cloud free tier with input / output / model / token usage / latency, queryable + filterable per-callsite from their dashboard.
2. **Prompt registry** — system prompts + output-schema descriptions + task statements move from inline constants to Lunary templates fetched via `lunary.renderTemplate(slug, vars)`, versioned + A/B-able from the dashboard without code deploys. Dynamic sections (sibling lists, archive spans with byte caps, JSON-stringified inputs) stay computed in code and get passed in AS variables.
3. **Eval harness** — `eval/` directory with Promptfoo running fixture-driven regression tests against the live `chatJSON` wrapper, gated behind `npm run test:prompts` (NOT pre-push — burns real Gemini tokens).

**Why now (decided 2026-05-23):** §Prompt tuning below previously waited on "observe real user data, capture failure modes in free text". Lunary + Promptfoo close that loop — every real call gets traced, and observed failures fold into the eval suite as fixtures + assertions rather than disappearing into prose. Expected ongoing cost: ~$1–5/month Gemini eval budget at 9 names × 3 fixtures × manual-trigger cadence; Lunary free tier covers traces.

**Data posture:** Lunary cloud (managed). User-approved 2026-05-23 — only resume + posting text + bullet content flows through; no Gmail body, no Application timeline metadata. Self-hosted Lunary considered + rejected (Postgres + Clickhouse stack too heavy for one-Mac-mini infra). Switching off Lunary cloud later means swapping `lunary.init({ publicKey })` for a self-host URL; no code at call sites changes.

**Naming convention:** every `chatJSON` call gets a required `name: string` field — stable kebab-case identifier per callsite. Used as the run name in Lunary, the Promptfoo suite key, and the prompt-registry slug. The 9 names are:

| Callsite file | Name |
|---|---|
| `lib/email-parser.ts` | `email-parser` |
| `lib/ai/classify-employment-type.ts` | `employment-type-classifier` |
| `lib/discovery/suggest.ts` | `discovery-suggest` |
| `lib/resumes/posting.ts` | `posting-parse` |
| `lib/resumes/rewrite.ts` | `resume-rewrite` |
| `lib/profile/bullet-assist.ts` (mode: fill) | `bullet-assist-fill` |
| `lib/profile/bullet-assist.ts` (mode: rewrite) | `bullet-assist-rewrite` |
| `lib/profile/import-llm.ts` | `profile-import` |
| `lib/profile/synthesize.ts` | `profile-synthesize` |

9 names for 8 files — bullet-assist traces as two distinct names because fill and rewrite have meaningfully different prompts + output schemas; A/B'ing them separately is a near-term goal.

**Ship order:** infra first (LOP-1–LOP-3, no behavior change), then mass-update callsites (LOP-4–LOP-5), then template migration per-callsite as the user iterates (LOP-6, can land in batches), then Promptfoo skeleton (LOP-7–LOP-9), then docs (LOP-10–LOP-11).

---

#### Task list

##### LOP-1 — Install + init Lunary SDK ✅

- `npm install lunary` (TS SDK, MIT, ~30 KB minified).
- `LUNARY_PUBLIC_KEY` added to `.env` (untracked) per the existing pattern — sign up at lunary.ai → create project → copy public key.
- `instrumentation.ts` gets `if (process.env.LUNARY_PUBLIC_KEY) lunary.init({ publicKey })` next to `initLogger()`. Guarded on env presence so dev tier + test runs without the key emit nothing to Lunary's servers — symmetrical with how `EMAIL_ENABLED=0` mutes Gmail sends in dev.

##### LOP-2 — Required `name` on `ChatJSONOptions` ✅

`lib/ai/gemini.ts` `ChatJSONOptions<T>` gains required `name: string`. Forcing it required (not optional) means TypeScript flags every callsite — no quiet "unnamed" runs leak into Lunary. Naming convention enforced via the inventory table above plus a row in `docs/llm-calls.md` (see LOP-10).

##### LOP-3 — Wrap inner `generateContent` with `lunary.wrapModel` ✅

In `chatJSON`, the `client.models.generateContent({...})` call inside `withRetry` is replaced by a `lunary.wrapModel(...)`-wrapped function. Parser mapping:
- `nameParser` → `args.name` (the per-call name from LOP-2).
- `inputParser` → ChatMessage shape: optional `{role:'system',text}` + `{role:'user',text}`.
- `extraParser` → `{ model, temperature, maxOutputTokens }` for filter+search in Lunary's dashboard.
- `outputParser` → `{role:'ai',text}` from the response text.
- `tokensUsageParser` → `{prompt, completion}` from `res.usageMetadata`.

Existing retry + rate-limit + Zod validation surround the wrapped call unchanged — observability sits below them so retries trace as separate runs but share a parent name. `withRetry` and `acquireGeminiSlot` are never instrumented; they're flow-control, not LLM events.

##### LOP-4 — Pass `name` at every chatJSON callsite ✅

Mass mechanical edit — 7 chatJSON callers each gain `name: '<kebab-case-id>'` per the inventory above. Bullet-assist has a single `chatJSON` call but selects between `bullet-assist-fill` and `bullet-assist-rewrite` by `mode` so they show up as separate runs in Lunary. Compiler-driven — TypeScript flags the misses after LOP-2 lands.

##### LOP-5 — Trace email-parser (bypasses chatJSON) ✅

`lib/email-parser.ts:parseApplicationEmail` uses the Vercel AI SDK directly (`generateObject` from `ai` package) so it doesn't pick up LOP-3's wrap. Wrap manually with `lunary.trackEvent('llm', 'start'/'end'/'error', {...})` around the `generateObject` call:
- `runId` derived from the Gmail message id for trace correlation across retries.
- `name: 'email-parser'`.
- `input` = the truncated email body that goes into the prompt.
- `output` + `tokensUsage` populated from `generateObject`'s return.
- Error case fires `'error'` event and re-throws.

Defensively guarded — failures in `trackEvent` itself must not block ingest. Wrap the trackEvent calls in a try/catch that logs warn-and-continue.

##### LOP-6 — Migrate static prompts to Lunary template registry ✅

All 9 callsites cut over 2026-05-24 in a single pass (no longer incremental — went big-bang). Mechanism:
1. **Upload script** `scripts/sync-lunary-templates.ts` parses every `docs/llm-prompts/<slug>.md`, extracts the system + user template + extra (model/temperature/max_tokens), and POSTs to Lunary's REST API. Idempotent: GET /templates, compare latest version (key-sorted JSON-compare to handle Lunary's response-shape reordering), POST a new version only when content diverges. Auth: `LUNARY_SECRET_KEY` (private API key from dashboard → Settings, distinct from the public/tracing key).
2. **Runtime helper** `lib/ai/prompts.ts:loadPrompt(slug, vars)`. Prefers Lunary's `renderTemplate` when `LUNARY_PUBLIC_KEY` is set, falls back to parsing `docs/llm-prompts/<slug>.md` from disk when unset OR when the Lunary call throws. Returns `{ system?, user, model?, temperature?, maxOutputTokens? }`. Disk fallback is what makes hermetic smokes work without a Lunary account AND protects production through transient Lunary API blips.
3. **Per-callsite changes** — each previous inline `SYSTEM_PROMPT` constant + `buildUserPrompt` function replaced with `const prompt = await loadPrompt(slug, vars); chatJSON({ system: prompt.system, user: prompt.user, ... })`. Model + temperature + maxOutputTokens stay explicit in code (auditable in source rather than depending on Lunary's stored values for safety).
4. **`buildBulletAssistPrompt` became async** — it loops the registry renderer (drop archive → siblings → readme on overflow) so the 8 KB budget is enforced against the live template that will be sent. Smoke + `/api/profile/bullets/assist` route + Promptfoo provider all gained `await`.
5. **Dashboard model dropdown caveat**: Lunary's UI dropdown only knows its built-in OpenAI/Anthropic SKUs; our `gemini-3.x` strings show as a fallback like "gpt-5.5". The actual `extra.model` value is stored correctly and returned by `renderTemplate`. The dashboard's playground / built-in eval features are unusable for our model fleet — `npm run test:prompts` (Promptfoo) is the eval path instead.

Iteration workflow post-cutover: edit prompt in Lunary's dashboard → mirror to `docs/llm-prompts/<slug>.md` same-day, OR edit the .md and run `npx tsx scripts/sync-lunary-templates.ts` to push.

45/45 hermetic green after cutover. Promptfoo harness verified via dry-run earlier in the day.

##### LOP-7 — Extract prompt blobs for Lunary copy-paste ✅

New dir `docs/llm-prompts/` with one `.md` per callsite. Each file contains the system + user template text in Lunary's variable-substitution format ready to paste into their UI. Acts as:
- The migration source-of-truth artifact during LOP-6 rollout.
- A versioned snapshot of registry contents that survives a Lunary outage / migration to self-host.
- A grep-friendly local copy for "what does the prompt currently say?" without dashboard round-trips.

Updated as part of every prompt edit going forward — disk copy stays canonical, Lunary is the runtime live copy. Diff via `git log -p docs/llm-prompts/<slug>.md`.

##### LOP-8 — Scaffold Promptfoo `eval/` directory ✅

- `eval/provider.mjs` — single custom JS provider that imports `chatJSON` and dispatches per-callsite by the `vars.name` field. Returns `{ output: JSON.stringify(result) }` or `{ error }`. Handles the `messages`-shape vs `system+user`-shape branch for mid-migration callsites.
- `eval/promptfooconfig.yaml` — one suite per callsite (9 total per the name table). Each suite references `file://./provider.mjs` + a fixture dir + assertions.
- `package.json` — new `test:prompts` script: `promptfoo eval -c eval/promptfooconfig.yaml`. **NOT** wired into `pre-push.sh` — burns real Gemini tokens (~$0.05/full-run at 9 × 3 fixtures × MODEL_LITE); pre-push stays hermetic.
- `.gitignore` — `eval/results.json`, `eval/output/`.

##### LOP-9 — Capture starter fixtures + write assertions ◐ (seam shipped; real-capture harvest still pending)

For each callsite, 2–3 representative fixtures captured from real runs. Per fixture:
- `eval/fixtures/<name>/<scenario>.json` — input shape (whatever the prompt builder consumes: `BuildBulletAssistPromptInput`, posting raw text, etc.) + optional expected-output snapshot.
- Assertions stack:
  - `is-json` (always — every callsite is structured-output).
  - Schema-shape `javascript` assertion (e.g. `bullets.length >= 3 && bullets.length <= 5 && bullets.every(b => b.text && Array.isArray(b.tags))`).
  - `llm-rubric` for qualitative checks (e.g. "no invented quantitative claims; no first-person pronouns; preserves original tense"). Judge model points at `MODEL_LITE_CHEAP` to keep eval cost low (~$0.001/rubric).

Capture path: gate `console.info('[FIXTURE]', JSON.stringify({ name, system, user }))` inside `chatJSON` behind `CAPTURE_FIXTURES=1`, use the app for ~30 min, grep + manually clean into `eval/fixtures/`.

##### LOP-10 — Update `docs/llm-calls.md` ✅

- Add an "Observability" section noting Lunary integration, the `name` field convention, the `renderTemplate` migration path, and the Promptfoo eval workflow.
- Inventory table gains a "Lunary slug" column + a "Template migrated?" status column. Cross-references this section for the canonical naming list.

##### LOP-11 — `CLAUDE.md` additions ✅

New subsection under "Gemini rate limiting + model fleet" → "LLM observability". Captures the three invariants:
- Every new `chatJSON` caller MUST pass `name`. TypeScript enforces this; the inventory table in this section is the canonical list.
- Every prompt iteration goes through `loadPrompt` (which routes Lunary's `renderTemplate` → disk fallback), not inline string edits in code.
- Prompt changes that affect output shape must come with a Promptfoo fixture + assertion update; run `npm run test:prompts` before pushing prompt changes.

---

#### Acceptance (whole phase)

- 9 distinct names visible in Lunary's runs dashboard within 24 h of mainline rollout (post-LOP-4 / LOP-5), each with token + latency stats per call.
- All 9 prompts editable in Lunary's UI; runtime calls fetch via `renderTemplate` (post-LOP-6, per-callsite acceptance).
- `npm run test:prompts` runs end-to-end against all 9 callsites with ≥ 2 fixtures each; failures emit diffable output to `eval/output/`.
- Pre-push hook unchanged — no real Gemini in pre-push, no new hermetic suites required for this phase.
- `docs/llm-calls.md` + `CLAUDE.md` reference the system.

#### Out of scope for this phase

- Self-host Lunary — managed cloud is the chosen tier; swap is a one-line `lunary.init` change later if data posture shifts.
- Embeddings or eval-based scoring beyond `llm-rubric` (e.g. semantic similarity, BLEU, ROUGE — overkill for our prompt sizes + iteration cadence).
- Automated prompt optimization (DSPy, GEPA, OPRO — flagged for review only when iteration ceiling hits).
- CI gating on prompt regressions — `npm run test:prompts` stays manual / on-prompt-edit only. The token cost + flakiness of `llm-rubric` judges makes auto-gating expensive and noisy.
- Replacing the `[AI] tokens=` log line — Lunary is additive observability, not a replacement for in-process logs.
- A separate Lunary "user" identifier per session — single-tenant app, every call is the same user.

#### Prerequisites (user-side)

- Sign up at lunary.ai → create project → copy public key. Free tier sufficient for current call volume.
- Add `LUNARY_PUBLIC_KEY=<key>` to `.env` (untracked per `.env*` gitignore convention).
- For LOP-6 per-callsite migration: paste each `docs/llm-prompts/<slug>.md` into Lunary's template UI with the matching slug. Code rewrite + cutover happens in a follow-up commit per callsite.

### Prompt tuning ⏳

Not a milestone; an ongoing concern. Needs real user data (real resume + real posting) to evaluate, so it's blocked on the user actually applying. Capture failure modes in this section as they're observed:

- *Observed 2026-05-15*: `"applying web development best practices"` — generic filler, no posting hook. Tighten the rule against "applying" + adjective generic-noun patterns.
- *Observed 2026-05-15*: `"web development"` was emphasized in a rewrite because the posting used the phrase even though the original bullet's tags were `typescript`/`nextjs`. Re-confirm prompt rule 6 ("prefer posting wording where the concept matches") isn't being over-applied to generic words.

### Decision log

The five canonical decisions live in `user-stories.md`. Implementation has revealed two extra:

- **Gemini default model = `gemini-3.5-flash`** (2026-05-19). Explicitly pinned to the version released today. Previously used the `gemini-flash-latest` alias (2026-05-15 → 2026-05-19), which was 30–42% faster than the prior `gemini-2.5-flash` pin. Switched to explicit pin so future model bumps are deliberate code changes rather than silent shifts in behavior + free-tier quota class. Override per-call by passing `model` to `chatJSON`.
- **DOCX converter = `html-to-docx`** (2026-05-15). Considered `docx` (lower-level builder) and `mammoth` (reverse direction). Picked html-to-docx so the same React template HTML feeds both PDF and DOCX with zero divergence.

### Smoke matrix

| Smoke | Tier | Coverage |
| --- | --- | --- |
| `profile-repo-smoke.ts` | DB | `findOrCreateProfile` + CRUD + bullet round-trip |
| `profile-api-smoke.ts` | HTTP | All `/api/profile/*` routes + SSE broadcasts |
| `profile-import-smoke.ts` | E2E | PDF + DOCX → LLM extract → merge → DB |
| `applications-api-smoke.ts` | HTTP | Application CRUD + auto STATUS_CHANGED + NOTE events |
| `resume-select-smoke.ts` | unit | Bullet selection scoring |
| `resume-render-smoke.ts` | E2E (no AI) | Template → PDF only |
| `resume-e2e-smoke.ts` | E2E | Full PDF generation through Gemini + puppeteer |
| `resume-docx-smoke.ts` | E2E | Full DOCX generation, mammoth round-trip |
| `watchlist-e2e-smoke.ts` | E2E | Watchlist → fetcher → scheduler → posting → notification |

All smokes assume the dev PM2 process (`mission-control-dev`) is online on `:4101`.
