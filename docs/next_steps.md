# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Companion docs:** [`docs/user-stories-applications.md`](./user-stories-applications.md) (what + why) · [`docs/implementation.md`](./implementation.md) (how + in what order, with milestone status + concrete schema / API / file shapes). This file points at the next concrete thing to do; the others are the canonical references.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-22 (later session — doc reconciliation + Story 33 capture).
- **Branch:** `main`. **Two things landed:**
  1. **Cross-doc reconciliation** — `next_steps.md` had drifted from `user-stories-applications.md` and `implementation.md`: the "Immediate next actions" list still showed Story 26 (per-watchlist notification mode, actually shipped in MB Phase 2b), Story 37 (multi-template, actually ⛔ user-killed 2026-05-15), and Story 41 (skills-gap, actually shipped + has hermetic) as open work. `implementation.md` itself had an internal contradiction — line 48 marked skills-gap ✅ but the M8 Phase 3 prose claimed it was deferred. All three docs fixed.
  2. **Story 33 capture side shipped** — `ProfileSnapshot` model + migration `add_profile_snapshots` applied to both dev.db and prod.db; repository + 2 API routes; api-client surface; new "Snapshot now" UI card in a "History" section on `ProfileView`. Hermetic smoke 17/17, full pre-push 34/34, prod build green, PM2 prod + dev restarted. Rollback/restore UX intentionally deferred — see `docs/implementation.md` M7.5.
- **Files added / changed:**
  - `prisma/schema.prisma` — new `ProfileSnapshot` model + `User.profileSnapshots` relation.
  - `prisma/migrations/20260523024735_add_profile_snapshots/` — applied to both DBs.
  - `lib/repositories/profile-snapshots.ts` (new), `lib/schemas/profile.ts` (extended), `lib/api-client.ts` (`api.profile.snapshots.*`), `lib/events.ts` + `hooks/useServerEvents.ts` (added `'ProfileSnapshot'` to model unions).
  - `app/api/profile/snapshots/route.ts` + `app/api/profile/snapshots/[id]/route.ts` (new — session-gated via `requireSession`).
  - `components/cards/ProfileSnapshotsCard.tsx` (new), `components/views/ProfileView.tsx` (mounts the card in a new "History" `<Section>` after Identity).
  - `scripts/tests/hermetic/profile-snapshots-smoke.ts` (new, wired into `scripts/pre-push.sh`).
  - Docs: `user-stories-applications.md` §status snapshot + story 33 + 37 updates; `implementation.md` coverage table + M7.5 section + open-work list.
- **Schema migration safety (verified):** new table additive only, no FK / constraint changes on existing tables. Both DBs migrated with PM2 dev + scheduler-dev + prod + scheduler-prod stopped first to avoid SQLite `database is locked`. All four processes back online after migrate.
- **Working tree:** uncommitted. No commits created this session — pending user's call.

## Umbrella goal

**Finish `docs/user-stories-applications.md` so the user can apply to jobs and internships ASAP.** That doc is the canonical roadmap — three independent tracks (Track A: pipeline UX; Track B: job discovery + notifications; Track C: profile + resume generation + GitHub). Don't re-derive the plan here; consult that file for milestone definitions (MA, MB, M7, M8, M9).

**Top-level priority order** (chosen for "apply ASAP"):
1. ✅ **M7 — Profile spine** (Track C). Shipped 2026-05-14 in `0367263` + `e41b6c0`.
2. **M8 — Tailored resume generation** (Track C). *Current focus.* Detailed plan in `docs/user-stories-applications.md` §M8. Phase 1 produces the first sendable PDF.
3. **MA — Pipeline writes + drill-in** (Track A). So applications the user *sends* get tracked end-to-end (manual add, status drag, timeline, notes).
4. **MB — Watchlists + notifications** (Track B). Hunts for new postings. Lower urgency than M8 — the user can hand-source openings; what they can't easily do is hand-tailor a resume per posting.

Out of scope until top-of-stack ships: AI Companion prompt tuning, visual polish, M9 (GitHub-driven project metrics).

## Critical path — current

**Back to "real-world use → first applied posting → iterate on prompts."** The "apply ASAP" loop is fully closed: capture, kanban + side-track kanban, drill-in, watchlists (career + side), notifications with negative-filter gate at the scheduler layer, profile + multi-resume import, tailored PDF + DOCX + skills-gap. Every 🔴 + 🟡 story is shipped or user-declined. What's left is a tail of 🔵 polish + two cross-cutting items (backup encryption, Gemini rate-limit). Prompt tuning is blocked on the user actually applying to postings — when they do, capture failure modes in `implementation.md` §Prompt tuning.

## Immediate next actions (in order)

1. **RAH-13 — encrypt DB backups (🟡 security).** `scripts/backup-db.sh` tars `prisma/prod.db` to Drive in plaintext; `Account.refresh_token` is inside, so Drive access = Gmail + Calendar takeover. Pipe through `age -r <pubkey>` with the key stored in 1Password, or switch to an rclone `crypt:` remote. Update the recovery runbook in `CLAUDE.md` accordingly.
2. **Story 50 — recruiter contacts (🔵).** Per-application `Contact(id, applicationId, name, email?, role?, lastTouchedAt?)` rows. Surface in `ApplicationDetailOverlay`; the existing follow-up nudges (story 49) become "draft follow-up to <name>" instead of "draft follow-up".
3. **Story 48 — resume-version diff (🔵).** Side-by-side diff between two `GeneratedResume` rows (selections + rendered text). Most useful on the same `applicationId`. Pure read-side; no schema changes.
4. **Story 63 — bulk-move applications between tracks (🔵).** Single-row Track toggle shipped in MB Phase 4; bulk-select UI ("reclassify N apps at once") still open. Multi-select on kanban cards + a track-flip action.
5. **Story 33 rollback UX (🔵).** Capture side shipped; restore-from-snapshot is the deferred half. Build a destructive-overwrite confirm + transactional bulk-replace of `WorkRole` / `Project` / `Education` from the stored payload. Defer until the user actually wants to roll back.
6. **RAH-12 — per-userId Gemini rate-limit (🟡 abuse).** Token bucket on `POST /api/resumes` + `POST /api/profile/import` (e.g. 5 generations / 10 min) checked before the first Gemini call. Single-user today, but a logged-in tab in a loop drains the free-tier quota.
7. **Open 🔵 tail** (pick opportunistically): 24 comp parsing, 28 quiet hours, 45 suggested portfolio rewrites, 46 README ingestion.

**Genuine MVP-followup TODOs (cross-cutting, not story-numbered):**
- LLM-judged fuzzy bullet dedup (current dedup is exact-text only — "Built a TS API" and "Built a TypeScript API" both survive).
- LinkedIn export ZIP import support (separate unzip path that reads `Positions.csv` / `Education.csv`).
- Legacy `.doc` import format (mammoth handles `.docx` only).
- Per-file progress streaming via SSE so the UI shows "extract → analyze → merge" stages live instead of one long spinner.
- M9 Phase 2 UX: portfolio-toggle + `githubRepo` input on `ProjectCard` (currently DB-only).

## In-progress work

Nothing in-flight in the editor. Story 33 capture side shipped this session (see §Last session). Working tree is uncommitted — user has not yet asked for a commit.

**Unattended UI verifications waiting on user feedback (new this session):**
- New "History" section renders on `ProfileView` below "Identity", with a `ProfileSnapshotsCard` containing the label input + "Snapshot now" button + empty-state copy.
- Clicking "Snapshot now" without a label produces an unlabeled row (italic "Unlabeled" placeholder). Clicking it after typing a label persists the label.
- The trash icon next to a row prompts a `window.confirm`, then deletes on confirm.
- Cross-tab: deleting on one tab makes the other tab's list refresh within ~a second (SSE `ProfileSnapshot` channel).

**Unattended UI verifications still waiting on user feedback (from 2026-05-22 morning session):**
- "Side Pipeline" + "Side Discovery" sections render below the career sections after hard-refresh.
- `AddApplicationModal` opened from the side kanban defaults `track="side"`; inline Track toggle in `ApplicationDetailOverlay` flips a row between pipelines.
- `AddWatchlistModal` opened from the side card shows only "Find roles" + "Advanced" tabs (career-curated Company/Discover tabs hidden).
- Per-track `postingFilters` slice in Zustand: toggling a chip on one `NewPostingsCard` does NOT mirror to the other.
- Per-track negative-filter blocklists: adding a pattern in the career `WatchlistsCard` filter drawer does NOT hide matching postings on the side card (and vice versa).
- For a keyword-only side feed (no company-based watchlists), all postings render in the main list — no "Other matches" detour.
- `/api/system` `cacheStats.hits` actually moves now (was pinned at 0 because the browser was caching at `max-age=ttl`; `ae424e8` switched to `no-store`).

## Recently completed

- **2026-05-22 (later session)** — **Cross-doc reconciliation + Story 33 capture-side shipped.** `next_steps.md` had drifted (Story 26 / 37 / 41 listed as open work but were respectively shipped / killed / shipped); `implementation.md` had an internal contradiction on skills-gap status. Both fixed. Then built Story 33's read-only safety net: `ProfileSnapshot` model + migration `add_profile_snapshots`, repository + 2 API routes + api-client surface + `ProfileSnapshotsCard` in a new "History" section on `ProfileView`. SSE `'ProfileSnapshot'` channel for cross-tab invalidation. Hermetic smoke 17/17 (`profile-snapshots-smoke.ts`, wired into pre-push as suite 7 of 34). Full pre-push 34/34, prod build green. Rollback/restore intentionally deferred to a later iteration.
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
