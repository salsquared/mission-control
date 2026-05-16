# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Companion docs:** [`docs/user-stories-applications.md`](./user-stories-applications.md) (what + why) · [`docs/implementation.md`](./implementation.md) (how + in what order, with milestone status + concrete schema / API / file shapes). This file points at the next concrete thing to do; the others are the canonical references.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-15
- **Branch:** `main`. M7/M7.4/M8 Phase 1+2 ✅, MA ✅, MB Phase 1+2a ✅, M9 ✅. Post-MVP polish in progress — global notification dispatcher, Workday/LinkedIn fetchers, EMAIL_ENABLED kill-switch, and watchlist negative filters all shipped. Hermetic pre-push gate at 9 suites green.
- **Last commits on main:**
  - `90cf9ec fix(email): EMAIL_ENABLED master kill-switch — stop pre-push spam`
  - `1ec936b feat(discovery): Workday + LinkedIn fetchers + kill M8-3.1/3.2`
  - `90398d7 feat: stale-app nudges + portfolio toggle UI + pre-push hermetic gate`
  - `941d3db refactor(notifications): central dispatchNotification API + tier model`
  - `c5c8905 feat(notifications): global bell + re-enable application-event email dispatch`

## Umbrella goal

**Finish `docs/user-stories-applications.md` so the user can apply to jobs and internships ASAP.** That doc is the canonical roadmap — three independent tracks (Track A: pipeline UX; Track B: job discovery + notifications; Track C: profile + resume generation + GitHub). Don't re-derive the plan here; consult that file for milestone definitions (MA, MB, M7, M8, M9).

**Top-level priority order** (chosen for "apply ASAP"):
1. ✅ **M7 — Profile spine** (Track C). Shipped 2026-05-14 in `0367263` + `e41b6c0`.
2. **M8 — Tailored resume generation** (Track C). *Current focus.* Detailed plan in `docs/user-stories-applications.md` §M8. Phase 1 produces the first sendable PDF.
3. **MA — Pipeline writes + drill-in** (Track A). So applications the user *sends* get tracked end-to-end (manual add, status drag, timeline, notes).
4. **MB — Watchlists + notifications** (Track B). Hunts for new postings. Lower urgency than M8 — the user can hand-source openings; what they can't easily do is hand-tailor a resume per posting.

Out of scope until top-of-stack ships: AI Companion prompt tuning, visual polish, M9 (GitHub-driven project metrics).

## Critical path — current

**Real-world use → first applied posting → iterate on prompts.** Track C core is done end-to-end.

## Immediate next actions (in order)

Full audit on 2026-05-15: **all 🔴 must-haves shipped (16/16); 21/25 🟡; 2/13 🔵.** See `docs/user-stories-applications.md` for the canonical map. Remaining 🟡 + load-bearing 🔵 work, ranked by leverage:

1. **Story 26 — per-watchlist notification preferences (🟡).** Add `notificationMode: 'each' | 'digest'` to `Watchlist`, daily digest scheduler job. Why next: LinkedIn + Workday produce high-volume noisy feeds and there's no quiet mode today.
2. **Story 37 — second resume template (🟡).** Single-column + two-column variants alongside `ats-plain.tsx`. UI picker on `GenerateResumeCard`. Why next: small surface, immediate visible polish on the artifacts the user actually sends.
3. **Story 41 — skills-gap report (🔵).** Posting keywords minus the union of profile bullet tags + bullet-text substrings. Surface on `GenerateResumeCard` post-gen. Cheap data-side, complements story 35's trace.
4. **Story 33 — profile snapshots (🔵).** One `ProfileSnapshot(userId, takenAt, payloadJson)` table + a "Snapshot now" button. Button-press-only — no auto-snapshotting on every edit. Roll-back UX deferred.
5. **Open 🔵 tail** (not in critical path): 24 comp parsing, 28 quiet hours, 45 suggested portfolio rewrites, 46 README ingestion, 48 resume diff, 50 recruiter contacts. Pick opportunistically.

**Genuine MVP-followup TODOs (cross-cutting, not story-numbered):**
- LLM-judged fuzzy bullet dedup (current dedup is exact-text only — "Built a TS API" and "Built a TypeScript API" both survive).
- LinkedIn export ZIP import support (separate unzip path that reads `Positions.csv` / `Education.csv`).
- Legacy `.doc` import format (mammoth handles `.docx` only).
- Per-file progress streaming via SSE so the UI shows "extract → analyze → merge" stages live instead of one long spinner.

## In-progress work

Nothing active. Story-status audit refreshed 2026-05-15 — `user-stories-applications.md` now carries ✅ / ◐ / ⛔ markers per story. Drift between code and doc is reconciled.

## Recently completed

- **2026-05-15** — Tunnel auth patch. Closed 19 unguarded API routes. `/api/events`, `/api/system/logs`, `/api/system/logs/historical`, `/api/research/import` → `requireSession` (always-on). `/api/system`, `/api/research/*` (list/historical/review/hf), `/api/company-news`, `/api/ai`, `/api/ai/llmleaderboard`, `/api/finance` (+ history), `/api/space/*` (5 routes) → `requireLocalOrSession` (LAN skip, tunnel requires session). Structural smoke `scripts/tests/route-auth-smoke.ts` (57/57) locks in import + call-site presence so guards can't be silently dropped. Pre-push now 14 suites.
- **2026-05-15** — Doc audit + status reconciliation (this entry). Walked every 🟡 / 🔵 story against the codebase: 21 🟡 actually shipped vs 25 total; 2 🔵 shipped (23 negative filters, 51 multi-kind). Real open list shrank from ~10 to ~10 (different 10 — 26, 33, 37 are real 🟡 gaps; 24, 28, 41, 45, 46, 48, 50 are real 🔵 gaps).
- **2026-05-15** — Track-as-application NOTE timeline anchor (`a668dbb`). Story 20 polish. Route body lifted into `lib/postings/track-as-application.ts`; hermetic smoke (18/18) covers cross-user isolation + idempotent re-call + non-duplicating NOTE event. Wired into pre-push (now 10 suites).
- **2026-05-15** — Watchlist negative filters (story 23, `9da9a2d`). `Watchlist.negativeFilters String?` JSON regex array. `/api/postings` GET filters case-insensitively against title+snippet+location; `?includeFiltered=true` bypass. Expandable editor on WatchlistsCard with regex validation. 18-step hermetic smoke.
- **2026-05-15** — EMAIL_ENABLED master kill-switch (`90cf9ec`). Single env gate at `lib/email/send.ts` short-circuits Gmail send. 0 in `.env.development` + `scripts/pre-push.sh`, 1 in `.env.production`. Stops test email spam without ripping out the dispatch wiring.
- **2026-05-15** — Workday + LinkedIn fetchers (`1ec936b`). Workday tenant POST (Boeing + Blue Origin verified live), LinkedIn guest scraper. Workday gotchas locked in: PAGE_SIZE=20 (server cap), per-page AbortSignal, `total` only on first page, Chrome UA mandatory.
- **2026-05-15** — Stale-app nudge job + portfolio toggle + pre-push hermetic gate (`90398d7`). simple-git-hooks running ~9 suites in 3-5s before every push.
- **2026-05-15** — Central notification dispatcher + global bell (`941d3db`, `c5c8905`). Tier-based (critical/standard/low) → channels mapping. Critical-tier pinning + red border in the bell overlay.

## Known issues / parked TODOs

- **Manual UI smoke** is still nominally outstanding (eyeball the Profile dash, confirm cards render / drag-reorder works / Import + Generate cards look right, sanity-check `viewHue: 280`). Backend pipe is verified end-to-end so this is low-risk visual confirmation.
- **LLM fuzzy bullet dedup** — current merge dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity when this becomes painful.
- **LinkedIn export ZIP** — separate unzip path reading `Positions.csv` / `Education.csv`; not wired yet.
- **Legacy `.doc`** — mammoth handles `.docx` only. Either skip or wire a converter.
- **`viewHue: 280`** for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts`.
