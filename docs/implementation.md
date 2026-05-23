# Implementation plan

Operational companion to [`docs/user-stories-applications.md`](./user-stories-applications.md). That doc says **what** we're building and **why**; this doc says **how** and **in what order** — concrete file paths, table shapes, API contracts, and acceptance criteria.

Cross-session running state lives in [`docs/next_steps.md`](./next_steps.md): what was just done, what's blocked on whom, today's critical path. This file is durable design; `next_steps.md` is fast-moving status. When a milestone ships, mark it ✅ here and `next_steps.md` gets compacted.

## Status legend

- ✅ Shipped (committed on `main`, smoked end-to-end)
- ◐ Partial (one half shipped, other half intentionally out-of-scope or pending)
- 🟢 In progress (active branch / open PR / current session)
- ⏳ Planned (designed, sequenced, not yet started)
- 💤 Deferred (intentionally backlogged — story priority is 🟡/🔵 or it's blocked)
- ⛔ Declined by user (kept in the doc so the decision doesn't get re-litigated)
- ❌ Killed (decided against on technical grounds)

Each milestone lists the **user stories** it satisfies (numbers refer to `user-stories-applications.md`). Story priority emoji from that doc: **🔴** = must-have for next ship, **🟡** = important, **🔵** = nice-to-have. Those are *priority*, not status — every 🔴 in this plan is already ✅.

---

## Status snapshot (2026-05-22)

**TL;DR — the roadmap is functionally closed.** Every 🔴 must-have, every 🟡 important (sans declined), and every 🔵 nice-to-have (sans declined / future / one deferred rollback half) shipped. All open RAH-N security items closed. The single remaining piece is Story 33's restore-from-snapshot UX, intentionally deferred until there's a real edit to roll back. Forward motion now lives in "apply, observe failure modes, tune prompts" — captured in §Prompt tuning.

### Coverage by priority

| Priority | Shipped | Open | Declined | Total |
|---|---|---|---|---|
| 🔴 must-have | **20** | 0 | 0 | 20 (incl. §13 56–59 and story 30a) |
| 🟡 important | **25** | 0 | 1 | 27 (story 47 ◐ partial — resume side shipped, cover-letter side OOS; story 37 ⛔ multi-template user-declined 2026-05-15) |
| 🔵 nice-to-have | **12** | 0 | 1 | 13 (excluding 4 future/OOS items 52–55; story 40 ⛔ cover letter). Story 33 ◐ — capture side shipped, rollback deferred. |

### Per-track status

| Track | Phase | Status | Notes |
|---|---|---|---|
| **A** — Pipeline UX | MA | ✅ | Kanban + drill-in + manual add + delete + inline edit + NOTE composer |
| A | MA-followup | ✅ | Inline edit 13, delete 15, kind toggle 51, stale-app nudges 49, recruiter contacts 50, resume-version diff 48 all shipped. |
| **B** — Discovery | MB Phase 1 | ✅ | careers-page + greenhouse, in-app notifications, "Track" / "Hide" |
| B | MB Phase 2a | ✅ | Track→App (story 20), Lever + Ashby, closed-detection |
| B | MB Phase 2b | ✅ | Workday + LinkedIn fetchers + Gmail OAuth email send + per-watchlist notificationMode (each/digest/silent) + posting-digest daily job |
| B | MB Phase 3a | ✅ | Application-side notifications via central dispatcher + decision-deadline nudges (story 27 closed) |
| B | MB Phase 3b | ◐ | Stale nudges (49) ✅, negative filters (23) ✅. Open: comp parsing (24), quiet hours (28) |
| **C** — Profile + resume + GitHub | M7 | ✅ | Profile spine + cards + bullet UX with lock/exclude/tags |
| C | M7.4 | ✅ | Multi-resume import (PDF/DOCX/TXT/JSON) → LLM extract → append-merge |
| C | M8 Phase 1 | ✅ | Tailored generation: posting → keywords → selection → rewrite → PDF |
| C | M8 Phase 2 | ✅ | Archival + `applicationId` linkage + "Why these bullets?" trace |
| C | M8 Phase 3 | ✅ | DOCX ✅. Skills-gap (41) ✅. Multi-template (37) ⛔ user-declined 2026-05-15. Cover letter (40) ⛔ user-declined |
| C | M9 Phase 1 | ✅ | `scheduler/jobs/github-metrics.ts` refreshes `Project.metrics` for `portfolio=true` repos |
| C | M9 Phase 2 | ✅ | Suggested rewrites (45), README ingestion (46) — both shipped 2026-05-22 |
| **Cross-cutting** | Notification dispatcher | ✅ | Tier model (critical/standard/low), global bell, EMAIL_ENABLED kill-switch |
| Cross-cutting | Backups | ✅ | DB + `data/resumes/` tar to Google Drive via rclone + recovery runbook |
| Cross-cutting | Pre-push hermetic gate | ✅ | 14 suites, ~5s, simple-git-hooks |
| Cross-cutting | Route auth hardening | ✅ | 19/19 unguarded routes patched (`requireSession` / `requireLocalOrSession`); RAH-1/5/10/11/17/18/19/20/21/24 ✅ shipped 2026-05-16. RAH-12 (Gemini rate limit) + RAH-13 (backup encryption) ✅ shipped 2026-05-22. All 24 items closed. |
| Cross-cutting | Polish backlog (PB-N) | ✅ | PB-2/3/4/7/9/10/11/12/13 ✅ shipped 2026-05-16. PB-1/5/6/8/14/15 ✅ shipped 2026-05-17. All open PB-N items addressed. |

### Open work, by leverage (next-up order)

Story 37 (multi-template) and Story 40 (cover letter) are ⛔ user-declined; not in this list. Story 33 (snapshots) ◐ shipped capture-side 2026-05-22; rollback/restore-from-snapshot is parked until the safety net proves useful. **Everything else is closed.** RAH-12, RAH-13, and stories 50, 48, 63, 24, 46, 45, 28 all ✅ shipped 2026-05-22.

1. **Story 33 — rollback/restore UX (🔵).** Capture side ✅ via `ProfileSnapshot`. "Restore from snapshot" needs a destructive-overwrite confirm + transactional bulk-replace of `WorkRole` / `Project` / `Education` (+ bullet json) from the stored payload. Defer until the user actually wants to roll back.

### User-declined

- **Story 40** ⛔ Cover-letter generator. User writes cover letters by hand. By extension, the cover-letter half of story 47 is also out-of-scope; the resume half ships via `GeneratedResume.applicationId`.

### Future / OOS

- Stories 52–55 (browser extension, app-form auto-fill, interview prep tracker, salary research). Not blocking.

---

## Track A — Pipeline UX & manual edits

### MA — Pipeline writes + drill-in ✅

Stories: 5, 6, 7, 8 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/applications-api-smoke.ts` (10/10 green) · Commit: `7986aed`.

Already-implemented work surfaced during review: full Kanban writes (drag-to-status with optimistic rollback), manual add modal, drill-in timeline overlay, note composer, applications API CRUD + events. PATCH on status auto-emits a `STATUS_CHANGED` event with correct `fromStatus`/`toStatus`.

Files (load-bearing): `app/api/applications/route.ts`, `app/api/applications/events/route.ts`, `components/views/ApplicationsView.tsx`, `components/overlays/AddApplicationModal.tsx`, `components/overlays/ApplicationDetailOverlay.tsx`.

### MA-followup — Inline edits + document attachment + nudges ✅ (mostly)

Stories: 13, 14, 15, 47, 48 (🟡) · 49, 50 (🟡).

- **MA-f.1** ✅ — Inline-edit of company/role/nextSteps on the detail overlay (story 13). `EditingField` state in `ApplicationDetailOverlay.tsx:37`.
- **MA-f.2** ✅ — Delete confirmation UI (story 15). `Trash2` button + `window.confirm` at line 218 of the overlay.
- **MA-f.3** ◐ — Document attachment (story 47 resume side). `GeneratedResume.applicationId` link is wired (M8 Phase 2). Diff between two sent versions (story 48) still open 🔵.
- **MA-f.4** ✅ — Follow-up nudges (story 49). `scheduler/jobs/stale-applications.ts` fires daily, finds apps with `lastUpdateAt < now - STALE_AFTER_DAYS`, emits `Notification(kind='application', payload.type='stale-nudge')` dedup'd against active prior nudges. `scripts/tests/hermetic/stale-nudge-smoke.ts` covers it.

**MA-f.6** ✅ — Resume-version diff (story 48). Shipped 2026-05-22. Pure read-side, no schema changes. `lib/resumes/diff.ts:computeResumeDiff(a, b)` compares two `GeneratedResume` rows along three axes — posting `parsedKeywords`, `selections` (set-diffed by `bulletId` so the same bullet appearing in both surfaces rewrite-text deltas), and `skillsGap`. Order is preserved from the A side so the UI can render keywords in their original posting order. `/api/resumes/diff?a=&b=` parses both rows in one Prisma round-trip, ownership-checks via `userId in where`, hydrates with tolerant per-field validators (legacy rows with missing fields default to empty arrays rather than 500ing the diff). UI lives in `ApplicationDetailOverlay.tsx:ApplicationResumesSection` — when ≥2 resumes are present, each row gets a checkbox; selecting 2 (FIFO past 2) enables a "Compare selected" button that reveals an inline `ResumeDiffPanel` showing summary stats + keyword chips (rose=only A, emerald=only B) + bullets-only-in-A / bullets-only-in-B / shared-but-rewritten-differently buckets. Hermetic: `scripts/tests/hermetic/resume-diff-smoke.ts` (31/31) covers identical-resume zero-deltas, A-order preservation, bullet set-diff, rewrite-changed + scoreDelta, per-bullet matchedKeywords/Tags deltas, skills-gap deltas.

**MA-f.5** ✅ — Recruiter contacts (story 50). Shipped 2026-05-22. New `Contact` Prisma model (id, applicationId, name, email?, role?, notes?, lastTouchedAt?, position) with cascade-on-application-delete; migration `add_application_contacts` applied to both dev.db and prod.db. `lib/repositories/contacts.ts` exposes CRUD with parent-application ownership scoping + `primaryContactForApplication(applicationId)` that orders by `lastTouchedAt desc nulls last → position asc → createdAt asc`. `/api/applications/contacts` route handles GET/POST/PATCH/DELETE under `requireSession`. UI: expandable "Contacts" footer on `ApplicationDetailOverlay` (sits between Timeline and Resumes) with inline add-form + per-row Touch button (bumps lastTouchedAt to now) + Trash. `scheduler/jobs/stale-applications.ts` now consults `primaryContactForApplication` and reshapes the nudge body — "Consider drafting a follow-up to <FirstName>" when a contact exists, falling back to the generic body otherwise. Hermetic: `scripts/tests/hermetic/contacts-smoke.ts` (25/25) covers CRUD + cross-user rejection + primary-contact ordering + cascade-on-application-delete.

**Still open in MA-followup:** story 48 (resume diff).

---

## Track B — Job discovery + notifications

### MB Phase 1 — Watchlists + crawler + in-app notifications ✅

Stories: 16, 17, 19, 25 (🔴) — minimum viable "hunt on my behalf" loop.

**Scope IN:**
- Two source types: `careers-page` (HTML scrape + link pattern) **and** `greenhouse` (boards-api.greenhouse.io JSON). Greenhouse pulled forward from Phase 2 after discovering that most modern careers pages are SPAs that don't expose postings in initial HTML. Anthropic, Stripe, Rocket Lab, Vercel, and many more publish their boards via Greenhouse — covers the bulk of real-world targets without needing headless rendering.
- In-app notifications only.
- Manual + auto crawl (user "Run now" button + scheduler every 10 min).
- "Track" / "Hide" actions that move a posting between `status='new'|'tracked'|'hidden'`. No Application creation yet — that ships in MB Phase 2 with the rest of story 20.
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

Closed-posting detection (story 22) deferred to MB Phase 2.

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

**Decided 2026-05-15: real URL** (option a). Smoke targets `https://www.rocketlabusa.com/careers/` (listed in story 17). Smoke is intentionally flakier than the others — if Rocket Lab restructures their page, this fails and the linkPattern needs updating. Acceptable trade-off; the user picked it.

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

Stories: 18 (Lever/Ashby), 20 (Track→App), 22 (closed detection) — 🟡.
Shipped 2026-05-15. Smoke: `scripts/tests/integration/watchlist-phase2-smoke.ts` (10/10 green).

- **MB-2.3 Track→App** — new `POST /api/postings/[id]/track-as-application` creates `Application(status='INTERESTED', kind='job', postingId, role=posting.title)` in a single Prisma transaction and flips `posting.status='tracked'`. Idempotent on re-call (returns the existing Application + `created:false`). UI: "Track as App" button on NewPostingsCard. ApplicationDetailOverlay shows a "Tracked from: <sourceUrl>" line with a "Closed" badge if the underlying posting transitions to closed. Schema: `INTERESTED` added to `APPLICATION_STATUSES` (placed first so kanban order reads interest → applied → ...); `Application.postingId String? @unique` with `onDelete: SetNull` to JobPosting. Migration `add_interested_status_and_posting_link`.
- **MB-2.1 (partial) Lever + Ashby fetchers** — `lib/fetchers/lever-fetcher.ts` (api.lever.co/v0/postings/<slug>) and `lib/fetchers/ashby-fetcher.ts` (api.ashbyhq.com/posting-api/job-board/<slug>). WATCHLIST_KINDS expanded to `["careers-page", "greenhouse", "lever", "ashby"]`. AddWatchlistModal kind picker shows all four with per-kind help text.
- **MB-2.4 Closed-posting detection** — at the end of each scheduler tick (skipped on first run), any non-terminal JobPosting whose `externalId` wasn't in the current fetch set AND whose `lastSeenAt < runAt - 6h` flips to `status='closed', removedAt=runAt`. One `Notification(kind='system')` per watchlist summarizing the closures. The 6h grace window prevents transient feed glitches from prematurely marking postings closed. `RunResult.closed` count exposed via `/api/watchlists/[id]/run`.

### MB Phase 2b — Workday + LinkedIn + per-watchlist mode ✅

Stories: 18 (Workday), 21 (LinkedIn), 26 (per-watchlist mode) (🟡) · Decision 2 (email — now resolved via OQ1).

- ✅ **Workday** (shipped 2026-05-15): `lib/fetchers/workday-fetcher.ts`. POST to `<tenantHost>/wday/cxs/<tenantSlug>/<careerSite>/jobs` with paginated `{appliedFacets, limit, offset, searchText}`. **Server caps `limit` at 20** (found empirically; values ≥ 25 return HTTP 400); the fetcher uses PAGE_SIZE=20 + MAX_PAGES=10 = up to 200 postings per crawl. **Total field is only populated on the first page** (offset=0); subsequent pages return `total: 0`, so the "stop when reached total" check is gated on `page === 0`. Real-browser UA required (Cloudflare in front of myworkdayjobs.com rejects bot UAs with HTTP 400). Verified live against Boeing (1,177 jobs, 200 fetched in 8s) and Blue Origin (957 jobs).
- ✅ **LinkedIn** (shipped 2026-05-15): `lib/fetchers/linkedin-fetcher.ts`. GET against the public guest endpoint `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=X&location=Y&start=N`. Returns HTML chunks; parsed with cheerio via `.base-search-card` selectors. Strips tracking params from `href` so dedup works. Cap PAGE_SIZE=25 × MAX_PAGES=2 = 50 postings/crawl + `f_TPR=r86400` (last 24h) filter to keep volume sane. **Fragile by design** — LinkedIn DOM-shifts often; the comment in the file flags the breakage path. Hourly cadence recommended. Verified live: 10 postings returned for "software engineer / Remote".
- ✅ **Email delivery** (shipped 2026-05-15 via OQ1): Gmail OAuth send through `lib/email/send.ts`, dispatched via `lib/notifications/dispatch.ts` at `tier='critical'`. See "Track A — Notification dispatcher" / OQ1 below.
- ✅ **Per-watchlist `each`/`digest`/`silent` mode** (story 26): `Watchlist.notificationMode` column shipped with the MB Phase 2b batch; `each` fires per-posting in real time, `digest` batches into the daily `posting-digest` scheduler job, `silent` skips delivery (postings still land in the DB so they show in the postings feed when the user opens the dash).

#### MB-2.1b — Workday fetcher (deferred — fiddly per-tenant URLs)

Workday has per-tenant JSON endpoints (e.g. `https://<tenant>.wd5.myworkdayjobs.com/wday/cxs/<tenant>/<career-site>/jobs`) with predictable shapes — POST with a small JSON body for pagination/filters. Each tenant has a slightly different URL prefix. Config: `{ tenantHost, careerSite, companyName, locationCountry? }`.

#### MB-2.2 — LinkedIn (story 21)

Separate, slowest cadence (hourly or longer), most rate-sensitive. Its own fetcher with explicit rate-limit handling + user-supplied search URL.

#### MB-2.5 — Per-watchlist notification mode (story 26)

Add `notificationMode: 'each' | 'digest' | 'silent'` to `Watchlist` config. New daily digest scheduler job that batches `'digest'` watchlists and emits one combined `Notification` per user per day.

#### MB-2.6 — Email delivery (Decision 2)

Pick a provider when implementing (Resend most likely — clean SDK, generous free tier). Reads `Notification.channels`; if `'email'` is included, send via the provider. `EMAIL_FROM` + `RESEND_API_KEY` env vars.

### MB Phase 3a — Application-side notifications ✅

Story 27 (🟡). Shipped 2026-05-15.

New helper `maybeNotifyForApplicationEvent(event, userId, companyHint?)` in `lib/repositories/applicationEvents.ts`. Emits a `Notification(kind='application', payload={applicationId, eventId, eventKind})` when an `ApplicationEvent` of kind `INTERVIEW_SCHEDULED` / `OFFER` / `REJECTION` / `ASSESSMENT_REQUESTED` is created. Skips the noisy/self-initiated kinds (APPLIED, STATUS_CHANGED, EMAIL_RECEIVED, NOTE). Wired into both create paths:

- `lib/applications/ingest.ts` (Gmail webhook + classifier funnel) — fires after `createApplicationEvents` for every inserted event, passing the parsed company name as the hint.
- `app/api/applications/events/route.ts POST` (manual create from the detail overlay) — fires after the row creates, with the joined `application.company` as the hint. Also broadcasts `Notification` SSE since the create runs in-process.

Best-effort: notification failures log to `console.warn` and don't fail the caller's create.

### MB Phase 3b — Polish ◐ (partial)

Stories: 28 (🔵), 23 (🔵), 24 (🔵).

#### MB-3.2 — Stale-application nudges ✅

Story 49. Shipped as `scheduler/jobs/stale-applications.ts` (see MA-f.4).

#### MB-3.3 — Quiet hours (story 28) ✅

Shipped 2026-05-22. `GlobalSetting.quietHoursStart`, `quietHoursEnd`, `quietHoursTimezone` — all nullable; quiet hours are off until both Start and End are populated. Migration `add_quiet_hours`. `lib/notifications/quiet-hours.ts:isInQuietHours(now, config)` resolves `now` into the configured IANA zone via `Intl.DateTimeFormat` (DST handled by the host's zoneinfo) and tests against the window. Same-day windows are `[start, end)`; wrap-around windows (`22:00 → 08:00`) are `[start, 24:00) ∪ [00:00, end)`. `dispatchNotification` strips `email` from non-critical dispatches whose timestamp lands inside the window — the row still creates so the bell shows it, but no Gmail send fires. Critical tier (`tier === "critical"` — OFFER / INTERVIEW_SCHEDULED / etc.) bypasses entirely; the user has explicitly opted into 3 a.m. interruptions for those. Hermetic `quiet-hours-smoke.ts` (20/20) covers null-config disablement, invalid HH:MM/timezone degradation, same-day, wrap-around, zero-length window, and a non-UTC tz (`America/Los_Angeles`).

#### MB-3.4 — Negative filters ✅ / compensation parsing (open)

- ✅ **Negative filters** (story 23, shipped `9da9a2d`): per-watchlist `Watchlist.negativeFilters` JSON regex array. `/api/postings` GET applies case-insensitive matching against `title\nsnippet\nlocation`. `?includeFiltered=true` bypass for debug. UI: expandable editor on `WatchlistsCard` with regex validation + count chip. Hermetic smoke at `scripts/tests/hermetic/negative-filters-smoke.ts` (18/18).
- **Compensation** (story 24, shipped 2026-05-22): `lib/postings/compensation.ts:parseCompensation` regex over `(title + snippet + location)` → `compensationMin/Max/Currency/Cadence` columns on `JobPosting`. Migration `add_posting_compensation`. Wired into `scheduler/jobs/job-watcher.ts` at row-create time (legacy rows stay null until next crawl re-extracts). Cadence detection covers `/hr`, `per day/week/month/year`, `annually` / `annual` / `yearly` / `p.a.` (slash patterns rewritten to drop the leading `\b` since spaces before `/` aren't word boundaries). Plausibility guards reject "5,000 employees" / "$1 / hour" garbage. UI: emerald chip on `NewPostingsCard` rows formatted as `$120k–$150k/yr` (or `$60/hr` for hourly). Hermetic `compensation-smoke.ts` (18/18) covers the matrix.

---

### MB Phase 4 — Side-work pipeline ✅

Stories: 56, 57, 58, 59 (🔴) · 60, 61 (🟡) · 62, 63 (🔵 — single-row flip ships, bulk-select still open) · Shipped 2026-05-22.

Why: user is working as a security guard at Crypto Arena while career-hunting and wanted a second pipeline for pay-the-bills gigs so leads don't dilute the career kanban (or vice-versa). Touches both Track A (kanban, ingest, applications API) and Track B (watchlists, postings, scheduler) — filed under B because the bulk of the new wiring is discovery-side. Schema-thin: one new `Watchlist.track` column, one new `Application.track` column, one expanded `@@unique([userId, normalizedCompany, track])` constraint. UI duplicates three cards parameterized by a `track` prop.

Note on naming: the natural name "kind" was already taken on both `Watchlist` (ATS-type discriminator: greenhouse/lever/linkedin/...) and `Application` (pursuit-type: job/internship/college/other), so the new dimension is `track` instead. The two concepts are orthogonal — a side-track `internship` is conceptually fine, as is a career-track `job`.

- **MB-4.1 — Schema migration** ✅. Migration `add_side_track` (applied to dev.db + prod.db on 2026-05-22). Adds `Watchlist.track String @default("career")` with `@@index([userId, track, active])`; adds `Application.track String @default("career")` with `@@index([userId, track])`; replaces `@@unique([userId, normalizedCompany])` with `@@unique([userId, normalizedCompany, track])` so the same employer can coexist as both a career and side application (story 62). Existing 37 watchlists + 37 applications defaulted to `track="career"` on migrate — no backfill needed.
- **MB-4.2 — Watchlist API + scheduler audit** ✅. `lib/schemas/watchlists.ts` adds `WatchlistTrackSchema` + threads `track` through `WatchlistPostSchema` / `WatchlistPatchSchema` / `WatchlistSchema`. `app/api/watchlists/route.ts` GET accepts `?track=career|side` (omitted = all); POST defaults `track="career"`. PATCH on `[id]/route.ts` allows track edits (story 63 single-row flip). **Scheduler unchanged**: `runDueWatchlists()` at `scheduler/jobs/job-watcher.ts:362` filters only by `{active: true}` — both tracks share the same fetcher fleet, so no crawl-loop branching.
- **MB-4.3 — Postings API** ✅. `app/api/postings/route.ts` GET accepts `?track=` and joins via `watchlist: { userId, track }` so each track's `NewPostingsCard` gets its own postings feed. `PostingsListFilter` in `lib/api-client.ts` gains `track?` for query-key partitioning.
- **MB-4.4 — Applications API + ingest dedup** ✅. `lib/schemas/applications.ts` adds `ApplicationTrackSchema` + threads through Post/Patch/list schemas. `lib/repositories/applications.ts` `findApplicationByCompany(userId, company, track)` and `findApplicationBySenderDomain(userId, senderDomain, track)` now scope by track so the same employer-name in opposite tracks doesn't false-dedup. `lib/applications/ingest.ts` hard-codes `ingestTrack = "career"` per story 60 — cold Gmail emails always land on career and the user reclassifies via the inline toggle. `lib/postings/track-as-application.ts` inherits track from the parent watchlist so a side-watchlist posting becomes a side application automatically. All 4 hermetic dedup smokes (`app-race-dedup-smoke`, `find-app-by-company-smoke`, `sender-domain-smoke`, `ingest-retry-smoke`) updated to pass `"career"` and stay green.
- **MB-4.8 — Bulk track move (story 63)** ✅. Shipped 2026-05-22. Adds a `CheckSquare` button to the kanban card header that flips the card into "select mode" — checkboxes appear on each card, taps toggle selection (and stop opening the detail overlay), drag-to-status is suppressed (the same gesture can't simultaneously toggle a checkbox AND start a drag). A footer bar shows `N selected · Move to <other-track> · Cancel`. The bulk action calls `POST /api/applications/bulk-track` with `{ ids, track }`. The route wraps `bulkMoveApplicationsTrack(userId, ids, targetTrack)` from `lib/repositories/applications.ts`, which runs the whole move inside a single Prisma `$transaction`: pre-fetches the rows ownership-scoped by userId (cross-user ids silently drop), checks for same-employer-both-tracks conflicts via a second SELECT against `@@unique([userId, normalizedCompany, track])`, and either runs `updateMany` or returns the conflict list (no partial state). Conflicts come back as HTTP 409 with `{ error: "conflict", conflicts: [...] }`; the UI surfaces them as a toast listing the colliding company names so the user can resolve manually before retrying. Hermetic: `scripts/tests/hermetic/bulk-track-smoke.ts` (17/17) covers happy-path, idempotent re-move, cross-user drop, conflict pre-check, null-normalizedCompany non-conflict, and mixed (some moveable + some already-on-target) batches.
- **MB-4.5 — Card parameterization** ✅. `ApplicationsKanbanCard`, `WatchlistsCard`, `NewPostingsCard`, `AddApplicationModal`, `AddWatchlistModal` each take a new `track?: "career" | "side"` prop (default `"career"` for backward compat). Per-track `TRACK_PRESETS` swap title / icon / accent color / empty-state copy. Side cards use Briefcase icon + amber accents; career stays on existing Mail/Eye/Newspaper + cyan/blue. The 8 kanban status columns are reused as-is. `ApplicationDetailOverlay` gains a Track toggle row beneath Kind for single-click reclassification (story 63 single-row case).
- **MB-4.6 — ApplicationsView wiring** ✅. Two new `<Section>`s appended below `Job Discovery`: "Side Pipeline" (kanban only — calendar + account status are shared above per story 61) and "Side Discovery" (watchlists + new postings). Second `useQuery` keyed `['applications', 'side']` for the side kanban. Second `AddApplicationModal` instance with `defaultTrack="side"`. `invalidateApps` switched to a predicate match (`q.queryKey[0] === 'applications'`) so a single Application SSE event refreshes both kanbans — necessary because a track-flip on a row removes it from one cache and inserts into the other. Optimistic status-change handler detects which cache holds the dragged row and patches the matching one.
- **MB-4.7 — Smoke** ✅. All 33 hermetic suites pass with the new track-aware signatures. Pre-existing `applications-api-smoke.ts` (integration) covers POST/PATCH/DELETE; the track field flows through trivially since the API just passes it to the repository. No new hermetic file added — the dedup-by-track behavior is exercised end-to-end by the manual UI check (create same employer in both tracks; both succeed instead of P2002).

Why MB Phase 4 instead of a new Track D: this is an additive parameterization of existing Track A + B surfaces, not a new track of work. Filing it under MB keeps the cross-track-status-table on this doc readable.

---

## Track C — Profile + resume + GitHub

### M7 — Profile spine ✅

Stories: 29, 31, 32 (partial) (🔴/🟡) · Shipped 2026-05-14 · Commits: `0367263`, `e41b6c0` · Smokes: `scripts/tests/hermetic/profile-repo-smoke.ts` (19/19), `scripts/tests/integration/profile-api-smoke.ts` (17/17 + 9 SSE).

Schema: `Profile`, `WorkRole`, `Project`, `Education` with JSON `bullets` arrays. CRUD API + ProfileView dash + cards (Header / WorkRole / Project / Education / Bullet rows with lock/exclude toggles).

### M7.4 — Multi-resume import (append-merge) ✅

Stories: 30, 30a (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/profile-import-smoke.ts` (PDF + DOCX → 1 work role created, 3 bullets deduped, 5 added, ~14s) · Commit: `329d765`.

Pipeline: `lib/profile/extract.ts` (PDF via pdf-parse v2, DOCX via mammoth, TXT/MD/JSON inline) → `lib/profile/import-llm.ts` (Gemini structured-output extraction) → `lib/profile/merge.ts` (deterministic dedup + append-merge against existing profile). Append-to-repository semantics enforced — no overwrite. `next.config.ts` carries `pdf-parse / mammoth / puppeteer-core / html-to-docx` in `serverExternalPackages`.

### M7.5 — Profile snapshots ◐ (capture shipped, rollback deferred)

Story 33 (🔵). Shipped 2026-05-22. Smoke: `scripts/tests/hermetic/profile-snapshots-smoke.ts` (17/17). Migration: `20260523024735_add_profile_snapshots`.

New `ProfileSnapshot` Prisma model — `(id, userId, takenAt, label?, payload, createdAt)` — captures the full hydrated `Profile` (header + workRoles + projects + education with parsed bullets) as a JSON string. Button-press only — there is **no** auto-snapshot on profile edits (would balloon row count and add a hidden write path the user can't see).

- `lib/repositories/profile-snapshots.ts` — `createProfileSnapshot`, `listProfileSnapshots` (summary projection, ordered newest-first), `getProfileSnapshot` (returns null on corrupt JSON rather than throwing), `deleteProfileSnapshot`. Owner check on every read/delete.
- API: `app/api/profile/snapshots/route.ts` (GET list, POST create) + `app/api/profile/snapshots/[id]/route.ts` (GET full payload, DELETE). All session-gated via `requireSession`.
- `lib/api-client.ts` — `api.profile.snapshots.{list, get, create, delete}` + new `queryKeys.profileSnapshots` / `queryKeys.profileSnapshot(id)`.
- `lib/events.ts` + `hooks/useServerEvents.ts` — `'ProfileSnapshot'` added to the `ModelName` / `ServerEventModel` unions so cross-tab create + delete invalidate the snapshot list.
- UI: `components/cards/ProfileSnapshotsCard.tsx` mounted in a new "History" section on `ProfileView`. Label input (optional, 120 char cap) + "Snapshot now" button + list with delete-per-row.

**Rollback is intentionally not wired yet.** First deliverable is just a read-only safety net so the user can see how their profile looked at past points in time. When/if they actually want to roll back, the path is: open snapshot row → confirm destructive overwrite → transactional bulk-replace of `WorkRole` / `Project` / `Education` rows from the stored payload. The destructive nature is the reason it's deferred — building a half-tested restore path before there's clear demand is more dangerous than the safety net it's meant to provide.

### M7.4 followups — Fuzzy dedup + extra formats 💤 / partial ✅

- ✅ **M7.4-f.4 — Tag editing UI** (story 32). Shipped 2026-05-15. BulletRow now renders each tag as a click-to-remove chip and has an inline "+ tag" affordance. Tags persist via the existing bullet PATCH path (the bullet shape already had `tags: string[]`). Autocomplete from other tags in the profile deferred — current entry experience is fine and autocomplete needs the parent component to thread `allTags` down.
- 💤 **M7.4-f.1 — LLM fuzzy bullet dedup**: current dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity, batched per role to keep token cost down. Deferred because the cost-vs-value of an extra Gemini call per import isn't obvious yet; tag-editing UI lets the user fix this manually.
- 💤 **M7.4-f.2 — LinkedIn export ZIP**: unzip → read `Positions.csv` / `Education.csv` / `Projects.csv` → run through the same merge layer. No LLM needed. Deferred — currently uploading the PDF version of a resume covers the same data.
- 💤 **M7.4-f.3 — Legacy `.doc`**: mammoth handles `.docx` only. Either skip `.doc` with a clearer error or wire a converter (libreoffice CLI? `textract`?). Defer — niche format these days.

### M8 Phase 1 — Tailored resume generation ✅

Story 34 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/resume-e2e-smoke.ts` (47KB PDF in ~11s) · Commit: `b2cbeb6`.

Pipeline: `lib/resumes/posting.ts` (Gemini keyword extraction) → `lib/resumes/select.ts` (deterministic tag-overlap scoring, locked +Infinity, excluded skipped) → `lib/resumes/rewrite.ts` (single Gemini call with hard guardrails) → `lib/resumes/templates/ats-plain.tsx` → `lib/resumes/render-pdf.ts` (puppeteer-core via system Chrome). `GenerateResumeCard` on the Profile dash.

### M8 — DOCX export ✅

Story 38's second half (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/integration/resume-docx-smoke.ts` (30KB DOCX, mammoth round-trip verified) · Commit: `12bfa8c`.

`?format=docx` on the route; same selection + rewrite pipeline; html-to-docx renderer; PDF/DOCX toggle on the trigger card persisted to localStorage. Also bumped default model from `gemini-2.5-flash` to `gemini-flash-latest` (~30–42% faster).

### M8 Phase 2 — Archival + traceability + Application linkage ✅

Stories: 35 (🟡 traceability), 39 (🟡 archival). Shipped 2026-05-15. Smoke: `scripts/tests/integration/resume-archival-smoke.ts` (17/17 green).

- New `GeneratedResume` Prisma model (userId, applicationId?, postingInput, profileSnapshot, selections, templateKey, format, status, artifactPath?, error). Migration `add_generated_resumes`. Reverse relations on User + Application; `Application.posting onDelete:SetNull` so deleting a posting doesn't nuke the archived resume.
- `lib/resumes/storage.ts` — filesystem-backed at `data/resumes/<id>.<ext>` (gitignored with `.gitkeep` retained). `safeRelative` rejects traversal.
- `/api/resumes POST` now persists after a successful render: write artifact → row insert → return bytes + `X-Resume-Id` header. Best-effort: a persistence failure doesn't fail the user's generation.
- New routes: `GET /api/resumes` (list, filter by applicationId), `GET /api/resumes/[id]` (full row including selections, `?includeSnapshot=1` for the heavy profile blob), `GET /api/resumes/[id]/download` (streams artifact, owner-only).
- `POST /api/resumes` body now accepts `applicationId` (defensive: route verifies owner before linking; 400 otherwise).
- **Traceability UI (story 35)**: `GenerateResumeCard` has a "Why these bullets?" expander on the last generation — per selection: source label, original vs rewritten text (line-through diff), matched tags + keywords as chips, score.
- **Per-Application linkage (story 39)**: `ApplicationDetailOverlay` has a new "Resumes for this application" expandable section — lists every linked `GeneratedResume` with format badge + timestamp + download link, plus an inline form to generate one scoped to this application.

Story 36 (lock/exclude UI surfacing) deferred — toggles already exist; just needs better discoverability. Polish-tier.

### M8 Phase 2-followup ✅

- ✅ **M8-2.5** — Lock/exclude bullet UI prominence (story 36). Shipped 2026-05-15. Locked bullets get amber border + always-visible lock icon; excluded bullets get rose border + line-through text + always-visible eye-off icon. Tooltips on hover explain "always include" vs "never include". Section description on the Profile dash's Work History section legends the symbols. Locking and excluding are now mutually exclusive (setting one clears the other).

### M8 Phase 3 — Multi-template + cover letter + skills-gap

**M8-3.1 (multi-template) — ❌ Killed 2026-05-15.** User decision: every target company runs resumes through an ATS parser first (Boeing, Blue Origin, Greenhouse/Lever/Ashby hosts). Visual-polish gain isn't worth the parsing risk on a non-plain template. ATS-plain is final.

**M8-3.2 (cover letter) — ❌ Killed 2026-05-15.** User writes cover letters by hand.

**M8-3.3 (skills-gap report) — ✅ shipped.** `lib/resumes/skills-gap.ts:computeSkillsGap(profile, posting.keywords)` returns the set of posting keywords with no profile bullet (tag or word-boundary substring) evidence. Persisted as `GeneratedResume.skillsGap` (JSON), surfaced under the "Why these bullets?" expander as `SkillsGapBlock` in `GenerateResumeCard.tsx`. Hermetic smoke at `scripts/tests/hermetic/skills-gap-smoke.ts`. PB-4 (2026-05-16) ported the same word-boundary helper into `lib/resumes/select.ts` so the bullet scorer and the gap report agree on what counts as a match.

Stories: 37 (🟡 templates), 40 (🔵 cover letter), 41 (🔵 skills-gap).

### M9 Phase 1 — GitHub-driven project metrics ✅

Stories: 42, 43, 44 (🟡). Shipped 2026-05-15.

- Schema additions (migration `add_project_github_metrics`): `Project.githubRepo` (`owner/repo`), `Project.portfolio` (Boolean default false), `Project.metricsUpdatedAt`. `metrics` JSON already existed from M7.
- `lib/fetchers/github-public-fetcher.ts` — public GitHub REST only (Decision 5). Three calls per repo: `/repos/{o}/{r}`, `/repos/{o}/{r}/languages`, `/repos/{o}/{r}/commits?per_page=1` (the link-header `rel="last"` page approximates `commitsTotal`). Goes through `assertExternalHttpUrl` for symmetry with other fetchers. Errors returned, not thrown.
- `scheduler/jobs/github-metrics.ts` — new PM2 scheduler job at 6h cadence, with a 20h freshness gate inside so each repo is effectively refreshed daily. Skips projects without `portfolio=true` AND `githubRepo` set. Registered as the third job in `scheduler/index.ts`.
- API: `app/api/profile/projects/route.ts` POST/PATCH accept `githubRepo` (zod-validated as `[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`) and `portfolio`. Repository helpers + Prisma types updated.
- Resume template: `lib/resumes/templates/ats-plain.tsx`'s `formatMetricsLine()` renders e.g. "★ 142 · 2,300 commits over 14 months · Go / TypeScript / Python" under the project name when metrics are present. Skip threshold: stars only render at ≥ 5.

### M9 Phase 2 — GitHub UX polish ◐

- **Project portfolio toggle UI** — add a checkbox + repo input on `ProjectCard` so the user can flip projects to portfolio mode without going through Prisma.
- **M9.4 — Suggested-rewrites (story 45) ✅ shipped 2026-05-22.** `lib/profile/metric-deltas.ts:computeMetricDeltas(prev, next)` runs after every metrics refresh. Detects star-threshold crossings against `STAR_MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000]` (highest-only — 4→26 fires once at 25), primary-language flips, new ≥5%-share languages (filters out one-off shell scripts), and commit-count jumps ≥25% AND ≥10 absolute (so tiny repos don't churn). First-ingest (`prev === null`) is silent — only changes fire. Each delta dispatches a `kind='system' tier='standard'` notification with dedupKey `portfolio-rewrite:${projectId}:${type}:${milestone}` so a milestone never re-fires; the commit-jump uses `nextCommits` as the milestone so subsequent jumps key uniquely. Hermetic `metric-deltas-smoke.ts` (16/16).
- **M9.5 — README-as-source (story 46) ✅ shipped 2026-05-22.** `Project.readme` + `readmeUpdatedAt` columns (migration `add_project_readme`, both DBs). New `fetchGithubReadme(ownerRepo)` in `lib/fetchers/github-public-fetcher.ts` — separate from `fetchGithubRepoMetrics` so the metrics hot path stays at 3 API calls. `scheduler/jobs/github-metrics.ts` refreshes README weekly (independent cadence from the 20h metrics gate) — README failures don't tank the metrics refresh for the same project. Stored markdown is truncated at 16 KB at write time to bound row size. Resume rewrite prompt: new optional `ProjectReadmeContext` param on `rewriteBullets`; `app/api/resumes/route.ts` builds the context for project-source bullets actually in the selection (avoids paying tokens on READMEs that aren't surfaced) and slices an additional 2 KB excerpt per project before prompt assembly. Pure prompt builder extracted as `buildRewriteUserPrompt` so the README-context branch is unit-testable; hermetic `readme-prompt-smoke.ts` (13/13) covers no-ctx, empty-ctx, project-only inclusion, multi-bullet dedup (one README per project, not per bullet), selective inclusion (only sourceIds in the selection), truncation at the prompt limit, and empty-string-readme as no-readme.

---

## Cross-cutting

### Route auth hardening ◐

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

### Prompt tuning ⏳

Not a milestone; an ongoing concern. Needs real user data (real resume + real posting) to evaluate, so it's blocked on the user actually applying. Capture failure modes in this section as they're observed:

- *Observed 2026-05-15*: `"applying web development best practices"` — generic filler, no posting hook. Tighten the rule against "applying" + adjective generic-noun patterns.
- *Observed 2026-05-15*: `"web development"` was emphasized in a rewrite because the posting used the phrase even though the original bullet's tags were `typescript`/`nextjs`. Re-confirm prompt rule 6 ("prefer posting wording where the concept matches") isn't being over-applied to generic words.

### Decision log

The five canonical decisions live in `user-stories-applications.md`. Implementation has revealed two extra:

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
| `watchlist-e2e-smoke.ts` | E2E (planned) | Watchlist → fetcher → scheduler → posting → notification |

All smokes assume the dev PM2 process (`mission-control-dev`) is online on `:4101`.
