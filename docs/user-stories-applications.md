# Applications — User Stories

Working list. Priority emoji: **🔴** must-have for next ship, **🟡** important, **🔵** nice-to-have / later. **✅** = shipped end-to-end (verified against the codebase on 2026-05-15). **◐** = partial / in-scope-only (one half shipped, other half explicitly out-of-scope by Decision). **⛔** = user-declined.

**Implementation status, sub-milestones, file paths, and concrete API/schema shapes live in [`docs/implementation.md`](./implementation.md).** This doc says *what* and *why*; that one says *how* and *in what order*. Cross-session running state lives in [`docs/next_steps.md`](./next_steps.md).

## 1. Capture from email

1. 🔴 ✅ As a job seeker, when a recruiter emails me, I want the app to detect it automatically so I don't have to manually log every confirmation, rejection, or interview invite.
2. 🔴 ✅ As a user signing in for the first time, I want a one-click "Scan inbox" that walks the last 6 months so my pipeline isn't empty.
3. 🔴 ✅ As a user, I want re-running a scan to be safe — no duplicate applications, no duplicate timeline rows.
4. 🟡 ✅ As a user, I want clearly non-application emails (newsletters, generic marketing, ATS-promo blasts) to be filtered out before they hit the LLM classifier so I'm not paying tokens on noise.

## 2. Pipeline view

5. 🔴 ✅ As a user, I want to see all my applications as a kanban (Applied / Phone Screen / Interview / Offer / Rejected) with company, role, and last-update date.
6. 🔴 ✅ As a user, I want to drag an application between columns and have that status change persist.
7. 🔴 ✅ As a user, I want to manually add an application that didn't come from email (e.g., I applied via a portal that doesn't send confirmation).
8. 🔴 ✅ As a user, I want to click into an application and see its full timeline (every email, status change, interview, etc.) in chronological order.

## 3. Calendar integration

9. 🟡 ✅ As a user, when an interview gets scheduled (by email or by me), I want it to appear on my Google Calendar automatically with the company/role in the description.
10. 🟡 ✅ As a user, if I edit the calendar event in Google Calendar (reschedule, change notes), I want that to flow back into Mission Control.
11. 🟡 ✅ As a user, I want to link a calendar event I already made manually ("phone screen with Acme") to an application without duplicating it.
12. 🟡 ✅ As a user, I want the upcoming-events widget on the Applications dash to show only interviews & assessments — not every email-received row.

## 4. Manual edits

13. 🟡 ✅ As a user, I want to edit any field on an application (company, role, status, next steps) and have it stick.
14. 🟡 ✅ As a user, I want to add a free-form note to an application (e.g., "recruiter said decision by Friday").
15. 🟡 ✅ As a user, I want to delete an application that was misclassified or no longer relevant.

## 5. Job discovery — crawlers & watchers

16. 🔴 ✅ As a user, I want to declare watchlists of job-search criteria (role keywords, locations, seniority, remote ok, salary floor) so the app can hunt on my behalf.
17. 🔴 ✅ As a user, I want to add specific company careers pages to a watchlist (e.g., rocketlabusa.com/careers, planet.com/careers, spacex.com/careers) so I get notified the moment they post a relevant role.
18. 🟡 ✅ As a user, I want the crawler to support aggregate sources too — LinkedIn Jobs, Greenhouse-hosted boards, Lever-hosted boards, Ashby, Workday — so I don't have to maintain a list of direct URLs for every company.
19. 🔴 ✅ As a user, I want each watchlist run to produce a deduped "new postings" feed (URL, company, title, location, posted-at, raw snippet) that I can review without leaving Mission Control.
20. 🟡 ✅ As a user, I want to one-click "track" a posting from the feed and have it become a draft Application in `INTERESTED` status, with the listing URL and parsed metadata pre-filled.
21. 🟡 ✅ As a user, I want crawlers to run on a schedule (e.g., hourly for LinkedIn, every 6h for direct careers pages) and respect each source's politeness limits — no aggressive scraping that gets the IP blocked.
22. 🟡 ✅ As a user, I want the watcher to detect when a posting I've already saved gets *removed* from the source page so I know the role closed.
23. 🔵 ✅ As a user, I want to define "negative filters" (companies, technologies, or phrases like "Series A," "on-site only") that auto-hide matching postings from my feed.
24. 🔵 As a user, I want compensation parsed out of postings when present (range, equity hints, location adjustment) so I can sort by it.

## 6. Notification pipeline

25. 🔴 ✅ As a user, when the crawler finds a new posting matching a high-priority watchlist, I want a notification (in-app, browser push, optionally email) within minutes — not the next time I open the dashboard.
26. 🟡 ✅ As a user, I want a per-watchlist notification preference (e.g., "Rocket Lab — notify on anything new", "LinkedIn — daily digest only") so I'm not pinged for every fuzzy match.
27. 🟡 ✅ As a user, I want notifications for application-side events too — interview scheduled, offer received, no response in N days, decision deadline approaching — using the same delivery mechanism as the crawler.
28. 🔵 As a user, I want a "quiet hours" window so notifications don't fire while I'm asleep.

## 7. Resume & professional history

29. 🔴 ✅ As a user, I want a structured profile of my work history (roles, companies, dates, responsibilities, skills, accomplishments with metrics) stored once and reused everywhere — not retyped per resume.
30. 🔴 ✅ As a user, I want to import my profile from an existing resume (PDF / DOCX / LinkedIn export) so I don't bootstrap it by hand.
30a. 🔴 ✅ As a user, I want my profile to act as a master repository of resume material I can tailor from — not a single "current" resume. I want to upload one resume or many (over time, across roles), and have the LLM recognize duplicate items (same role, same bullet, near-identical wording across uploads) and merge them with what I've already captured, while adding any genuinely new items. Over months of applications this should *accumulate* into a richer pool, never overwrite it, so any future tailored resume can pull the strongest evidence from across my whole history.
31. 🟡 ✅ As a user, I want to edit any history entry (add a bullet, fix a date, retire a role) and have the change flow into every future generated resume.
32. 🟡 ✅ As a user, I want to tag bullets and accomplishments with skills/keywords (e.g., "Go", "distributed systems", "leadership") so I can filter and surface the right ones per role.
33. 🔵 ◐ As a user, I want versioned snapshots of my profile so I can see how my history has been described over time and roll back unintended edits. *(Capture side shipped 2026-05-22 — `ProfileSnapshot` table, button-triggered "Snapshot now" + list with delete on `ProfileView`. Rollback / restore-from-snapshot intentionally deferred until the read-only safety net proves useful.)*

## 8. Tailored resume generation

34. 🔴 ✅ As a user, given a job posting (URL or pasted text), I want the app to generate a tailored resume that pulls only the most relevant bullets from my profile and reorders them to match the role's emphasis.
35. 🟡 ✅ As a user, I want to see *why* each bullet was selected (which keyword in the posting it maps to) so I can sanity-check the output before sending.
36. 🟡 ✅ As a user, I want to lock specific bullets as "always include" (e.g., my current role's headline) and exclude others entirely.
37. 🟡 ⛔ As a user, I want to pick a visual template/style for the generated resume (single-column, two-column, ATS-plain) and have generation respect it. *(User decision 2026-05-15: every target company runs resumes through an ATS parser; visual-polish gain isn't worth the parsing risk on a non-plain template. `ats-plain.tsx` is final. See `implementation.md` M8 Phase 3.)*
38. 🔴 ✅ As a user, I want the generated resume to be exportable as PDF and DOCX, with the same content rendered identically across both.
39. 🟡 ✅ As a user, I want every generated resume archived against the Application it was sent for so I can later say "what version did I send Acme on March 5?"
40. 🔵 ⛔ As a user, I want a generated cover letter alongside the resume, with the same posting/profile context. *(User decision: writing cover letters by hand. OOS.)*
41. 🔵 ✅ As a user, I want a "skills gap" report — keywords the posting emphasizes that my profile lacks evidence for — so I know what to address in the cover letter or upskill on.

## 9. GitHub-driven project metrics

42. 🟡 ✅ As a user, I want to connect my GitHub account so the app can keep an updated list of my repos, languages used, stars, commit cadence, and notable PRs. *(Per Decision 5: public API only, no OAuth — user sets `githubRepo` per Project.)*
43. 🟡 ✅ As a user, I want to flag specific repos as "portfolio" so they're surfaced as project bullets on generated resumes with auto-summarized descriptions and metrics (LOC, language mix, "X commits over Y months", deploy/users if I provide them).
44. 🟡 ✅ As a user, I want the project summaries to refresh on a schedule so a resume generated today reflects last week's progress, not a stale snapshot.
45. 🔵 As a user, I want suggested portfolio-bullet rewrites when a repo's metrics meaningfully change (crossed a star threshold, shipped a new language, big release) so my resume stays sharp without me babysitting it.
46. 🔵 As a user, I want to pull READMEs into the profile as source material for bullet generation, not just commit metadata.

## 10. Application document tracking

47. 🟡 ◐ As a user, I want to attach the exact resume and cover letter I sent to each Application so the timeline shows the artifacts, not just the events. *(Resume side ✅ — `GeneratedResume.applicationId` links each gen to its app. Cover-letter side is OOS — see story 40.)*
48. 🔵 ✅ As a user, I want a diff view between two resume versions sent to different companies so I can see what I changed and why. *(Shipped 2026-05-22 — `lib/resumes/diff.ts:computeResumeDiff` + `/api/resumes/diff`. UI: multi-select two rows in the Resumes section on `ApplicationDetailOverlay`, "Compare selected" reveals an inline panel with posting-keyword deltas, bullet-selection deltas, and shared-bullet rewrite differences side-by-side.)*

## 11. Follow-up & nudges

49. 🟡 ✅ As a user, I want the app to flag applications where I've had no response in N days (configurable per stage) and offer to draft a follow-up email.
50. 🔵 ✅ As a user, I want to track recruiter/hiring-manager contacts per application (name, email, last touched) so follow-ups are addressed to the right person. *(Shipped 2026-05-22 — `Contact` table per Application, CRUD via `/api/applications/contacts`, expandable "Contacts" section on `ApplicationDetailOverlay`. Stale-application nudges (story 49) now address the suggestion to the primary contact by first name when one exists.)*

## 12. Multi-kind applications

51. 🔵 ✅ As a user, I want the same pipeline to handle non-job applications — citizenship, grad school, grants, accelerators — since the schema already supports `kind`. (Decide at MVP: keep the UI job-focused but don't paint into a corner.)

## 13. Side-work pipeline

Story 51 already proved the schema can carry multiple `kind`s through one pipeline. This section is the next axis: a parallel pipeline for *gig / blue-collar / pay-the-bills* applications, run alongside the career pipeline on the same dash. Background: the user is working as a security guard at Crypto Arena while career-hunting, and gig leads (barista, warehouse, delivery driver) shouldn't dilute the career kanban or vice-versa. Watchlists for this side are keyword-first (job type) rather than employer-first.

56. 🔴 ✅ As a user juggling a security-guard job at Crypto Arena, I want a second pipeline for gig / blue-collar applications so leads I send for "barista" or "warehouse" don't dilute my career kanban.
57. 🔴 ✅ As a user, I want side-track watchlists to take *keywords* (job-type queries like "delivery driver Los Angeles") instead of specific companies, since gig hunting is type-first not employer-first.
58. 🔴 ✅ As a user, I want a separate kanban for side-track applications with the same status columns (Interested → Applied → … → Rejected) so the workflow is familiar.
59. 🔴 ✅ As a user, I want side-track new-postings to surface in their own feed card so I can scan gig leads independently of career leads.
60. 🟡 ✅ As a user, when a gig employer cold-emails me (no prior watchlist), I want the application to default to career and be easy to reclassify with one click — I'd rather flip a wrong one than train a classifier.
61. 🟡 ✅ As a user, I want the same Calendar widget and Account Status card to serve both tracks — interviews are interviews, and I only have one Gmail account.
62. 🔵 ✅ As a user, I want the same employer to be allowed in both tracks as separate applications (e.g., Starbucks barista in side, Starbucks corporate role in career) so dedup doesn't silently merge them.
63. 🔵 ✅ As a user, I want to bulk-move applications between tracks if I miscategorize a batch (e.g., realized after the fact a Costco "operations associate" was actually corporate). *(Shipped 2026-05-22 — `CheckSquare` button on each kanban header enters select mode; checkboxes appear on cards; a "Move to <other-track>" action moves the whole selection in one transactional `POST /api/applications/bulk-track`. Same-employer-both-tracks conflicts surface as a 409 with the offending rows listed, no partial state.)*

## 14. Future / out of scope for now

52. 🔵 Browser extension for one-click "save this posting" from any careers page (avoids needing every site supported by the crawler).
53. 🔵 Auto-fill of application forms (Greenhouse / Workday / Lever) from the stored profile.
54. 🔵 Interview prep tracker — questions asked per company, my answers, what to brush up on.
55. 🔵 Salary research per company (Levels.fyi / public filings / glassdoor) auto-attached to applications.

---

## Status snapshot (2026-05-22)

- **All 🔴 must-haves shipped** (20/20 including §13 side-track 🔴 stories 56–59). The end-to-end "apply ASAP" loop — capture, kanban, drill-in, watchlists, notifications, profile + import, tailored resume with PDF + DOCX, plus the parallel side-work pipeline — is in production.
- **🟡: 27 total, 25 ✅ + 1 ◐ + 1 ⛔.** Story **47** is ◐ partial — resume side shipped, cover-letter side OOS by user decision (story 40). Story **37** is ⛔ user-declined (2026-05-15). All other 🟡 closed.
- **🔵 shipped: 8/13** (stories **23** negative filters, **33** profile snapshots ◐ capture only, **41** skills-gap, **48** resume diff, **50** recruiter contacts, **51** multi-kind, **62** same-employer-both-tracks, **63** bulk-move tracks). User-declined: **40** (cover letter). Genuinely open: **24** (comp parsing), **28** (quiet hours), **45** (suggested rewrites), **46** (README ingestion).
- **🔵 future / OOS:** 52–55.

**Next-up candidates** (small surface, real leverage): **24** compensation parsing; **46** README ingestion; **45** suggested portfolio rewrites.

---

## Decisions

### ✅ 1. Crawler runtime — `mission-control-scheduler` (NOT Pulsar)

Pulsar is strictly financial ingestion (crypto, stocks, FRED) and that boundary is load-bearing. Crawlers, watchers, and any non-financial recurring jobs live in the existing `mission-control-scheduler` PM2 process (`scheduler/index.ts`), which already shares the Prisma client and `prisma/prod.db` with the web tier under SQLite WAL.

Implication: new files for this work go under `scheduler/jobs/` (e.g., `scheduler/jobs/job-watcher.ts`). The web tier exposes read/write API routes; the scheduler ticks the cron and writes results into the shared DB. Mission Control is "just a frontend and interface" — it does not host the long-running crawlers in-process.

### ✅ 2. Notification delivery — in-app + email

Email is in scope; we'll need it for other notification surfaces in Mission Control anyway, so the work amortizes. SMS / push are deferred. Provider TBD when we wire it up (Resend / Postmark / nodemailer-via-Gmail are all on the table; pick when implementing).

### ✅ 3. Resume rendering — HTML → print-to-PDF (headless browser)

Templates live as React/HTML components. PDF export goes through a headless-Chromium print job (Puppeteer or Playwright). DOCX export comes later from the same templated HTML via an HTML→DOCX converter, so visual templates are defined once.

### ✅ 4. Profile schema — Option C (hybrid spine + JSON bullets)

A small set of "spine" tables for queryable structure, with bullets stored as JSON arrays on the entity that owns them. Picked over fully-normalized (A) and pure blob (B) as the right balance of selection ergonomics and schema stability for a single-user dataset.

Tables:
- `Profile` (userId, headline, summary, location, email, phone, linksJson)
- `WorkRole` (profileId, company, title, location, startDate, endDate, bulletsJson, order)
- `Project` (profileId, name, description, repoUrl, liveUrl, bulletsJson, metricsJson, order)
- `Education` (profileId, institution, degree, field, startDate, endDate, bulletsJson, order)

Each `bulletsJson` is `[{ id, text, tags: string[], locked: bool, excluded: bool }]` — bullet `id` is stable (cuid generated client- or server-side, stored inside the JSON).

Why this shape:
- **Selection (story 34)** stays SQL-ish: pull all bullets for a user (a handful of rows → a few hundred bullets total), filter by tag overlap with posting keywords in JS. LLM only rewrites the chosen bullets; it doesn't select.
- **Traceability (35) / lock / exclude (36)** all key off the stable bullet id.
- **Edit a bullet (31)** reads the owning row, mutates the JSON array, writes the row. Cheap for one user.
- **Skill tags** are denormalized strings inside each bullet — no `Skill`/`BulletSkill` join tables. Re-tagging means re-running the LLM tagger.
- **Versioning (33)** = snapshot table per spine entity (each row's prior state copied on edit), simpler than per-bullet audit rows.
- **Schema churn** stays low: adding "Publications" or "Talks" later is one new spine table, not a four-table migration.

Disfavored alternatives:
- **Option A (fully normalized)** — `Bullet`, `Skill`, `BulletSkill`, etc. Most ergonomic at query time, but 6–8 tables and the most schema-churn risk as the profile model evolves.
- **Option B (single JSON blob)** — fastest to ship but every generation pays LLM tokens to re-read the whole profile, and lock/exclude needs ids inside the blob anyway.
- **Option D (blob + denormalized BulletIndex)** — blob as canonical with a projected index. Rejected because the projection becomes the new thing that can silently drift.

### ✅ 5. GitHub access — public API only

No OAuth scope to maintain. We pull public repo metadata (commits, languages, stars, READMEs). Private repos are out of scope; if you want one represented on a resume you can add it manually as a `Project` row.

---

## Milestones

Tracks are independent (different code surfaces, can be sequenced or parallelized). Each milestone scopes to the 🔴 stories in its section; 🟡/🔵 stories live in a follow-up milestone of the same track.

### Track A — Pipeline UX & manual edits
Sections §2, §4, §10–12. Frontend-heavy; builds on existing `Application` + `ApplicationEvent`. Closest to user-visible value.

Current state (what already works): the Kanban view in `components/views/ApplicationsView.tsx` renders applications grouped by status across five columns (Applied / Assessment / Interviewing / Offer / Archive). `KanbanWidget` already supports drag-and-drop via an `onStatusChange` callback. The Gmail webhook + multi-kind classifier ingests new applications and writes `ApplicationEvent` rows. What's missing is *every write path from the UI* — status, manual add, edits, notes, delete — plus the per-application drill-in.

#### MA — Pipeline writes + drill-in (🔴 stories 5, 6, 7, 8) ✅ shipped

Verified end-to-end on 2026-05-15 (`scripts/tests/integration/applications-api-smoke.ts`, 10/10 green): POST manual create, PATCH status auto-emits a `STATUS_CHANGED` event with correct `fromStatus`/`toStatus`, POST `NOTE` events, GET timeline returns chronological events, DELETE removes from list, empty PATCH validates 400. The work below was already implemented (route + UI + api-client) before MA was reviewed — flagging here for traceability:

- **MA.1 — Write API.** Extend `app/api/applications/route.ts` with `POST` (manual create — story 7), `PATCH` (status + any field — story 6/13), `DELETE` (story 15, deferred until MA-followup but the schema supports it cleanly via cascade). All routes session-gated through `getServerSession` → `findUserByEmail` → ownership check on `Application.userId`. Zod schemas in a new `lib/schemas/applications.ts`. PATCH writes an `ApplicationEvent` of `kind: STATUS_CHANGED` (with `fromStatus`/`toStatus`) whenever status moves — so story 8's drill-in shows status flips alongside email events automatically.
- **MA.2 — Drag-to-status wiring (story 6).** `ApplicationsView` gets an `onStatusChange={(id, newStatus) => api.applications.update({id, status: newStatus})}` on the KanbanWidget, with optimistic update via TanStack `setQueryData` and rollback on error (mirroring the `PlanningView` pattern). Broadcast `Application.upsert` on the server side.
- **MA.3 — Manual add (story 7).** "Add application" button on the Applications dash header opens a small modal: company, role, status (default `APPLIED`), kind (`job` / `internship` / `college` / `other`), optional URL, optional date applied. POST creates the row and (if dateApplied is set) an `ApplicationEvent kind: APPLIED`. No email linkage required.
- **MA.4 — Drill-in timeline (story 8).** Click an application card → opens an overlay (`components/overlays/ApplicationDetailOverlay.tsx`) showing: header (company, role, status as editable chip, dates), timeline (every `ApplicationEvent` for this application, chronologically — `EMAIL_RECEIVED`, `STATUS_CHANGED`, `INTERVIEW_SCHEDULED`, etc., with each event's `title`/`notes`/`scheduledAt`/`occurredAt`), and a footer "Add note" composer. Pulls from the existing `/api/applications/events?applicationId=<id>` route; no new read endpoint needed.
- **MA.5 — Add-note composer (story 14, pulled forward).** The footer in MA.4 calls a new `POST /api/applications/events` with `{applicationId, kind: 'NOTE', title, notes, occurredAt: now}`. Notes are first-class timeline rows, not a separate `Application.notes` column — keeps the timeline as the only thing the user has to read to understand the application's state.
- **MA.6 — API client + types.** New `api.applications.update`, `api.applications.create`, `api.applications.delete`, `api.applications.events.create` in `lib/api-client.ts`. Zod response schemas; query key fanout: `['applications']`, `['applications', 'events', id]`.

**MA-followup ✅ also shipped:** inline-edit of `company` / `role` / `nextSteps` on the overlay (story 13 — `EditingField` state in `ApplicationDetailOverlay.tsx:37`), delete confirmation UI (story 15 — `Trash2` button + `window.confirm` at line 218), kind toggle UI on existing rows (story 51 — `kind` patch wired at line 146).

**MA-2 (🟡): partial.** Resume-side of stories 47–48 ships via `GeneratedResume.applicationId` linkage. Cover-letter side OOS per story 40 user-decline. Story 49 follow-up nudges ✅ shipped via `scheduler/jobs/stale-applications.ts`. Story 50 recruiter contacts still open.

### Track B — Job discovery + notifications
Sections §5, §6. Self-contained server work: new scheduler jobs, new tables, a new fetcher strategy. Per Decision 1, all crawler work runs in `mission-control-scheduler` (NOT Pulsar — that boundary is load-bearing).

Current state: `scheduler/index.ts` is a simple `setInterval` runner with one job (`cache-prune`). `lib/fetchers/` has four strategies (rss, scrape, snapi, google-news) used by the company news pipeline. None of the watchlist / posting / notification schema exists yet.

#### MB — Watchlists, crawler, in-app notifications (🔴 stories 16, 17, 19, 25) ✅ shipped

- **MB.1 — Schema.** Three new tables:
  - `Watchlist` (id, userId, name, kind: `'careers-page' | 'keyword'`, config JSON, scheduleMinutes Int, lastRunAt DateTime?, lastSuccessAt DateTime?, lastError String?, active Boolean default true). For `careers-page` the config is `{ rootUrl, listingSelector, titleSelector, linkSelector, locationSelector?, postedAtSelector?, snippetSelector? }`. For `keyword` (deferred): `{ source, query, filters }`.
  - `JobPosting` (id, watchlistId, externalId String — stable hash of company+title+link when no native id, company, title, location, postedAt?, snippet?, sourceUrl, status: `'new' | 'tracked' | 'hidden' | 'closed'`, firstSeenAt, lastSeenAt, removedAt?, raw JSON). `@@unique([watchlistId, externalId])` for dedup.
  - `Notification` (id, userId, kind: `'posting' | 'application' | 'system'`, title, body, payload JSON, channels: `'in_app,email'`, createdAt, readAt?, dismissedAt?). Index `[userId, createdAt]`.

  Migration name: `add_watchlists_postings_notifications`. Add `User.watchlists`, `User.notifications` relations.

- **MB.2 — Generic careers-page fetcher.** New `lib/fetchers/careers-page-fetcher.ts`: given the `careers-page` config, fetch the root URL with a politeness-respecting client (single concurrent request per host, 2s min delay between requests to the same host, User-Agent identifying the bot), parse with cheerio, run the configured selectors, return `RawPosting[]`. Reused by the scheduler job — never called from web tier. Errors are reported but don't throw (writes `lastError` on the Watchlist).

- **MB.3 — Scheduler job.** New `scheduler/jobs/job-watcher.ts` exporting `runJobWatcher()`. Registered in `scheduler/index.ts` JOBS array, runs every 10 minutes.

- **MB.4 — Read/write API.** `app/api/watchlists`, `app/api/postings`, `app/api/notifications`.

- **MB.5 — In-app notification surface.** Global bell overlay reachable from every dash (`components/overlays/NotificationBell.tsx`), critical-tier pinning + red border.

- **MB.6 — Watchlists & feed view.** `WatchlistsCard` + `NewPostingsCard` on the Applications dash.

**MB-followup ✅ also shipped:**
- **Aggregator strategies** (story 18) — `greenhouse-fetcher.ts`, `lever-fetcher.ts`, `ashby-fetcher.ts`, `workday-fetcher.ts`, `linkedin-fetcher.ts`. Six fetchers total covering the source matrix.
- **LinkedIn** (story 21's hourly cadence + politeness-sensitive source) — guest scraper, fragile by design; per-page `AbortSignal` + Chrome UA.
- **"Track" → draft Application** (story 20) — `POST /api/postings/[id]/track-as-application` creates an `Application` with `status: 'INTERESTED'` prefilled from posting; writes a NOTE timeline event with the source URL.
- **Closed-posting UI** (story 22) — surfaced as `status: 'closed'` + `removedAt` in the postings feed.
- **Application-side notifications** (story 27) — central `lib/notifications/dispatch.ts` fires on application events.
- **Email delivery** (Decision 2) — Gmail OAuth via `lib/email/send.ts`; `EMAIL_ENABLED` master kill-switch gates dispatch.

**Still open in MB-followup:**
- **Per-watchlist notification preferences** (story 26) — would add `notificationMode: 'each' | 'digest'` to Watchlist + a daily digest scheduler job.

**🔵 round:** negative filters (story 23) ✅ shipped. Still open: compensation parsing (story 24), quiet hours (story 28).

### Track C — Profile + resume + GitHub
Sections §7, §8, §9. Unblocked by Decision 4 (Option C). Largest new surface area.

#### M7 — Profile spine + import (🔴 stories 29, 30) ✅ shipped

- **M7.1 — Schema.** `Profile`, `WorkRole`, `Project`, `Education` in `prisma/schema.prisma`. `bullets` JSON column shaped `[{id, text, tags[], locked, excluded}]`. Migration `add_profile_spine` applied.
- **M7.2 — Read/write API.** `app/api/profile/route.ts` + `work-roles`, `projects`, `education` subroutes.
- **M7.3 — `ProfileView` dash.** Mounted, default title + hue, cards stacked.
- **M7.4 — Import.** `POST /api/profile/import` with PDF / DOCX / TXT / JSON, multi-file in one upload, LLM extract → dedupe → append-merge.
- **M7.5 — Wiring.** TanStack keys + SSE invalidation.

**M7-followup ✅ also shipped:** tag editing UI on bullets (story 32), lock/exclude toggles + persistent badges (story 36). Still open: profile snapshots/versioning (story 33).

#### M8 — Tailored resume generation ✅ shipped (Phases 1 + 2 + 3)

🔴 stories 34, 38.

**Phase 1 — PDF MVP** ✅ shipped via `b2cbeb6`. `lib/ai/gemini.ts`, `lib/resumes/posting.ts`, `lib/resumes/select.ts` (deterministic; honors `locked` / `excluded`), `lib/resumes/rewrite.ts`, `lib/resumes/templates/ats-plain.tsx`, `lib/resumes/render-pdf.ts`, `app/api/resumes/route.ts`, `GenerateResumeCard`.

**Phase 2 — archival + traceability** ✅ shipped via `43404ed`. `GeneratedResume` table with `applicationId` linkage (story 39). "Why these bullets?" trace UI on `GenerateResumeCard` (story 35).

**Phase 3 — DOCX** ✅ shipped via `12bfa8c`. Same template feeds an HTML→DOCX converter.

**M8-followup still open:**
- Multiple templates (story 37) — only `ats-plain.tsx` exists.

**🔵 round:** skills-gap (story 41) open. Cover letter (story 40) declined.

#### M9 — GitHub-driven project metrics ✅ shipped

🟡 stories 42–44. `scheduler/jobs/github-metrics.ts` hits the public GitHub API for `Project.githubRepo`-flagged rows and writes into `Project.metrics`. `Project.portfolio` flag drives which repos refresh + surface on resumes (story 43). Per Decision 5 — no OAuth, user specifies `githubRepo` per Project.

**M9-followup (🔵) still open:** suggested portfolio rewrites (story 45), README ingestion (story 46).
