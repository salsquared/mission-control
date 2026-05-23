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
- **Branch:** `main`. **MB Phase 4 — side-work pipeline fully landed across three commits.** Backend + schema in `d2cb49f`, per-track negative filters + UI wiring in `431ac8c`, cache-control fix in `ae424e8`. Net result: side track is end-to-end functional — separate kanban, keyword-first watchlists, isolated postings feed, per-track negative-filter blocklists, per-track Zustand `postingFilters` slice. Working tree is clean.
- **What shipped (in order):**
  1. **`d2cb49f` feat(applications): side-track pipeline** — schema migration `add_side_track` adds `track` column to `Watchlist` + `Application` (default `"career"`), expands dedup to `@@unique([userId, normalizedCompany, track])` so same employer can coexist in both tracks. Cold Gmail ingest hard-coded to `"career"` (user reclassifies via the inline Track toggle in `ApplicationDetailOverlay` — no LLM classification cost). Track-as-application inherits track from parent watchlist. `ApplicationsView` mounts Side Pipeline + Side Discovery sections; calendar + account-status stay shared. `AddWatchlistModal` on side track hides "Watch company" + "Discover" tabs (career-curated directory would muddle keyword-first side pipeline per story 57). 21 files / +460 / −64.
  2. **`ae424e8` fix(cache): no-store in prod** — `withCache` was sending `Cache-Control: max-age=ttl` in prod, so browsers served repeat requests from disk and `/api/system` `cacheStats.hits` stayed pinned at 0. Switched to `private, no-store, max-age=0` in both tiers; server-side cache still does the work, browser stops short-circuiting it.
  3. **`431ac8c` feat(watchlists): per-track negative filters + shared FilterButton UI** — reshapes `GlobalSetting.globalNegativeFilters` in-memory parse from `string[]` to `{ career: string[]; side: string[] }`. Legacy array migrates into the career bucket on first read; DB column name preserved so no schema migration. `/api/postings`, `scheduler/jobs/job-watcher.ts`, `scheduler/jobs/posting-digest.ts` all consult the right slice per row's `watchlist.track`. Notification pipeline now applies the negative-filter gate that previously only ran at the `/api/postings` GET layer — postings still land in the DB but the bell stays quiet. New `components/ui/FilterButton.tsx` extracted (used by both career + side `NewPostingsCard` instances; per-track `postingFilters` slice keeps chip toggles independent). My partition-fix for keyword-only feeds (skip the on/off split when `companyOptions.length === 0`) was folded in. New `notification-negative-filter-smoke` hermetic; `watchlist-hermetic-smoke` + `posting-digest-smoke` extended.
- **Schema migration safety (verified):** dedup constraint loosened, never fails on existing data. 37 watchlist rows + 37 application rows all defaulted to `track="career"`. Smoke-tested that same employer (Starbucks) can coexist as both career + side without P2002, and duplicate-within-same-track still hits P2002 as before.
- **Stories 56–63** added to `docs/user-stories-applications.md §13` (Future/OOS bumped to §14); plan body in `docs/implementation.md` as MB Phase 4. Story 63 (bulk-move applications between tracks) is the only side-track-adjacent item still open — single-row track flip ships in MB Phase 4, bulk-select UI is future.

## Umbrella goal

**Finish `docs/user-stories-applications.md` so the user can apply to jobs and internships ASAP.** That doc is the canonical roadmap — three independent tracks (Track A: pipeline UX; Track B: job discovery + notifications; Track C: profile + resume generation + GitHub). Don't re-derive the plan here; consult that file for milestone definitions (MA, MB, M7, M8, M9).

**Top-level priority order** (chosen for "apply ASAP"):
1. ✅ **M7 — Profile spine** (Track C). Shipped 2026-05-14 in `0367263` + `e41b6c0`.
2. **M8 — Tailored resume generation** (Track C). *Current focus.* Detailed plan in `docs/user-stories-applications.md` §M8. Phase 1 produces the first sendable PDF.
3. **MA — Pipeline writes + drill-in** (Track A). So applications the user *sends* get tracked end-to-end (manual add, status drag, timeline, notes).
4. **MB — Watchlists + notifications** (Track B). Hunts for new postings. Lower urgency than M8 — the user can hand-source openings; what they can't easily do is hand-tailor a resume per posting.

Out of scope until top-of-stack ships: AI Companion prompt tuning, visual polish, M9 (GitHub-driven project metrics).

## Critical path — current

**Back to "real-world use → first applied posting → iterate on prompts."** Side-track pipeline shipped end-to-end; user can now keyword-watch gig listings (warehouse, barista, delivery, security) separately from career applications without cross-contamination. Track C remains done. Next leverage is 🟡 polish (per-watchlist notification preferences, second resume template) and small 🔵 wins.

## Immediate next actions (in order)

1. **Story 26 — per-watchlist notification preferences (🟡).** Add `notificationMode: 'each' | 'digest'` to `Watchlist`, daily digest scheduler job. Why next: LinkedIn + Workday + the new keyword-first side watchlists all produce high-volume noisy feeds and there's no quiet mode today. The negative-filter gate now ships at the scheduler layer (per `431ac8c`), so the digest job inherits that filtering for free.
2. **Story 37 — second resume template (🟡).** Single-column + two-column variants alongside `ats-plain.tsx`. UI picker on `GenerateResumeCard`. Why next: small surface, immediate visible polish on the artifacts the user actually sends.
3. **Story 41 — skills-gap report (🔵).** Posting keywords minus the union of profile bullet tags + bullet-text substrings. Surface on `GenerateResumeCard` post-gen. Cheap data-side, complements story 35's trace.
4. **Story 33 — profile snapshots (🔵).** One `ProfileSnapshot(userId, takenAt, payloadJson)` table + a "Snapshot now" button. Button-press-only — no auto-snapshotting on every edit. Roll-back UX deferred.
5. **Story 63 — bulk-move applications between tracks (🔵).** Single-row Track toggle shipped in MB Phase 4; bulk-select UI for "reclassify N apps at once" still open.
6. **Open 🔵 tail** (not in critical path): 24 comp parsing, 28 quiet hours, 45 suggested portfolio rewrites, 46 README ingestion, 48 resume diff, 50 recruiter contacts. Pick opportunistically.

**Genuine MVP-followup TODOs (cross-cutting, not story-numbered):**
- LLM-judged fuzzy bullet dedup (current dedup is exact-text only — "Built a TS API" and "Built a TypeScript API" both survive).
- LinkedIn export ZIP import support (separate unzip path that reads `Positions.csv` / `Education.csv`).
- Legacy `.doc` import format (mammoth handles `.docx` only).
- Per-file progress streaming via SSE so the UI shows "extract → analyze → merge" stages live instead of one long spinner.

## In-progress work

None. Working tree is clean; everything from the 2026-05-22 session is on `main`.

**Unattended UI verifications waiting on user feedback:**
- "Side Pipeline" + "Side Discovery" sections render below the career sections after hard-refresh.
- `AddApplicationModal` opened from the side kanban defaults `track="side"`; inline Track toggle in `ApplicationDetailOverlay` flips a row between pipelines.
- `AddWatchlistModal` opened from the side card shows only "Find roles" + "Advanced" tabs (career-curated Company/Discover tabs hidden).
- Per-track `postingFilters` slice in Zustand: toggling a chip on one `NewPostingsCard` does NOT mirror to the other (v6 → v7 persist migration splays prior filters across both tracks on first hydration).
- Per-track negative-filter blocklists: adding a pattern in the career `WatchlistsCard` filter drawer does NOT hide matching postings on the side card (and vice versa).
- For a keyword-only side feed (no company-based watchlists), all postings render in the main list — no "Other matches" detour.
- `/api/system` `cacheStats.hits` actually moves now (was pinned at 0 because the browser was caching at `max-age=ttl`; `ae424e8` switched to `no-store`).

## Recently completed

- **2026-05-22** — **MB Phase 4 side-track pipeline fully landed.** Three commits:
  - `d2cb49f` (backend + schema): `track` column on `Watchlist` + `Application`, `@@unique([userId, normalizedCompany, track])` so same employer can coexist in both tracks, ingest hard-coded to `"career"` (no LLM classification — user flips via inline Track toggle in `ApplicationDetailOverlay`), track-as-application inherits parent watchlist's track, two new `<Section>`s on `ApplicationsView`, side `AddWatchlistModal` hides Company/Discover tabs. Stories 56–63 in `docs/user-stories-applications.md §13`.
  - `ae424e8` (cache-control fix): prod `Cache-Control` was `max-age=ttl` so the browser short-circuited every repeat request and `cacheStats.hits` stayed at 0. Switched to `private, no-store, max-age=0`; server-side cache still does the work.
  - `431ac8c` (per-track negative filters + UI wiring): reshapes `GlobalSetting.globalNegativeFilters` in-memory parse from `string[]` to `{ career: string[]; side: string[] }`; legacy array migrates into career bucket on first read (no schema migration). `/api/postings`, `scheduler/jobs/job-watcher.ts`, `scheduler/jobs/posting-digest.ts` all consult the right slice per `watchlist.track`. Notifications now apply the negative-filter gate that previously only ran at the postings GET layer — postings still land in the DB, only the bell stays quiet. New `components/ui/FilterButton.tsx`; per-track `postingFilters` slice in Zustand isolates chip toggles between cards. Keyword-only feeds (no company-based watchlists) skip the on/off partition and render everything in the main list. New `notification-negative-filter-smoke` hermetic.
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
