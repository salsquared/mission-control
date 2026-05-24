# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Companion docs:** [`docs/user-stories-applications.md`](./user-stories-applications.md) (what + why) · [`docs/implementation.md`](./implementation.md) (how + in what order, with milestone status + concrete schema / API / file shapes). This file points at the next concrete thing to do; the others are the canonical references.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-22 (consolidated TODO-march session).
- **Branch:** `main`, in sync with `origin/main` at `708308a`. **Ten commits landed end-to-end (all pushed):**
  - `ace2be9` — Story S7.6 capture-side (ProfileSnapshot model + UI) + cross-doc reconciliation.
  - `25ff47b` — RAH-13 age-encrypted DB backups + recovery runbook.
  - `2d0c594` — Story S11.2 recruiter contacts (Contact model + UI + stale-nudge body rewrite).
  - `9f756af` — Story S10.2 resume-version diff (no schema; new lib + route + inline diff panel).
  - `e3cb694` — Story S13.8 bulk-move applications between tracks (no schema; new route + select-mode UI).
  - `e3fcd85` — Story S5.9 compensation parsing (`JobPosting.compensationMin/Max/Currency/Cadence` columns + parser + UI chip).
  - `6ed817c` — Story S9.5 README ingestion (`Project.readme` + scheduler fetch + rewrite-prompt context).
  - `f44cb64` — Story S9.4 suggested portfolio rewrites (metric-delta detector + scheduler dispatch).
  - `e29cf58` — Story S6.4 quiet hours (`GlobalSetting.quietHours*` + dispatcher gate).
  - `708308a` — RAH-12 per-userId Gemini rate limit (sliding-window limiter on /api/resumes + /api/profile/import).
- **Final gate state:** pre-push 42/42 hermetic suites, prod `npm run build` green, all 5 new routes mounted + session-gated, both DBs at the same migration head (32/32 applied), all 4 PM2 processes online, prod restarted on the new build. Per-detail summaries of each commit are in §Recently completed below.
- **Schema migration safety (verified):** all 5 migrations this session are additive-only — `CREATE TABLE` × 2 (ProfileSnapshot, Contact) with no FK to existing tables besides cascade-on-User/Application, and nullable `ADD COLUMN` × 3 (JobPosting comp, Project readme, GlobalSetting quiet-hours). Zero risk of data loss. PM2 was stopped per-migration where SQLite would otherwise lock (4 of 5); the other one ran live.
- **Working tree:** clean, in sync with `origin/main`.

## Umbrella goal

**Apply to jobs.** The `docs/user-stories-applications.md` roadmap is functionally closed — every 🔴 + 🟡 + 🔵 story is shipped, declined, or deferred-by-design. Forward motion now runs through real-world use:

1. Send applications.
2. When the LLM rewrites are off, capture the failure mode in `docs/implementation.md` §Prompt tuning and revise prompts.
3. When something in the pipeline misfires (wrong status classification, missed posting, calendar sync glitch), file it as a follow-up and patch.

Track A (Pipeline UX), Track B (Discovery + notifications), Track C (Profile + resume + GitHub) are all in production. Backups encrypted (RAH-13). Rate limits in place (RAH-12). The MA/MB/M7/M8/M9 milestone scaffolding referenced by older sessions is all behind us; consult `docs/implementation.md` for the per-milestone shipped detail.

## Critical path — current

**Apply, observe, iterate.** The "apply ASAP" loop is fully closed: capture, kanban + side-track kanban, drill-in, contacts, watchlists (career + side), notifications with negative-filter gate + quiet hours, profile + multi-resume import + snapshots, tailored PDF + DOCX + skills-gap + resume-diff, GitHub metrics + README ingestion + suggested-rewrite nudges. Backups encrypted, Gemini-call routes rate-limited. Every 🔴 + 🟡 + 🔵 story is shipped or explicitly declined/deferred. Prompt tuning needs real user data — when an LLM rewrite goes off, capture in `implementation.md` §Prompt tuning.

## Immediate next actions (in order)

1. **Story S7.6 rollback UX (🔵, deferred-by-design).** Capture side shipped; restore-from-snapshot is the deferred half. Build a destructive-overwrite confirm + transactional bulk-replace of `WorkRole` / `Project` / `Education` from the stored payload. This is intentionally not shipped — destructive UI without a real trigger is more risk than safety; pick it up when you've actually made an edit you want to undo.

**Note: every other shippable 🔴/🟡/🔵 story (and both open RAH-N items) is now ✅ or ⛔.** The backlog moves to "real-world use → first applied posting → iterate on prompts." Capture failure modes in `docs/implementation.md` §Prompt tuning when they appear. Genuine MVP-followup TODOs from prior sessions (LLM fuzzy bullet dedup, LinkedIn export ZIP, legacy `.doc`, per-file SSE progress, ProjectCard portfolio toggle UI) are still around but none of them block applying.

**User-side follow-ups for RAH-13 (just shipped):**
- **Save the secret key to 1Password.** The file `~/.config/mission-control/backup.key` was generated this session. It's chmod-600 locally, but losing the Mac without an offsite copy means every encrypted backup is unrecoverable. Copy the file's full contents (including the `# created:` / `# public key:` header lines) into a 1Password secure-note titled `mission-control backup secret`.
- **Decrypt-smoke an encrypted backup** to be sure the round-trip works on a real artifact: `./scripts/backup-decrypt.sh ~/backups/mission-control/mc-20260522-201632.db.age` should produce a readable `.db` next to it. (This session already verified the round-trip end-to-end against the live keypair — same 37 Application rows in encrypted+decrypted vs `prisma/prod.db`.)
- **Purge the plaintext history** once decrypt-smoke passes: `rm -f ~/backups/mission-control/mc-*.db ~/backups/mission-control/mc-resumes-*.tar.gz` locally; if rclone is installed, also `rclone delete gdrive:backups/mission-control/ --include "mc-*.db" --include "mc-resumes-*.tar.gz"`. Until then, the security gap stays open on the historical snapshots even though new ones are encrypted.

**Genuine MVP-followup TODOs (cross-cutting, not story-numbered):**
- LLM-judged fuzzy bullet dedup (current dedup is exact-text only — "Built a TS API" and "Built a TypeScript API" both survive).
- LinkedIn export ZIP import support (separate unzip path that reads `Positions.csv` / `Education.csv`).
- Legacy `.doc` import format (mammoth handles `.docx` only).
- Per-file progress streaming via SSE so the UI shows "extract → analyze → merge" stages live instead of one long spinner.
- M9 Phase 2 UX: portfolio-toggle + `githubRepo` input on `ProjectCard` (currently DB-only).

## In-progress work

Nothing in flight. Working tree clean, in sync with `origin/main`.

**Unattended UI verifications waiting on user feedback (this session's commits, by surface):**

*Profile dash:*
- "History" section renders below "Identity" with `ProfileSnapshotsCard` — label input, "Snapshot now" button, list with per-row delete. Cross-tab delete refreshes via SSE.

*Applications dash:*
- "Contacts" expander sits between Timeline and Resumes on `ApplicationDetailOverlay`. Inline add-form (name + email + role), per-row Touch (bumps `lastTouchedAt`) and Trash. Stale-nudge body now reads "Consider drafting a follow-up to {FirstName}" when a primary contact exists.
- Resume rows in the Resumes section get checkboxes when ≥ 2 are present; selecting 2 enables "Compare selected" → inline `ResumeDiffPanel` (keyword chips + bullet onlyA/onlyB + shared-but-rewritten side-by-side).
- Kanban header has a `CheckSquare` button (both career + side). Tapping it enters select mode: card taps toggle checkboxes (no detail-overlay open), drag-to-status is suppressed, a footer bar shows "N selected · Move to <other-track>". Conflicts (same employer already in target track) surface as a toast listing the colliding companies; nothing moves.

*Postings:*
- Emerald comp chip on `NewPostingsCard` rows that parsed cleanly (`$120k–$150k/yr` style). Will be sparse on day-of since only the next crawl populates the columns.

*Backups / infrastructure (no UI):*
- Confirm `~/.config/mission-control/backup.key` exists and is chmod-600. Run `./scripts/backup-decrypt.sh ~/backups/mission-control/$(ls -t ~/backups/mission-control/*.age | head -1)` once to verify the round-trip works against a real artifact.

*Open from prior session (still valid):*
- Side-track UI: kanban sections, `AddApplicationModal` defaults to `track="side"`, `AddWatchlistModal` hides career-curated tabs, per-track filter slices are independent.
- `/api/system` `cacheStats.hits` actually moves (was pinned at 0 pre-`ae424e8`).

## Recently completed

- **2026-05-22 (RAH-12)** — **Per-userId rate limit on Gemini-call routes.** New `lib/api/user-rate-limit.ts:checkUserRateLimit` sliding-window limiter — state on `globalThis` (HMR-safe), scope-keyed so different routes don't share a budget, pure-function with caller-supplied `now`. Rejected calls do NOT advance the bucket (a stuck loop won't permanently DoS itself). Wired into `POST /api/resumes` ("resumes:gen") and `POST /api/profile/import` ("profile:import") at 5 calls per 10 minutes. Returns 429 + `Retry-After` header. Hermetic 14/14 (`user-rate-limit-smoke.ts`). Full pre-push 42/42, prod build green, prod restarted.
- **2026-05-22 (Story S6.4)** — **Quiet hours for non-critical email.** New `GlobalSetting.quietHoursStart` / `End` / `Timezone` columns (migration `add_quiet_hours`, both DBs). Pure helper `lib/notifications/quiet-hours.ts:isInQuietHours(now, config)` resolves `now` into the IANA zone via `Intl.DateTimeFormat` (DST handled automatically), supports both same-day and wrap-around windows. `dispatchNotification` strips `email` from the channels of any non-critical dispatch that lands inside the window — bell row still creates so the catch-up at wake time is intact. Critical tier (OFFER / INTERVIEW_SCHEDULED) bypasses entirely. Hermetic 20/20 (`quiet-hours-smoke.ts`). Full pre-push 41/41, prod build green.
- **2026-05-22 (Story S9.4)** — **Suggested portfolio-bullet rewrites on metric deltas.** New `lib/profile/metric-deltas.ts:computeMetricDeltas(prev, next)` (pure) runs after every github-metrics tick. Detects star-threshold crossings against `[5, 10, 25, 50, 100, 250, 500, 1k, 2.5k, 5k]` (highest-only — 4→26 fires once at 25), primary-language flips, new ≥5%-share languages (filters one-off shell scripts), and commit-count jumps ≥25% AND ≥10 absolute. First-ingest (no prior metrics) is silent. Each delta dispatches a `kind='system' tier='standard'` notification with dedupKey `portfolio-rewrite:${projectId}:${type}:${milestone}` so a milestone fires at most once. `scheduler/jobs/github-metrics.ts` candidates query gains `profile: { select: { userId: true } }` for dispatch targeting. Hermetic 16/16 (`metric-deltas-smoke.ts`, wired into pre-push). Full pre-push 40/40, prod build green, schedulers restarted so the next 6h tick fires.
- **2026-05-22 (Story S9.5)** — **README ingestion for portfolio repos.** New `Project.readme` + `readmeUpdatedAt` columns (migration `add_project_readme`, both DBs). `fetchGithubReadme(ownerRepo)` separate from `fetchGithubRepoMetrics` so the metrics hot path stays at 3 API calls; weekly cadence in the scheduler (independent of the 20h metrics gate); README failures don't tank metrics refresh for the same project. Markdown stored truncated at 16 KB. Resume rewrite prompt extended with a `ProjectReadmeContext` param — `app/api/resumes/route.ts` builds the context only for project-source bullets actually in the selection (avoids paying tokens on READMEs that aren't surfaced), slices 2 KB per project before prompt assembly. Pure prompt builder extracted as `buildRewriteUserPrompt` so the README branch is unit-testable; hermetic `readme-prompt-smoke.ts` (13/13). Full pre-push 39/39, prod build green, prod + scheduler-prod restarted.
- **2026-05-22 (Story S5.9)** — **Compensation parsing on `JobPosting`.** New `lib/postings/compensation.ts:parseCompensation` regex pass over `(title + snippet + location)` → `compensationMin/Max/Currency/Cadence` columns. Migration `add_posting_compensation` applied to both DBs. Wired into `scheduler/jobs/job-watcher.ts` at row-create time (legacy rows stay null until the next crawl re-extracts them). Cadence detection covers `/hr`, `per day/week/month/year`, `annually` / `annual` / `yearly` / `p.a.` — slash patterns rewritten to drop the leading `\b` since a space before `/` isn't a word boundary, which had silently broken `$120 / year`-style snippets. Plausibility guards reject "5,000 employees" / "$1 / hour" garbage. UI: emerald chip on `NewPostingsCard` rows formatted as `$120k–$150k/yr` (or `$60/hr` for hourly). Hermetic `compensation-smoke.ts` (18/18). Full pre-push 38/38, prod build green, prod + scheduler-prod restarted.
- **2026-05-22 (Story S13.8)** — **Bulk-move applications between tracks.** Adds a select-mode toggle (`CheckSquare` button) to the kanban card header; in select mode, card taps toggle checkboxes instead of opening the detail overlay, drag-to-status is suppressed, and a footer bar shows `N selected · Move to <other-track> · Cancel`. The bulk action calls `POST /api/applications/bulk-track` which wraps `bulkMoveApplicationsTrack` in a single Prisma `$transaction`: pre-fetches the rows ownership-scoped, checks for same-employer-both-tracks conflicts against `@@unique([userId, normalizedCompany, track])`, returns 409 with the conflict list on collision (no partial state) or `updateMany` + 200 otherwise. Cross-user ids in the input silently drop. Hermetic 17/17 (`bulk-track-smoke.ts`, wired into pre-push). Full pre-push 37/37, prod build green, prod restarted.
- **2026-05-22 (Story S10.2)** — **Resume-version diff between two `GeneratedResume` rows.** Pure read-side, no schema changes. `lib/resumes/diff.ts:computeResumeDiff` compares two rows along three axes — posting `parsedKeywords` (A-order preserved), `selections` set-diffed by `bulletId`, and `skillsGap`. Tolerant per-field hydration in the route handler means legacy rows with missing fields default to empty arrays instead of 500ing. `/api/resumes/diff?a=&b=` ownership-checks both rows in one Prisma `findMany` with `userId in where`. UI: when ≥2 resumes are present on an Application, each row gets a checkbox; pick two (FIFO past 2) and "Compare selected" reveals an inline `ResumeDiffPanel` with summary stats + keyword chips (rose=only A, emerald=only B) + bullets-only-in-A / bullets-only-in-B / shared-but-rewritten-differently buckets. Hermetic 31/31 (`resume-diff-smoke.ts`, wired into pre-push). Full pre-push 36/36.
- **2026-05-22 (Story S11.2)** — **Recruiter contacts per application.** New `Contact` Prisma model with cascade-on-application-delete; migration `add_application_contacts` applied to both DBs. `lib/repositories/contacts.ts` exposes CRUD with parent-application ownership scoping + `primaryContactForApplication` (orders by lastTouchedAt desc nulls last → position → createdAt). `/api/applications/contacts` GET/POST/PATCH/DELETE under `requireSession`. UI: expandable "Contacts" section on `ApplicationDetailOverlay` between Timeline and Resumes — inline add-form + per-row Touch (bumps lastTouchedAt) + Trash. `scheduler/jobs/stale-applications.ts` rewrites the nudge body to "Consider drafting a follow-up to <FirstName>" when a contact exists, falls back to generic otherwise. Hermetic 25/25 (`contacts-smoke.ts`, wired into pre-push). Full pre-push 35/35, prod build green, prod PM2 + scheduler-prod restarted so the next stale-nudge tick picks up the new body shape.
- **2026-05-22 (RAH-13)** — **DB backups now encrypted with age.** `scripts/backup-db.sh` reworked: auto-discovers an age recipient at `~/.config/mission-control/backup.pub`, encrypts each artifact in place before either local retention or offsite upload sees it, falls back to plaintext with a loud warning so cron doesn't break before initial key setup. New `scripts/backup-decrypt.sh` companion (auto-discovers the identity at `~/.config/mission-control/backup.key`). One-time setup done this session: `brew install age`, `age-keygen`, public key dropped at the discovery path, secret key chmod-600 locally. Round-trip verified: encrypted backup → decrypt → 37 Applications matches live `prisma/prod.db`. CLAUDE.md §Backups + recovery rewritten with the new setup, cron note, and recovery runbook (which now includes a "restore secret key from 1Password" step). **User still needs to copy the secret key to 1Password** — see §Immediate next actions for the follow-up checklist.
- **2026-05-22 (Story S7.6 capture + doc reconciliation)** — Single commit `ace2be9`. **Cross-doc reconciliation**: `next_steps.md` had drifted (Story S6.2 / 37 / 41 listed as open work but were respectively shipped / killed / shipped); `implementation.md` had an internal contradiction on skills-gap status. Both fixed. Then built Story S7.6's read-only safety net: `ProfileSnapshot` model + migration `add_profile_snapshots`, repository + 2 API routes + api-client surface + `ProfileSnapshotsCard` in a new "History" section on `ProfileView`. SSE `'ProfileSnapshot'` channel for cross-tab invalidation. Hermetic smoke 17/17 (`profile-snapshots-smoke.ts`, wired into pre-push as suite 7 of 34). Full pre-push 34/34, prod build green. Rollback/restore intentionally deferred to a later iteration.
- **2026-05-22** — **MB Phase 4 side-track pipeline fully landed.** Three commits:
  - `d2cb49f` (backend + schema): `track` column on `Watchlist` + `Application`, `@@unique([userId, normalizedCompany, track])` so same employer can coexist in both tracks, ingest hard-coded to `"career"` (no LLM classification — user flips via inline Track toggle in `ApplicationDetailOverlay`), track-as-application inherits parent watchlist's track, two new `<Section>`s on `ApplicationsView`, side `AddWatchlistModal` hides Company/Discover tabs. Stories S13.1–S13.8 in `docs/user-stories-applications.md §13`.
  - `ae424e8` (cache-control fix): prod `Cache-Control` was `max-age=ttl` so the browser short-circuited every repeat request and `cacheStats.hits` stayed at 0. Switched to `private, no-store, max-age=0`; server-side cache still does the work.
  - `431ac8c` (per-track negative filters + UI wiring): reshapes `GlobalSetting.globalNegativeFilters` in-memory parse from `string[]` to `{ career: string[]; side: string[] }`; legacy array migrates into career bucket on first read (no schema migration). `/api/postings`, `scheduler/jobs/job-watcher.ts`, `scheduler/jobs/posting-digest.ts` all consult the right slice per `watchlist.track`. Notifications now apply the negative-filter gate that previously only ran at the postings GET layer — postings still land in the DB, only the bell stays quiet. New `components/ui/FilterButton.tsx`; per-track `postingFilters` slice in Zustand isolates chip toggles between cards. Keyword-only feeds (no company-based watchlists) skip the on/off partition and render everything in the main list. New `notification-negative-filter-smoke` hermetic.
- **2026-05-22** — Fetcher-health card: dropped "(Last Hour)" from title; added inline `1h / 6h / 1d` success-rate pills next to the filter input. Route now returns per-window `totals` alongside the existing per-host 1h map. Commit `f49a729`.
_(Earlier entries pruned per the 3–5-entry protocol — detail lives in `docs/implementation.md` per-milestone sections + `git log`.)_

## Known issues / parked TODOs

- **Manual UI smoke** is still nominally outstanding (eyeball the Profile dash, confirm cards render / drag-reorder works / Import + Generate cards look right, sanity-check `viewHue: 280`). Backend pipe is verified end-to-end so this is low-risk visual confirmation.
- **LLM fuzzy bullet dedup** — current merge dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity when this becomes painful.
- **LinkedIn export ZIP** — separate unzip path reading `Positions.csv` / `Education.csv`; not wired yet.
- **Legacy `.doc`** — mammoth handles `.docx` only. Either skip or wire a converter.
- **`viewHue: 280`** for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts`.
