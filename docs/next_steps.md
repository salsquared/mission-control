# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Companion docs:** [`docs/user-stories-applications.md`](./user-stories-applications.md) (what + why) · [`docs/implementation.md`](./implementation.md) (how + in what order, with milestone status + concrete schema / API / file shapes). This file points at the next concrete thing to do; the others are the canonical references.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-20
- **Branch:** `main`. Resume import pipeline upgraded: per-file extraction (LITE) now feeds a new **master-resume synthesis pass** (FLASH) before the deterministic merge writes to the DB. Prompt for extraction tightened so student-org / personal-project entries (SEB, Iris) classify as projects regardless of resume section heading. Cross-category dedup safety net + reverse-chrono ordering added in `lib/profile/merge.ts`. Prod data on Sal's profile cleaned up by one-shot scripts: Iris duplicate folded, SEB role converted to a project, CSULB education dedup'd, work-role positions reassigned reverse-chrono. Hermetic suite 37/37; build + prod restart clean.
- **Files added/touched:**
  - `lib/profile/synthesize.ts` (new)
  - `lib/profile/import-llm.ts` — tighter classification rules
  - `lib/profile/merge.ts` — `findProjectByCompanyName`, cross-category fold, reverse-chrono sort, `workRolesFoldedIntoProjects` counter, projects processed before roles
  - `app/api/profile/import/route.ts` — new `synthesize` stage between analyze + merge
  - `components/cards/ImportResumesCard.tsx` — surfaces the fold count
  - `scripts/tests/hermetic/profile-merge-smoke.ts` — 7 new cases for fold + ordering
  - `scripts/archive/migrations/dedupe-roles-projects-cross-category.ts` (new) — generic cleanup for future imports
  - `docs/llm-calls.md` — new synthesize row
- **Headline of previous session (2026-05-20 dev-server perf):** Dev worker 1.13 GB → 722 MB median under Turbopack; prod tier 279 MB. Detailed log in [`docs/perf-profile.md`](./perf-profile.md).
- **Headline shipped artifacts (this session):**
  - 9 in-app perf fixes (Prisma log gate, Strict Mode flip, signal diagnostics, shared EventSource, InternalView memoization, debounced cache-invalidation, cached pings, L1 cache prune, verbose-log mute, Pulsar backoff).
  - 4 bundle-side wins (lazy-load dashes, dropped `react-icons`, `optimizePackageImports`, **flipped dev to Turbopack**).
  - 1 bug fix (LLM leaderboard dedupe + defensive React key).
  - 1 measurement tool (`scripts/perf-monitor.ts`) with `MC_PERF_RESTART=1` cold-baseline support, JSONL + markdown summaries to `data/perf/`.
- **Crash investigation outcome:** the new SIGINT/SIGTERM diagnostic in `instrumentation.ts` caught one mystery restart in the wild — `~/.pm2/pm2.log` showed `Stopping app:mission-control-dev id:2` from PM2's IPC socket. **Not an in-tree bug** — another concurrent Claude Code session on this machine ran `pm2 restart all`. The diagnostic stays in place to identify future occurrences.
- **Outside-repo edit:** `~/salsquared/ecosystem.config.cjs` has `max_memory_restart` + `min_uptime` + `max_restarts` for both prod and dev tiers. `pm2 save` run. *Caveat:* PM2 watches the npm wrapper, not the `next-server` worker — these caps catch wrapper-level pathology but not worker leaks. Worker truth is `/api/system` or `scripts/perf-monitor.ts`.

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

**Uncommitted on `main`** (session of 2026-05-17): all PA-1 → PC-7 work is on-disk only. Schema migrations applied to dev.db. To ship: `git add` the new files + edits, commit, then push. Files of note:

- New: `lib/watchlists/hydrate.ts`, `lib/applications/normalize-company.ts`, `lib/fetchers/employment-type.ts`, `lib/ai/rate-limit.ts`, `scheduler/jobs/webhook-delivery-prune.ts`.
- New scripts/tests: `watchlist-hydrate-smoke`, `employment-type-smoke`, `webhook-dedup-smoke`, `ingest-retry-smoke`, `normalize-company-smoke`, `notification-dedup-smoke`, `gcal-idempotency-smoke`, `webhook-prune-smoke`, `app-race-dedup-smoke`, `gemini-rate-limit-smoke`, `verify-directory-candidates`, `rocket-lab-slug-check`, `backfill-watchlist-directory-key`, `backfill-app-normalized-company`, `backfill-posting-employment-type`, `job-search-live`, `gmail-inbox-debug`.
- Touched: `prisma/schema.prisma`, `app/api/watchlists/[id]/route.ts`, `app/api/watchlists/route.ts`, `app/api/gmail/webhook/route.ts`, `app/api/postings/route.ts`, `app/api/postings/[id]/route.ts`, `app/api/notifications/test/route.ts`, `lib/repositories/applications.ts`, `lib/repositories/applicationEvents.ts`, `lib/notifications/dispatch.ts`, `lib/applications/ingest.ts`, `lib/company-directory.ts`, `lib/calendar/sync.ts`, `lib/schemas/watchlists.ts`, `lib/schemas/gmail-webhook.ts`, `lib/fetchers/*` (all six), `components/cards/NewPostingsCard.tsx`, `components/cards/WatchlistsCard.tsx`, `components/overlays/AddWatchlistModal.tsx`, `components/providers/state/index.ts`, `scheduler/index.ts`, `scheduler/jobs/posting-digest.ts`, `scheduler/jobs/stale-applications.ts`, `scheduler/jobs/deadline-nudges.ts`, `scheduler/jobs/job-watcher.ts`, `lib/email-parser.ts`, `lib/ai/gemini.ts`, `scripts/pre-push.sh`, `docs/implementation.md`.

**Unattended UI verifications waiting on user return:**
- "Watch company" picker shows "Added" chips on directory entries that match existing watchlists.
- New-postings card filter drawer (employment type / remote / location).
- Watchlist row for Rocket Lab now hits `rocketlab` slug (not `rocketlabusa`) and returns jobs on "Run now".
- Gmail webhook + ingest: an OFFER/INTERVIEW email's notification + Gcal mirror should arrive even if ingest crashed mid-pipeline on a prior attempt.
- Boeing/Blue Origin watchlists should now pull 1,000+ jobs each (was capped at 200).

## Recently completed

- **2026-05-20** — Celestrak satellite fetcher 403 fix. `/api/space/satellites` was returning 500s on both tiers because (a) `.env.production` was missing `CACHE_BACKEND=sqlite` (memory-only L2 → every prod PM2 restart blew the cache), (b) the 7200s TTL matched Celestrak's 2h refresh exactly so dev + prod (shared outbound IP) raced their window, and (c) on a 403 "GP data has not updated" the route caught its own throw and returned 500 instead of serving last-known. Patched: `CACHE_BACKEND=sqlite` added to `.env.production`; TTL bumped to 21600s (6h) in `app/api/space/satellites/route.ts`; new `readCachedDataIgnoringExpiry()` helper in `lib/cache.ts` consumed by the route to serve any prior cached payload when Celestrak says "unchanged". Cold-start verification deferred: current request lands inside Celestrak's lockout window (last successful download 2026-05-20 22:46:53 UTC; next refresh ~00:46:53 UTC) — once a 200 is captured, the 6h TTL + L2 backing means we won't trip them again.
- **2026-05-20** — Master-resume synthesis pass + import pipeline fixes. Added `lib/profile/synthesize.ts` (Flash) that runs between per-file extraction (Lite) and the deterministic merge. Resolves role-vs-project misclassifications across files (student orgs like SEB and personal projects like Iris kept landing as work roles when a draft formatted them as "Title | Org"). Cross-category dedup safety net + reverse-chrono ordering in `lib/profile/merge.ts`. One-shot cleanup at `scripts/archive/migrations/dedupe-roles-projects-cross-category.ts` (handles role↔project, project↔project, education↔education, optional `--reorder-roles`). Sal's prod profile cleaned up via that script + a one-off `/tmp` script for SEB-role-to-project + CSULB dedup. Hermetic 37/37; prod restarted.
- **2026-05-18** — Tier-B employment-type classifier. `lib/ai/classify-employment-type.ts` batches new postings (heuristic-null only) through a single Gemini Flash call per crawl with explicit timing logs. Wired into `scheduler/jobs/job-watcher.ts` between fetch and create; replaced per-posting findUnique with one bulk findMany so the gating costs nothing extra. Live fixture smoke at `scripts/tests/probes/employment-type-classifier-live.ts`: 8/8 strict cases pass, ~1.7–3.7s/item observed. Fallback plan: swap to local Gemma-3n on mac mini if wall-time stays >15s/batch.
- **2026-05-17** — PA + PB-ext + PC follow-up sweep (uncommitted, 7 items). PA-1: Gcal idempotency via sha1(eventId) → events.insert.id; 409 = pre-existing, fetch instead. PA-2: WebhookDelivery retention prune scheduler job (30-day cutoff). PA-3: `Application.normalizedCompany` + `@@unique([userId, normalizedCompany])` schema add + backfill; concurrent createApplication races now resolve via P2002 → update fallthrough. PB-ext-4: backfilled JobPosting.employmentType from titles (with new disqualifier rule that skips "Contract Manager"-style false positives). PB-ext-5: WorkdayConfig.maxPages override (Boeing → 60 pages = 1,200 cap, Blue Origin → 50). PC-6 (RAH-12): process-shared Gemini token bucket (12 req/min default, configurable via `GEMINI_RATE_PER_MIN` / `GEMINI_RATE_BURST`) wrapping both `email-parser` and `lib/ai/gemini.ts`. PC-7: this doc + CLAUDE.md sync. 26/26 hermetic suites green.
- **2026-05-17** — PB-N polish backlog closure (PB-1, PB-5, PB-6, PB-8 shipped on top of PB-14/15 from the same day). `Notification.dedupKey @unique` (race-safe at-most-once), `WebhookDelivery(messageId @id)` (Pub/Sub redelivery dedup), per-event `notifiedAt`/`gcalSyncedAt` checkpoints (crash recovery), `User.lastSyncedHistoryId` (multi-day outage recovery), `normalizeCompanyName` (Bell Smoke vs Bell Smoke Co convergence). Open PB-N list emptied — status flipped to ✅ in implementation.md.
- **2026-05-17** — PB-14 + PB-15. `Watchlist.directoryKey` hydrates config from `lib/company-directory.ts` at read time (closes directory→watchlist drift). `JobPosting.employmentType` + filter chips drawer in NewPostingsCard (employment type / remote / location, persisted to useAppStore).
- **2026-05-17** — Directory expansion (6 → 30 companies). Verified live via `scripts/tests/probes/verify-directory-candidates.ts`. New entries: OpenAI, Perplexity, Scale AI, LangChain, Notion, PostHog, Astranis, Planet, Datadog, Cloudflare, GitLab, Dropbox, Discord, Reddit, Figma, Asana, Webflow, Linear, Spotify, Brex, Robinhood, Ramp, Mercury, Recursion. Stale Rocket Lab slug (`rocketlabusa` → `rocketlab`) fixed in dev DB.
- **2026-05-16** — docs/ cleanup. Moved `whitepaper.md` and `todo.archive.md` into `docs/archive/`; trimmed `hosting.md`. Net: 10 active docs → 7; ~350 lines removed.

## Known issues / parked TODOs

- **Manual UI smoke** is still nominally outstanding (eyeball the Profile dash, confirm cards render / drag-reorder works / Import + Generate cards look right, sanity-check `viewHue: 280`). Backend pipe is verified end-to-end so this is low-risk visual confirmation.
- **LLM fuzzy bullet dedup** — current merge dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity when this becomes painful.
- **LinkedIn export ZIP** — separate unzip path reading `Positions.csv` / `Education.csv`; not wired yet.
- **Legacy `.doc`** — mammoth handles `.docx` only. Either skip or wire a converter.
- **`viewHue: 280`** for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts`.
