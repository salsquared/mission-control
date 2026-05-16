# Implementation plan

Operational companion to [`docs/user-stories-applications.md`](./user-stories-applications.md). That doc says **what** we're building and **why**; this doc says **how** and **in what order** — concrete file paths, table shapes, API contracts, and acceptance criteria.

Cross-session running state lives in [`docs/next_steps.md`](./next_steps.md): what was just done, what's blocked on whom, today's critical path. This file is durable design; `next_steps.md` is fast-moving status. When a milestone ships, mark it ✅ here and `next_steps.md` gets compacted.

## Status legend

- ✅ Shipped (committed on `main`, smoked end-to-end)
- 🟢 In progress (active branch / open PR / current session)
- ⏳ Planned (designed, sequenced, not yet started)
- 💤 Deferred (intentionally backlogged — story priority is 🟡/🔵 or it's blocked)
- ❌ Killed (decided against; keep the row so the decision doesn't get re-litigated)

Each milestone lists the **user stories** it satisfies (numbers refer to `user-stories-applications.md`).

---

## Track A — Pipeline UX & manual edits

### MA — Pipeline writes + drill-in ✅

Stories: 5, 6, 7, 8 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/applications-api-smoke.ts` (10/10 green) · Commit: `7986aed`.

Already-implemented work surfaced during review: full Kanban writes (drag-to-status with optimistic rollback), manual add modal, drill-in timeline overlay, note composer, applications API CRUD + events. PATCH on status auto-emits a `STATUS_CHANGED` event with correct `fromStatus`/`toStatus`.

Files (load-bearing): `app/api/applications/route.ts`, `app/api/applications/events/route.ts`, `components/views/ApplicationsView.tsx`, `components/overlays/AddApplicationModal.tsx`, `components/overlays/ApplicationDetailOverlay.tsx`.

### MA-followup — Inline edits + document attachment + nudges ⏳

Stories: 13, 14, 15, 47, 48 (🟡) · 49, 50 (🟡).

- **MA-f.1** — Inline-edit of company/role/nextSteps on the detail overlay (story 13). Just exposes existing PATCH fields in the UI; no schema work.
- **MA-f.2** — Delete confirmation UI (story 15). The DELETE endpoint exists.
- **MA-f.3** — Document attachment (stories 47, 48). Wires `GeneratedResume.applicationId` (added in M8 Phase 2) to render "Resume v2 sent on 2026-XX-XX" rows on the timeline. Diff between two sent versions is a 🔵 follow-up.
- **MA-f.4** — Follow-up nudges (stories 49, 50). New scheduler job that flags applications with `lastUpdateAt < now - configurableDays` and creates a `Notification(kind='application')` offering to draft a follow-up. Adds optional `Contact` rows per application later.

Blocked-by: M8 Phase 2 for MA-f.3, MB Phase 1 for MA-f.4 (notifications surface).

---

## Track B — Job discovery + notifications

### MB Phase 1 — Watchlists + crawler + in-app notifications 🟢

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

`scripts/tests/watchlist-e2e-smoke.ts`:
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
Shipped 2026-05-15. Smoke: `scripts/tests/watchlist-phase2-smoke.ts` (10/10 green).

- **MB-2.3 Track→App** — new `POST /api/postings/[id]/track-as-application` creates `Application(status='INTERESTED', kind='job', postingId, role=posting.title)` in a single Prisma transaction and flips `posting.status='tracked'`. Idempotent on re-call (returns the existing Application + `created:false`). UI: "Track as App" button on NewPostingsCard. ApplicationDetailOverlay shows a "Tracked from: <sourceUrl>" line with a "Closed" badge if the underlying posting transitions to closed. Schema: `INTERESTED` added to `APPLICATION_STATUSES` (placed first so kanban order reads interest → applied → ...); `Application.postingId String? @unique` with `onDelete: SetNull` to JobPosting. Migration `add_interested_status_and_posting_link`.
- **MB-2.1 (partial) Lever + Ashby fetchers** — `lib/fetchers/lever-fetcher.ts` (api.lever.co/v0/postings/<slug>) and `lib/fetchers/ashby-fetcher.ts` (api.ashbyhq.com/posting-api/job-board/<slug>). WATCHLIST_KINDS expanded to `["careers-page", "greenhouse", "lever", "ashby"]`. AddWatchlistModal kind picker shows all four with per-kind help text.
- **MB-2.4 Closed-posting detection** — at the end of each scheduler tick (skipped on first run), any non-terminal JobPosting whose `externalId` wasn't in the current fetch set AND whose `lastSeenAt < runAt - 6h` flips to `status='closed', removedAt=runAt`. One `Notification(kind='system')` per watchlist summarizing the closures. The 6h grace window prevents transient feed glitches from prematurely marking postings closed. `RunResult.closed` count exposed via `/api/watchlists/[id]/run`.

### MB Phase 2b — Workday + LinkedIn ✅ / per-watchlist mode 💤

Stories: 18 (Workday), 21 (LinkedIn), 26 (per-watchlist mode) (🟡) · Decision 2 (email — now resolved via OQ1).

- ✅ **Workday** (shipped 2026-05-15): `lib/fetchers/workday-fetcher.ts`. POST to `<tenantHost>/wday/cxs/<tenantSlug>/<careerSite>/jobs` with paginated `{appliedFacets, limit, offset, searchText}`. **Server caps `limit` at 20** (found empirically; values ≥ 25 return HTTP 400); the fetcher uses PAGE_SIZE=20 + MAX_PAGES=10 = up to 200 postings per crawl. **Total field is only populated on the first page** (offset=0); subsequent pages return `total: 0`, so the "stop when reached total" check is gated on `page === 0`. Real-browser UA required (Cloudflare in front of myworkdayjobs.com rejects bot UAs with HTTP 400). Verified live against Boeing (1,177 jobs, 200 fetched in 8s) and Blue Origin (957 jobs).
- ✅ **LinkedIn** (shipped 2026-05-15): `lib/fetchers/linkedin-fetcher.ts`. GET against the public guest endpoint `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=X&location=Y&start=N`. Returns HTML chunks; parsed with cheerio via `.base-search-card` selectors. Strips tracking params from `href` so dedup works. Cap PAGE_SIZE=25 × MAX_PAGES=2 = 50 postings/crawl + `f_TPR=r86400` (last 24h) filter to keep volume sane. **Fragile by design** — LinkedIn DOM-shifts often; the comment in the file flags the breakage path. Hourly cadence recommended. Verified live: 10 postings returned for "software engineer / Remote".
- ✅ **Email delivery** (shipped 2026-05-15 via OQ1): Gmail OAuth send through `lib/email/send.ts`, dispatched via `lib/notifications/dispatch.ts` at `tier='critical'`. See "Track A — Notification dispatcher" / OQ1 below.
- 💤 **Per-watchlist `each`/`digest`/`silent` mode**: now trivially expressible against the tier system (just override `channels` per watchlist). Defer until the per-posting volume actually feels noisy.

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

### MB Phase 3b — Polish ⏳

Stories: 28 (🔵), 23 (🔵), 24 (🔵).

#### MB-3.2 — Stale-application nudges (overlaps MA-f.4)

Daily scheduler job: applications with `lastUpdateAt < now - configurableDays` → `Notification(kind='application')` offering to draft a follow-up.

#### MB-3.3 — Quiet hours (story 28)

User-level setting on `GlobalSetting`: `{ quietHoursStart: '22:00', quietHoursEnd: '08:00', tz }`. Notification dispatcher (the part that delivers to channels) holds delivery until the window opens; in-app stays unaffected. Blocked on email landing — in-app notifications are silent enough on their own that quiet hours aren't needed yet.

#### MB-3.4 — Negative filters + compensation parsing (🔵, stories 23 + 24)

- Negative filters: per-watchlist or global "hide if title/company/snippet matches X". Apply at scheduler-job time (don't even store hidden postings) OR at UI-filter time (store all, hide visually). UI-filter is more discoverable; pick that.
- Compensation: regex over snippet (matches like `$120k`, `$120,000 - $150,000`, `$60/hr`); store on `JobPosting.compensationRangeMin/Max` if present.

---

## Track C — Profile + resume + GitHub

### M7 — Profile spine ✅

Stories: 29, 31, 32 (partial) (🔴/🟡) · Shipped 2026-05-14 · Commits: `0367263`, `e41b6c0` · Smokes: `scripts/tests/profile-repo-smoke.ts` (19/19), `scripts/tests/profile-api-smoke.ts` (17/17 + 9 SSE).

Schema: `Profile`, `WorkRole`, `Project`, `Education` with JSON `bullets` arrays. CRUD API + ProfileView dash + cards (Header / WorkRole / Project / Education / Bullet rows with lock/exclude toggles).

### M7.4 — Multi-resume import (append-merge) ✅

Stories: 30, 30a (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/profile-import-smoke.ts` (PDF + DOCX → 1 work role created, 3 bullets deduped, 5 added, ~14s) · Commit: `329d765`.

Pipeline: `lib/profile/extract.ts` (PDF via pdf-parse v2, DOCX via mammoth, TXT/MD/JSON inline) → `lib/profile/import-llm.ts` (Gemini structured-output extraction) → `lib/profile/merge.ts` (deterministic dedup + append-merge against existing profile). Append-to-repository semantics enforced — no overwrite. `next.config.ts` carries `pdf-parse / mammoth / puppeteer-core / html-to-docx` in `serverExternalPackages`.

### M7.4 followups — Fuzzy dedup + extra formats 💤 / partial ✅

- ✅ **M7.4-f.4 — Tag editing UI** (story 32). Shipped 2026-05-15. BulletRow now renders each tag as a click-to-remove chip and has an inline "+ tag" affordance. Tags persist via the existing bullet PATCH path (the bullet shape already had `tags: string[]`). Autocomplete from other tags in the profile deferred — current entry experience is fine and autocomplete needs the parent component to thread `allTags` down.
- 💤 **M7.4-f.1 — LLM fuzzy bullet dedup**: current dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity, batched per role to keep token cost down. Deferred because the cost-vs-value of an extra Gemini call per import isn't obvious yet; tag-editing UI lets the user fix this manually.
- 💤 **M7.4-f.2 — LinkedIn export ZIP**: unzip → read `Positions.csv` / `Education.csv` / `Projects.csv` → run through the same merge layer. No LLM needed. Deferred — currently uploading the PDF version of a resume covers the same data.
- 💤 **M7.4-f.3 — Legacy `.doc`**: mammoth handles `.docx` only. Either skip `.doc` with a clearer error or wire a converter (libreoffice CLI? `textract`?). Defer — niche format these days.

### M8 Phase 1 — Tailored resume generation ✅

Story 34 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/resume-e2e-smoke.ts` (47KB PDF in ~11s) · Commit: `b2cbeb6`.

Pipeline: `lib/resumes/posting.ts` (Gemini keyword extraction) → `lib/resumes/select.ts` (deterministic tag-overlap scoring, locked +Infinity, excluded skipped) → `lib/resumes/rewrite.ts` (single Gemini call with hard guardrails) → `lib/resumes/templates/ats-plain.tsx` → `lib/resumes/render-pdf.ts` (puppeteer-core via system Chrome). `GenerateResumeCard` on the Profile dash.

### M8 — DOCX export ✅

Story 38's second half (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/resume-docx-smoke.ts` (30KB DOCX, mammoth round-trip verified) · Commit: `12bfa8c`.

`?format=docx` on the route; same selection + rewrite pipeline; html-to-docx renderer; PDF/DOCX toggle on the trigger card persisted to localStorage. Also bumped default model from `gemini-2.5-flash` to `gemini-flash-latest` (~30–42% faster).

### M8 Phase 2 — Archival + traceability + Application linkage ✅

Stories: 35 (🟡 traceability), 39 (🟡 archival). Shipped 2026-05-15. Smoke: `scripts/tests/resume-archival-smoke.ts` (17/17 green).

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

**M8-3.3 (skills-gap report) — 💤 deferred 🔵.** Still useful (posting keywords minus profile bullet tags), but lower priority now that the rest of the M8 stack is done.

Stories: 37 (🟡 templates), 40 (🔵 cover letter), 41 (🔵 skills-gap).

- **M8-3.3 (skills-gap, deferred)**: `posting.keywords` minus the union of (all profile bullet tags + all profile bullet substring matches). Surfaces "the posting talks about X, your profile doesn't mention X" so the user can fill the gap manually.

### M9 Phase 1 — GitHub-driven project metrics ✅

Stories: 42, 43, 44 (🟡). Shipped 2026-05-15.

- Schema additions (migration `add_project_github_metrics`): `Project.githubRepo` (`owner/repo`), `Project.portfolio` (Boolean default false), `Project.metricsUpdatedAt`. `metrics` JSON already existed from M7.
- `lib/fetchers/github-public-fetcher.ts` — public GitHub REST only (Decision 5). Three calls per repo: `/repos/{o}/{r}`, `/repos/{o}/{r}/languages`, `/repos/{o}/{r}/commits?per_page=1` (the link-header `rel="last"` page approximates `commitsTotal`). Goes through `assertExternalHttpUrl` for symmetry with other fetchers. Errors returned, not thrown.
- `scheduler/jobs/github-metrics.ts` — new PM2 scheduler job at 6h cadence, with a 20h freshness gate inside so each repo is effectively refreshed daily. Skips projects without `portfolio=true` AND `githubRepo` set. Registered as the third job in `scheduler/index.ts`.
- API: `app/api/profile/projects/route.ts` POST/PATCH accept `githubRepo` (zod-validated as `[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`) and `portfolio`. Repository helpers + Prisma types updated.
- Resume template: `lib/resumes/templates/ats-plain.tsx`'s `formatMetricsLine()` renders e.g. "★ 142 · 2,300 commits over 14 months · Go / TypeScript / Python" under the project name when metrics are present. Skip threshold: stars only render at ≥ 5.

### M9 Phase 2 — GitHub UX polish 💤

- **Project portfolio toggle UI** — add a checkbox + repo input on `ProjectCard` so the user can flip projects to portfolio mode without going through Prisma.
- **M9.4 — Suggested-rewrites** (🔵 story 45): when `metrics` change meaningfully (crossed 100 stars, shipped a new language, big release), enqueue a `Notification(kind='system')` suggesting the user revisit the project bullets.
- **M9.5 — README-as-source** (🔵 story 46): `GET /repos/{owner}/{repo}/readme` → feed README into the rewrite prompt for portfolio projects.

---

## Cross-cutting

### Prompt tuning ⏳

Not a milestone; an ongoing concern. Needs real user data (real resume + real posting) to evaluate, so it's blocked on the user actually applying. Capture failure modes in this section as they're observed:

- *Observed 2026-05-15*: `"applying web development best practices"` — generic filler, no posting hook. Tighten the rule against "applying" + adjective generic-noun patterns.
- *Observed 2026-05-15*: `"web development"` was emphasized in a rewrite because the posting used the phrase even though the original bullet's tags were `typescript`/`nextjs`. Re-confirm prompt rule 6 ("prefer posting wording where the concept matches") isn't being over-applied to generic words.

### Decision log

The five canonical decisions live in `user-stories-applications.md`. Implementation has revealed two extra:

- **Gemini default model = `gemini-flash-latest`** (2026-05-15). Auto-tracks Google's strongest stable Flash. Measured 30–42% faster than pinning `gemini-2.5-flash`. Override per-call by passing `model` to `chatJSON`.
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
