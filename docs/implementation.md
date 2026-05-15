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
- Single source type: `careers-page` (one URL + a link pattern). One fetcher.
- In-app notifications only.
- Manual + auto crawl (user "Run now" button + scheduler every 10 min).
- "Track" / "Hide" actions that move a posting between `status='new'|'tracked'|'hidden'`. No Application creation yet — that ships in MB Phase 2 with the rest of story 20.

**Scope OUT** (deferred to MB Phase 2+):
- Aggregator strategies (Greenhouse, Lever, Ashby, Workday)
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
3. For each `RawPosting`: compute `externalId = sha256(company|title|sourceUrl)` → upsert into `JobPosting`. If row didn't exist → status `'new'` + insert `Notification(kind='posting')`. If row existed → bump `lastSeenAt` (do nothing else).
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

#### MB.5 — Discovery dash

New top-level dash (`'discovery'`) registered in `Dashboard.tsx` `BASE_DASHES`, hue `200` (cyan), under the per-device `'app-state'` Zustand persist.

Two sections:
- **Watchlists** — list with last-run timestamp + last-error chip, per-row actions: Pause toggle, Run now, Edit, Delete. "Add watchlist" modal: name + URL + linkPattern + scheduleMinutes.
- **New postings** — list filtered to `status='new'`, each: company / title / location / `Track` / `Hide` / link to source.

Notifications surface: tiny bell + unread-count in the dash header (or punt to a separate notifications dash). Default: inline in the Discovery dash for Phase 1, full notifications view in a later milestone.

#### MB.6 — End-to-end smoke

`scripts/tests/watchlist-e2e-smoke.ts`:
1. Forge a NextAuth session.
2. Start a tiny local HTTP server serving a hermetic HTML fixture (a fake careers page with 3 known links). Avoid pointing at real external URLs — they go stale and break the smoke.
3. POST a watchlist pointing at the fixture URL with a known `linkPattern`.
4. Call `POST /api/watchlists/[id]/run` (synchronous trigger of the scheduler job for one watchlist).
5. Assert: 3 `JobPosting` rows created with `status='new'`, 3 `Notification` rows created.
6. Re-run the same trigger → no new postings, no new notifications (dedupe verified).
7. PATCH one posting to `status='tracked'`; verify.
8. PATCH all notifications `markAllRead: true`; GET unread → 0.
9. Cleanup: delete posts/watchlist/notifications, tear down session and fixture server.

#### MB Phase 1 acceptance

- Create a watchlist for a real careers page in the UI; within one scheduler tick, ≥ 1 posting appears in the feed.
- Re-running the crawl doesn't duplicate.
- Notification fires on first-seen postings.
- Hide / Track move postings out of the "new" feed.

### MB Phase 2 — Aggregator strategies + email + auto-track ⏳

Stories: 18, 20, 21, 22, 26 (🟡).

#### MB-2.1 — Aggregator fetchers

One module per source under `lib/fetchers/`:
- `greenhouse-fetcher.ts` — Greenhouse has a stable JSON API at `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`. Config: `{ slug }`.
- `lever-fetcher.ts` — Lever has `https://api.lever.co/v0/postings/{slug}`. Config: `{ slug }`.
- `ashby-fetcher.ts` — Ashby exposes a JSON feed at `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`. Config: `{ slug }`.
- `workday-fetcher.ts` — Workday has per-tenant JSON endpoints with predictable shapes. Config: `{ tenantHost, tenantPath }`.

Each module exports `fetch(config): Promise<RawPosting[]>`. The scheduler job dispatches by `watchlist.kind`.

Add `kind` enum values: `'greenhouse' | 'lever' | 'ashby' | 'workday'`. Watchlist config schemas validated per-kind via zod discriminated union.

#### MB-2.2 — LinkedIn (story 21)

Separate, slowest cadence (hourly or longer), most rate-sensitive. Probably its own fetcher with explicit rate-limit handling + user-supplied search URL.

#### MB-2.3 — "Track" → draft Application (story 20)

- Add `'INTERESTED'` to `APPLICATION_STATUSES` enum in `lib/schemas/applications.ts`.
- New route `POST /api/postings/[id]/track-as-application`: creates `Application` with status `INTERESTED`, `company`, `role` from posting, `dateApplied: null`, `kind: 'job'`. Returns `{ application, posting }`.
- Posting status flips to `'tracked'` and a reverse `Application.postingId` reference is recorded (new optional field on Application).
- Drill-in overlay shows the source posting link.

#### MB-2.4 — Closed-posting detection (story 22)

In the scheduler tick, after fetch:
- Any `JobPosting` for this watchlist NOT in the current fetch's `externalId` set, AND last seen > 24h ago → set `removedAt = now`, `status = 'closed'`.
- Notification kind `'system'` summarizing closures: "3 postings from Rocket Lab closed".
- UI: closed badge on tracked postings; "Closed" filter in the feed.

#### MB-2.5 — Per-watchlist notification mode (story 26)

Add `notificationMode: 'each' | 'digest' | 'silent'` to `Watchlist` config. New daily digest scheduler job that batches `'digest'` watchlists and emits one combined `Notification` per user per day.

#### MB-2.6 — Email delivery (Decision 2)

Pick a provider when implementing (Resend most likely — clean SDK, generous free tier). Reads `Notification.channels`; if `'email'` is included, send via the provider. `EMAIL_FROM` + `RESEND_API_KEY` env vars.

### MB Phase 3 — Application-side notifications + polish ⏳

Stories: 27 (🟡), 28 (🔵), 23 (🔵), 24 (🔵).

#### MB-3.1 — Application-side notifications (story 27)

On `ApplicationEvent` create where `kind ∈ { INTERVIEW_SCHEDULED, OFFER, REJECTION }` → emit `Notification(kind='application', payload={applicationId, eventId})`. Reuses the same surface as posting notifications.

#### MB-3.2 — Stale-application nudges (overlaps MA-f.4)

Daily scheduler job: applications with `lastUpdateAt < now - configurableDays` → `Notification(kind='application')` offering to draft a follow-up.

#### MB-3.3 — Quiet hours (story 28)

User-level setting on `GlobalSetting`: `{ quietHoursStart: '22:00', quietHoursEnd: '08:00', tz }`. Notification dispatcher (the part that delivers to channels) holds delivery until the window opens; in-app stays unaffected.

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

### M7.4 followups — Fuzzy bullet dedup + extra formats 💤

Stories: 30a polish, 32 (🟡).

- **M7.4-f.1 — LLM fuzzy bullet dedup**: current dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity, batched per role to keep token cost down. Surface "merged similar bullet" rows in the import preview.
- **M7.4-f.2 — LinkedIn export ZIP**: unzip → read `Positions.csv` / `Education.csv` / `Projects.csv` → run through the same merge layer. No LLM needed (CSV is already structured).
- **M7.4-f.3 — Legacy `.doc`**: mammoth handles `.docx` only. Either skip `.doc` with a clearer error or wire a converter (libreoffice CLI? `textract`?).
- **M7.4-f.4 — Tag editing UI** (story 32): per-bullet tag chips in the BulletRow component with inline-add + autocomplete from existing tags in the profile.

### M8 Phase 1 — Tailored resume generation ✅

Story 34 (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/resume-e2e-smoke.ts` (47KB PDF in ~11s) · Commit: `b2cbeb6`.

Pipeline: `lib/resumes/posting.ts` (Gemini keyword extraction) → `lib/resumes/select.ts` (deterministic tag-overlap scoring, locked +Infinity, excluded skipped) → `lib/resumes/rewrite.ts` (single Gemini call with hard guardrails) → `lib/resumes/templates/ats-plain.tsx` → `lib/resumes/render-pdf.ts` (puppeteer-core via system Chrome). `GenerateResumeCard` on the Profile dash.

### M8 — DOCX export ✅

Story 38's second half (🔴) · Shipped 2026-05-15 · Smoke: `scripts/tests/resume-docx-smoke.ts` (30KB DOCX, mammoth round-trip verified) · Commit: `12bfa8c`.

`?format=docx` on the route; same selection + rewrite pipeline; html-to-docx renderer; PDF/DOCX toggle on the trigger card persisted to localStorage. Also bumped default model from `gemini-2.5-flash` to `gemini-flash-latest` (~30–42% faster).

### M8 Phase 2 — Archival + traceability + Application linkage ⏳

Stories: 35 (🟡 traceability), 36 (🟡 lock/exclude UI surfacing), 39 (🟡 archival).

#### M8-2.1 — `GeneratedResume` schema

```prisma
model GeneratedResume {
  id              String   @id @default(cuid())
  userId          String
  applicationId   String?
  createdAt       DateTime @default(now())
  postingInput    String   // JSON: { url?, text, parsedKeywords[] }
  profileSnapshot String   // JSON: full HydratedProfile at gen time
  selections      String   // JSON: [{ bulletId, sourceKind, sourceId, originalText, rewrittenText, score, matchedTags[], matchedKeywords[] }]
  templateKey     String   @default("ats-plain")
  format          String   // "pdf" | "docx"
  status          String   // "ready" | "failed"
  artifactPath    String?  // data/resumes/<id>.<ext> (gitignored)
  error           String?
  user        User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  application Application? @relation(fields: [applicationId], references: [id], onDelete: SetNull)
  @@index([userId, createdAt])
  @@index([applicationId])
}
```

`data/resumes/` directory added to `.gitignore`. `Application.generatedResumes` reverse-relation.

#### M8-2.2 — Persist on successful generation

After `renderResumePDF`/`renderResumeDOCX` returns, the route writes a `GeneratedResume` row and the artifact to `data/resumes/<id>.<ext>`. On failure, write the row with `status='failed'` + `error` for diagnostics. Return the `id` in a new `X-Resume-Id` header so the UI can link to it later.

#### M8-2.3 — Traceability UI (story 35)

A "Why this bullet?" expander on the trigger card (or a separate "Last generation" pane). For each `Selection`, show: `matchedTags`, `matchedKeywords`, score, original vs rewritten text. Reads from the last persisted `GeneratedResume.selections`.

#### M8-2.4 — Per-Application linkage (story 39 — also serves MA-f.3)

- New "Generate for this application" button on `ApplicationDetailOverlay`. Takes the application's company/role and pre-fills the trigger card, scoped to attach the resulting `GeneratedResume` to that application.
- New "Resumes sent" section on the overlay listing every `GeneratedResume` with `applicationId = this.id`. Each row: format, date, download link, "Generated for posting: <link>" if `postingInput.url` is set.
- Update the timeline to surface resume artifacts as a new `ApplicationEvent.kind = 'RESUME_GENERATED'` (or just keep them in their own pane — decide at implementation time which feels better in the UI).

#### M8-2.5 — Lock/exclude UI surfacing (story 36)

M7 already supports `locked` / `excluded` on bullets via the `BulletRow` toggles, but they're cosmetic. Phase 2 ensures the toggles are discoverable: clearer iconography (lock vs eye-with-slash), tooltips, and a "Locked: always included / Excluded: never included" legend on the dash.

### M8 Phase 3 — Multi-template + cover letter + skills-gap 💤

Stories: 37 (🟡 templates), 40 (🔵 cover letter), 41 (🔵 skills-gap).

- **M8-3.1 — Templates** (story 37): a second template (e.g. `two-column`) lives next to `ats-plain` in `lib/resumes/templates/`. Picker on the trigger card. `GeneratedResume.templateKey` already supports it. Watch ATS-friendliness on any non-plain templates.
- **M8-3.2 — Cover letter** (🔵 story 40): new `lib/resumes/cover-letter.ts` that uses the same Profile + Posting + a different prompt. Output is plain Markdown rendered the same way (PDF via puppeteer, DOCX via html-to-docx).
- **M8-3.3 — Skills-gap report** (🔵 story 41): `posting.keywords` minus the union of (all profile bullet tags + all profile bullet substring matches). Surfaces "the posting talks about X, your profile doesn't mention X" so the user can fill the gap manually or in the cover letter.

### M9 — GitHub-driven project metrics ⏳

Stories: 42, 43, 44 (🟡) · 45, 46 (🔵).

#### M9.1 — Schema additions

- `Project.githubRepo` (String?) — `owner/repo` format
- `Project.portfolio` (Boolean default false) — flagged for resume use
- `Project.metricsUpdatedAt` (DateTime?)
- Already has `metrics` JSON column from M7.

#### M9.2 — Scheduler job

`scheduler/jobs/github-project-metrics.ts`. Per tick (daily): for each `portfolio=true` project with `githubRepo` set, hit GitHub public API:
- `GET /repos/{owner}/{repo}` — stars, language, description
- `GET /repos/{owner}/{repo}/languages` — language mix
- `GET /repos/{owner}/{repo}/commits?per_page=1` — last commit date
- Compute "X commits over Y months" client-side via commit count + first-commit date

Write into `Project.metrics` JSON: `{ stars, primaryLanguage, languageMix, lastCommitAt, commitsTotal, ageDays }`. No OAuth — public API only (Decision 5).

#### M9.3 — Surface in resume template

Resume template reads `metrics` when present and renders a compact "★ 142 · 2,300 commits over 14 months · Go / TypeScript / Python" line under the project name. Bullet selection unchanged.

#### M9.4 — Suggested-rewrites (🔵 story 45)

When `metrics` change meaningfully (crossed 100 stars, shipped a new language, etc.), enqueue a `Notification(kind='system')` suggesting the user revisit the project bullets. Defer until M9.1–M9.3 are real.

#### M9.5 — README-as-source (🔵 story 46)

`GET /repos/{owner}/{repo}/readme` → use README as additional context for the rewrite prompt (per-project, when generating). Defer until prompts are stable.

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
