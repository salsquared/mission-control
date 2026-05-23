# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Companion docs:** [`docs/user-stories-applications.md`](./user-stories-applications.md) (what + why) · [`docs/implementation.md`](./implementation.md) (how + in what order, with milestone status + concrete schema / API / file shapes). This file points at the next concrete thing to do; the others are the canonical references.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-22
- **Branch:** `main`. **MB Phase 4 — side-work pipeline** shipped as commit `d2cb49f`: parallel "side" track alongside career for gig / blue-collar applications. Driven by user context (security guard at Crypto Arena DTLA, wants a second pipeline for pay-the-bills work without diluting career kanban). 21 files / +460 / −64. New `track` column on both `Watchlist` and `Application` (default `"career"`), expanded dedup constraint to `@@unique([userId, normalizedCompany, track])` so the same employer can coexist in both tracks. Migration `add_side_track` applied to dev.db + prod.db; 37 existing watchlists + 37 applications all defaulted cleanly to career. Cold Gmail ingest hard-coded to `track="career"` (no LLM classification — user reclassifies via the inline Track toggle in `ApplicationDetailOverlay`). Track-as-application inherits track from the parent watchlist. ApplicationsView mounts two new Sections below the existing career sections: "Side Pipeline" (kanban only — calendar + account-status shared above) and "Side Discovery" (will house side WatchlistsCard + NewPostingsCard once the in-flight refactor lands). AddWatchlistModal on side track hides the "Watch company" + "Discover" tabs (career-curated COMPANY_DIRECTORY would muddle the keyword-first side pipeline per story 57). Hermetic 33/33; tsc clean for the commit's scope. Stories 56–63 added to `docs/user-stories-applications.md §13` (Future/OOS bumped to §14); plan body lives in `docs/implementation.md` as `MB Phase 4`.
- **What's NOT in the commit (uncommitted on disk):** the side-track UI wiring for `WatchlistsCard`, `NewPostingsCard`, `components/providers/state/index.ts`, and the postings-route track filter (`app/api/postings/route.ts`). User has a parallel in-flight refactor on these files converting `globalNegativeFilters` → `negativeFiltersByTrack` (and extracting a `FilterButton` component) that currently leaves `tsc --noEmit` with 9 errors mid-edit. Skipped per user preference so the commit history stays clean; the side cards' track scoping + the postings-route `?track=` filter become live once that refactor completes and lands separately.
- **Concurrent linter changes also still uncommitted:** cache-control header fix in `lib/cache.ts` + CLAUDE.md doc update, fetcher-health changes (`app/api/system/fetcher-health/route.ts`, `components/cards/FetcherHealthCard.tsx`, `lib/schemas/system.ts`), `scheduler/jobs/job-watcher.ts` + `scheduler/jobs/posting-digest.ts` negative-filter pre-fetch, `scripts/pre-push.sh` (added `notification-negative-filter-smoke`), `scripts/tests/hermetic/posting-digest-smoke.ts` + `watchlist-hermetic-smoke.ts` extensions, plus untracked `components/ui/FilterButton.tsx` and `scripts/tests/hermetic/notification-negative-filter-smoke.ts`.
- **Schema migration safety:** the dedup constraint loosened (added `track` to the unique tuple), so the migration could never fail on existing data. Verified: 37 watchlist rows + 37 application rows all defaulted to `track="career"`; smoke-tested end-to-end that the same employer (`Starbucks`) can now exist as both career + side without P2002, and duplicate-within-same-track still hits P2002 as before.

## Umbrella goal

**Finish `docs/user-stories-applications.md` so the user can apply to jobs and internships ASAP.** That doc is the canonical roadmap — three independent tracks (Track A: pipeline UX; Track B: job discovery + notifications; Track C: profile + resume generation + GitHub). Don't re-derive the plan here; consult that file for milestone definitions (MA, MB, M7, M8, M9).

**Top-level priority order** (chosen for "apply ASAP"):
1. ✅ **M7 — Profile spine** (Track C). Shipped 2026-05-14 in `0367263` + `e41b6c0`.
2. **M8 — Tailored resume generation** (Track C). *Current focus.* Detailed plan in `docs/user-stories-applications.md` §M8. Phase 1 produces the first sendable PDF.
3. **MA — Pipeline writes + drill-in** (Track A). So applications the user *sends* get tracked end-to-end (manual add, status drag, timeline, notes).
4. **MB — Watchlists + notifications** (Track B). Hunts for new postings. Lower urgency than M8 — the user can hand-source openings; what they can't easily do is hand-tailor a resume per posting.

Out of scope until top-of-stack ships: AI Companion prompt tuning, visual polish, M9 (GitHub-driven project metrics).

## Critical path — current

**Finish landing the side-track UI so the user can actually use the side pipeline.** Backend + schema are committed (`d2cb49f`) but the side WatchlistsCard / NewPostingsCard don't yet send `?track=side` because the relevant files are mid-refactor with the in-flight per-track `negativeFiltersByTrack` change. Once that lands the side discovery cards become live; the side kanban + AddApplicationModal already work end-to-end via the committed code.

## Immediate next actions (in order)

1. **Finish the in-flight `negativeFiltersByTrack` refactor + ship the side-track UI wiring (🔴 follow-up to `d2cb49f`).** Currently 9 TS errors across `WatchlistsCard.tsx`, `NewPostingsCard.tsx`, `components/providers/state/index.ts`, `app/api/postings/route.ts`, `scheduler/jobs/job-watcher.ts`, `scheduler/jobs/posting-digest.ts`. Most originate from `globalNegativeFilters` callsites that need to switch to `negativeFiltersByTrack[track]` + a missing `TrackNegativeFiltersEditor` component reference in WatchlistsCard:257. Once that compiles cleanly, the side WatchlistsCard + NewPostingsCard become functional. Also: `lib/schemas/settings.ts` / `lib/repositories/settings.ts` need their `GlobalSettingData` shape updated so the schedulers + postings route can read the per-track filter slice.
2. **Story 26 — per-watchlist notification preferences (🟡).** Add `notificationMode: 'each' | 'digest'` to `Watchlist`, daily digest scheduler job. Why next: LinkedIn + Workday produce high-volume noisy feeds and there's no quiet mode today. **Note:** scheduler now also runs negative-filter gating per the in-flight refactor — coordinate the digest job with that filter pass.
3. **Story 37 — second resume template (🟡).** Single-column + two-column variants alongside `ats-plain.tsx`. UI picker on `GenerateResumeCard`. Why next: small surface, immediate visible polish on the artifacts the user actually sends.
4. **Story 41 — skills-gap report (🔵).** Posting keywords minus the union of profile bullet tags + bullet-text substrings. Surface on `GenerateResumeCard` post-gen. Cheap data-side, complements story 35's trace.
5. **Story 33 — profile snapshots (🔵).** One `ProfileSnapshot(userId, takenAt, payloadJson)` table + a "Snapshot now" button. Button-press-only — no auto-snapshotting on every edit. Roll-back UX deferred.
6. **Story 63 — bulk-move applications between tracks (🔵).** Single-row Track toggle ships in MB Phase 4; bulk-select UI for "reclassify N apps at once" still open.
7. **Open 🔵 tail** (not in critical path): 24 comp parsing, 28 quiet hours, 45 suggested portfolio rewrites, 46 README ingestion, 48 resume diff, 50 recruiter contacts. Pick opportunistically.

**Genuine MVP-followup TODOs (cross-cutting, not story-numbered):**
- LLM-judged fuzzy bullet dedup (current dedup is exact-text only — "Built a TS API" and "Built a TypeScript API" both survive).
- LinkedIn export ZIP import support (separate unzip path that reads `Positions.csv` / `Education.csv`).
- Legacy `.doc` import format (mammoth handles `.docx` only).
- Per-file progress streaming via SSE so the UI shows "extract → analyze → merge" stages live instead of one long spinner.

## In-progress work

**Uncommitted on `main`** (session of 2026-05-22): the per-track `negativeFiltersByTrack` refactor + a few orthogonal linter changes are mid-edit on disk. `tsc --noEmit` currently reports 9 errors — the conversion is partial. Files holding pending edits:

- **Mid-refactor (blocks side-track UI being usable):** `components/providers/state/index.ts` (ThemeSlice now declares `negativeFiltersByTrack` but consumers still reference `globalNegativeFilters`), `components/cards/WatchlistsCard.tsx` (references non-existent `TrackNegativeFiltersEditor`, plus 4 callsites still using `globalNegativeFilters`), `components/cards/NewPostingsCard.tsx` (extracts a `FilterButton` component already used; only intermingled because it lives alongside the MB Phase 4 track prop), `app/api/postings/route.ts` (intermingled — has my track filter but also the linter's negative-filter pre-fetch with the old global name), `scheduler/jobs/job-watcher.ts` + `scheduler/jobs/posting-digest.ts` (negative-filter pre-fetch using old name).
- **Settings shape changes (probably load-bearing for the refactor):** `lib/schemas/settings.ts`, `lib/repositories/settings.ts` need `GlobalSettingData.globalNegativeFilters: string[]` replaced with `negativeFiltersByTrack: { career: string[]; side: string[] }` (or similar). Then the API + scheduler consumers compile.
- **Orthogonal but uncommitted:** `lib/cache.ts` (cache-control header fix — was sending `max-age=ttl` to browsers, so cacheStats.hits stayed at 0; now sends `private, no-store, max-age=0`), `CLAUDE.md` (one-line note about the new cache-control behavior), `app/api/system/fetcher-health/route.ts` + `components/cards/FetcherHealthCard.tsx` + `lib/schemas/system.ts` (fetcher-health tweaks), `scripts/pre-push.sh` (adds `notification-negative-filter-smoke` to the gate), `scripts/tests/hermetic/posting-digest-smoke.ts` + `watchlist-hermetic-smoke.ts` (new cases for negative-filter behavior).
- **Untracked new files:** `components/ui/FilterButton.tsx`, `scripts/tests/hermetic/notification-negative-filter-smoke.ts`.

**To unblock:** finish the `globalNegativeFilters` → `negativeFiltersByTrack` rename in settings shape + WatchlistsCard editor + all schedulers/routes; create the missing `TrackNegativeFiltersEditor`; commit. Once green, the side discovery cards become live and `?track=side` flows through the postings route too.

**Unattended UI verifications waiting on user return:**
- After hard-refresh, "Side Pipeline" + "Side Discovery" sections appear below career sections.
- AddApplicationModal on side track defaults `track="side"`; inline Track toggle in `ApplicationDetailOverlay` flips a row between pipelines.
- AddWatchlistModal opened from side card shows only "Find roles" + "Advanced" tabs.
- Per-track `postingFilters` slice in Zustand: toggling a chip on one NewPostingsCard does NOT mirror to the other (v6 → v7 persist migration splays prior filters across both tracks on first load).
- Once UI wiring lands: confirm side WatchlistsCard shows only side-track rows (server-side filter is verified to return 0 rows for `?track=side` against current DB).

## Recently completed

- **2026-05-22** — **MB Phase 4 side-track pipeline** shipped (commit `d2cb49f`). Adds parallel `track="side"` alongside the existing career track for gig / blue-collar applications (user is working as a security guard at Crypto Arena DTLA and wants pay-the-bills work tracked separately). Schema migration `add_side_track` extends `Application.@@unique` to include `track` (Starbucks-corporate + Starbucks-barista coexist; in-track dups still hit P2002). Cold Gmail ingest hard-coded to `"career"` (story 60 — no LLM classification, user flips via inline Track toggle in `ApplicationDetailOverlay`). Track-as-application inherits track from parent watchlist. AddWatchlistModal on side track hides "Watch company" + "Discover" tabs (career-curated directory would muddle the keyword-first side pipeline per story 57). Two new Sections in ApplicationsView; calendar + account-status cards stay shared. 21 files committed; UI wiring for `WatchlistsCard` / `NewPostingsCard` / `providers/state` / postings route held back pending the in-flight per-track negative-filters refactor (see "In-progress work"). Stories 56–63 in `docs/user-stories-applications.md §13`; plan body in `docs/implementation.md` as MB Phase 4.
- **2026-05-22** — Fetcher-health card: dropped "(Last Hour)" from title; added inline `1h / 6h / 1d` success-rate pills next to the filter input. Route now returns per-window `totals` alongside the existing per-host 1h map. Commit `f49a729`.
- **2026-05-20** — Celestrak satellite fetcher 403 fix. `/api/space/satellites` was returning 500s on both tiers because (a) `.env.production` was missing `CACHE_BACKEND=sqlite` (memory-only L2 → every prod PM2 restart blew the cache), (b) the 7200s TTL matched Celestrak's 2h refresh exactly so dev + prod (shared outbound IP) raced their window, and (c) on a 403 "GP data has not updated" the route caught its own throw and returned 500 instead of serving last-known. Patched: `CACHE_BACKEND=sqlite` added to `.env.production`; TTL bumped to 21600s (6h) in `app/api/space/satellites/route.ts`; new `readCachedDataIgnoringExpiry()` helper in `lib/cache.ts` consumed by the route to serve any prior cached payload when Celestrak says "unchanged".
- **2026-05-20** — Master-resume synthesis pass + import pipeline fixes. Added `lib/profile/synthesize.ts` (Flash) that runs between per-file extraction (Lite) and the deterministic merge. Resolves role-vs-project misclassifications across files (student orgs like SEB and personal projects like Iris kept landing as work roles when a draft formatted them as "Title | Org"). Cross-category dedup safety net + reverse-chrono ordering in `lib/profile/merge.ts`. One-shot cleanup at `scripts/archive/migrations/dedupe-roles-projects-cross-category.ts`. Hermetic 37/37; prod restarted.
- **2026-05-18** — Tier-B employment-type classifier. `lib/ai/classify-employment-type.ts` batches new postings (heuristic-null only) through a single Gemini Flash call per crawl with explicit timing logs. Wired into `scheduler/jobs/job-watcher.ts` between fetch and create; replaced per-posting findUnique with one bulk findMany so the gating costs nothing extra. Live fixture smoke at `scripts/tests/probes/employment-type-classifier-live.ts`: 8/8 strict cases pass, ~1.7–3.7s/item observed.
- **2026-05-17** — PA + PB-ext + PC follow-up sweep (7 items). PA-1: Gcal idempotency via sha1(eventId) → events.insert.id. PA-2: WebhookDelivery 30-day prune scheduler job. PA-3: `Application.normalizedCompany` + `@@unique([userId, normalizedCompany])` (MB Phase 4 later extended this to include `track`). PB-ext-4/5: backfill JobPosting.employmentType + WorkdayConfig.maxPages override. PC-6: process-shared Gemini token bucket (12 req/min default).

## Known issues / parked TODOs

- **Manual UI smoke** is still nominally outstanding (eyeball the Profile dash, confirm cards render / drag-reorder works / Import + Generate cards look right, sanity-check `viewHue: 280`). Backend pipe is verified end-to-end so this is low-risk visual confirmation.
- **LLM fuzzy bullet dedup** — current merge dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity when this becomes painful.
- **LinkedIn export ZIP** — separate unzip path reading `Positions.csv` / `Education.csv`; not wired yet.
- **Legacy `.doc`** — mammoth handles `.docx` only. Either skip or wire a converter.
- **`viewHue: 280`** for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts`.
