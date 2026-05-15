# Applications — User Stories

Working list. Priority emoji matches `docs/todo.md` (🔴 = must-have for next ship, 🟡 = important, 🔵 = nice-to-have / later).

## 1. Capture from email

1. 🔴 As a job seeker, when a recruiter emails me, I want the app to detect it automatically so I don't have to manually log every confirmation, rejection, or interview invite.
2. 🔴 As a user signing in for the first time, I want a one-click "Scan inbox" that walks the last 6 months so my pipeline isn't empty.
3. 🔴 As a user, I want re-running a scan to be safe — no duplicate applications, no duplicate timeline rows.
4. 🟡 As a user, I want clearly non-application emails (newsletters, generic marketing, ATS-promo blasts) to be filtered out before they hit the LLM classifier so I'm not paying tokens on noise.

## 2. Pipeline view

5. 🔴 As a user, I want to see all my applications as a kanban (Applied / Phone Screen / Interview / Offer / Rejected) with company, role, and last-update date.
6. 🔴 As a user, I want to drag an application between columns and have that status change persist.
7. 🔴 As a user, I want to manually add an application that didn't come from email (e.g., I applied via a portal that doesn't send confirmation).
8. 🔴 As a user, I want to click into an application and see its full timeline (every email, status change, interview, etc.) in chronological order.

## 3. Calendar integration

9. 🟡 As a user, when an interview gets scheduled (by email or by me), I want it to appear on my Google Calendar automatically with the company/role in the description.
10. 🟡 As a user, if I edit the calendar event in Google Calendar (reschedule, change notes), I want that to flow back into Mission Control.
11. 🟡 As a user, I want to link a calendar event I already made manually ("phone screen with Acme") to an application without duplicating it.
12. 🟡 As a user, I want the upcoming-events widget on the Applications dash to show only interviews & assessments — not every email-received row.

## 4. Manual edits

13. 🟡 As a user, I want to edit any field on an application (company, role, status, next steps) and have it stick.
14. 🟡 As a user, I want to add a free-form note to an application (e.g., "recruiter said decision by Friday").
15. 🟡 As a user, I want to delete an application that was misclassified or no longer relevant.

## 5. Job discovery — crawlers & watchers

16. 🔴 As a user, I want to declare watchlists of job-search criteria (role keywords, locations, seniority, remote ok, salary floor) so the app can hunt on my behalf.
17. 🔴 As a user, I want to add specific company careers pages to a watchlist (e.g., rocketlabusa.com/careers, planet.com/careers, spacex.com/careers) so I get notified the moment they post a relevant role.
18. 🟡 As a user, I want the crawler to support aggregate sources too — LinkedIn Jobs, Greenhouse-hosted boards, Lever-hosted boards, Ashby, Workday — so I don't have to maintain a list of direct URLs for every company.
19. 🔴 As a user, I want each watchlist run to produce a deduped "new postings" feed (URL, company, title, location, posted-at, raw snippet) that I can review without leaving Mission Control.
20. 🟡 As a user, I want to one-click "track" a posting from the feed and have it become a draft Application in `INTERESTED` status, with the listing URL and parsed metadata pre-filled.
21. 🟡 As a user, I want crawlers to run on a schedule (e.g., hourly for LinkedIn, every 6h for direct careers pages) and respect each source's politeness limits — no aggressive scraping that gets the IP blocked.
22. 🟡 As a user, I want the watcher to detect when a posting I've already saved gets *removed* from the source page so I know the role closed.
23. 🔵 As a user, I want to define "negative filters" (companies, technologies, or phrases like "Series A," "on-site only") that auto-hide matching postings from my feed.
24. 🔵 As a user, I want compensation parsed out of postings when present (range, equity hints, location adjustment) so I can sort by it.

## 6. Notification pipeline

25. 🔴 As a user, when the crawler finds a new posting matching a high-priority watchlist, I want a notification (in-app, browser push, optionally email) within minutes — not the next time I open the dashboard.
26. 🟡 As a user, I want a per-watchlist notification preference (e.g., "Rocket Lab — notify on anything new", "LinkedIn — daily digest only") so I'm not pinged for every fuzzy match.
27. 🟡 As a user, I want notifications for application-side events too — interview scheduled, offer received, no response in N days, decision deadline approaching — using the same delivery mechanism as the crawler.
28. 🔵 As a user, I want a "quiet hours" window so notifications don't fire while I'm asleep.

## 7. Resume & professional history

29. 🔴 As a user, I want a structured profile of my work history (roles, companies, dates, responsibilities, skills, accomplishments with metrics) stored once and reused everywhere — not retyped per resume.
30. 🔴 As a user, I want to import my profile from an existing resume (PDF / DOCX / LinkedIn export) so I don't bootstrap it by hand.
31. 🟡 As a user, I want to edit any history entry (add a bullet, fix a date, retire a role) and have the change flow into every future generated resume.
32. 🟡 As a user, I want to tag bullets and accomplishments with skills/keywords (e.g., "Go", "distributed systems", "leadership") so I can filter and surface the right ones per role.
33. 🔵 As a user, I want versioned snapshots of my profile so I can see how my history has been described over time and roll back unintended edits.

## 8. Tailored resume generation

34. 🔴 As a user, given a job posting (URL or pasted text), I want the app to generate a tailored resume that pulls only the most relevant bullets from my profile and reorders them to match the role's emphasis.
35. 🟡 As a user, I want to see *why* each bullet was selected (which keyword in the posting it maps to) so I can sanity-check the output before sending.
36. 🟡 As a user, I want to lock specific bullets as "always include" (e.g., my current role's headline) and exclude others entirely.
37. 🟡 As a user, I want to pick a visual template/style for the generated resume (single-column, two-column, ATS-plain) and have generation respect it.
38. 🔴 As a user, I want the generated resume to be exportable as PDF and DOCX, with the same content rendered identically across both.
39. 🟡 As a user, I want every generated resume archived against the Application it was sent for so I can later say "what version did I send Acme on March 5?"
40. 🔵 As a user, I want a generated cover letter alongside the resume, with the same posting/profile context.
41. 🔵 As a user, I want a "skills gap" report — keywords the posting emphasizes that my profile lacks evidence for — so I know what to address in the cover letter or upskill on.

## 9. GitHub-driven project metrics

42. 🟡 As a user, I want to connect my GitHub account so the app can keep an updated list of my repos, languages used, stars, commit cadence, and notable PRs.
43. 🟡 As a user, I want to flag specific repos as "portfolio" so they're surfaced as project bullets on generated resumes with auto-summarized descriptions and metrics (LOC, language mix, "X commits over Y months", deploy/users if I provide them).
44. 🟡 As a user, I want the project summaries to refresh on a schedule so a resume generated today reflects last week's progress, not a stale snapshot.
45. 🔵 As a user, I want suggested portfolio-bullet rewrites when a repo's metrics meaningfully change (crossed a star threshold, shipped a new language, big release) so my resume stays sharp without me babysitting it.
46. 🔵 As a user, I want to pull READMEs into the profile as source material for bullet generation, not just commit metadata.

## 10. Application document tracking

47. 🟡 As a user, I want to attach the exact resume and cover letter I sent to each Application so the timeline shows the artifacts, not just the events.
48. 🔵 As a user, I want a diff view between two resume versions sent to different companies so I can see what I changed and why.

## 11. Follow-up & nudges

49. 🟡 As a user, I want the app to flag applications where I've had no response in N days (configurable per stage) and offer to draft a follow-up email.
50. 🔵 As a user, I want to track recruiter/hiring-manager contacts per application (name, email, last touched) so follow-ups are addressed to the right person.

## 12. Multi-kind applications

51. 🔵 As a user, I want the same pipeline to handle non-job applications — citizenship, grad school, grants, accelerators — since the schema already supports `kind`. (Decide at MVP: keep the UI job-focused but don't paint into a corner.)

## 13. Future / out of scope for now

52. 🔵 Browser extension for one-click "save this posting" from any careers page (avoids needing every site supported by the crawler).
53. 🔵 Auto-fill of application forms (Greenhouse / Workday / Lever) from the stored profile.
54. 🔵 Interview prep tracker — questions asked per company, my answers, what to brush up on.
55. 🔵 Salary research per company (Levels.fyi / public filings / glassdoor) auto-attached to applications.

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

#### MA — Pipeline writes + drill-in (🔴 stories 5, 6, 7, 8)

Wires the existing Kanban to writes and adds the missing per-application detail view.

- **MA.1 — Write API.** Extend `app/api/applications/route.ts` with `POST` (manual create — story 7), `PATCH` (status + any field — story 6/13), `DELETE` (story 15, deferred until MA-followup but the schema supports it cleanly via cascade). All routes session-gated through `getServerSession` → `findUserByEmail` → ownership check on `Application.userId`. Zod schemas in a new `lib/schemas/applications.ts`. PATCH writes an `ApplicationEvent` of `kind: STATUS_CHANGED` (with `fromStatus`/`toStatus`) whenever status moves — so story 8's drill-in shows status flips alongside email events automatically.
- **MA.2 — Drag-to-status wiring (story 6).** `ApplicationsView` gets an `onStatusChange={(id, newStatus) => api.applications.update({id, status: newStatus})}` on the KanbanWidget, with optimistic update via TanStack `setQueryData` and rollback on error (mirroring the `PlanningView` pattern). Broadcast `Application.upsert` on the server side.
- **MA.3 — Manual add (story 7).** "Add application" button on the Applications dash header opens a small modal: company, role, status (default `APPLIED`), kind (`job` / `internship` / `college` / `other`), optional URL, optional date applied. POST creates the row and (if dateApplied is set) an `ApplicationEvent kind: APPLIED`. No email linkage required.
- **MA.4 — Drill-in timeline (story 8).** Click an application card → opens an overlay (`components/overlays/ApplicationDetailOverlay.tsx`) showing: header (company, role, status as editable chip, dates), timeline (every `ApplicationEvent` for this application, chronologically — `EMAIL_RECEIVED`, `STATUS_CHANGED`, `INTERVIEW_SCHEDULED`, etc., with each event's `title`/`notes`/`scheduledAt`/`occurredAt`), and a footer "Add note" composer. Pulls from the existing `/api/applications/events?applicationId=<id>` route; no new read endpoint needed.
- **MA.5 — Add-note composer (story 14, pulled forward).** The footer in MA.4 calls a new `POST /api/applications/events` with `{applicationId, kind: 'NOTE', title, notes, occurredAt: now}`. Notes are first-class timeline rows, not a separate `Application.notes` column — keeps the timeline as the only thing the user has to read to understand the application's state.
- **MA.6 — API client + types.** New `api.applications.update`, `api.applications.create`, `api.applications.delete`, `api.applications.events.create` in `lib/api-client.ts`. Zod response schemas; query key fanout: `['applications']`, `['applications', 'events', id]`.

Deferred to MA-followup (🟡): inline-edit of arbitrary fields (story 13 — most fields are already edited via status drag + note compose; remaining ones — company/role/nextSteps — get inline edit on the overlay), delete confirmation UI (story 15 — DELETE route ships in MA.1 but the button comes later), kind toggle UI on existing rows (story 51 — schema already supports `kind`, the UI just needs to surface it).

Deferred to track A's second milestone (MA-2, 🟡): document attachment (stories 47–48; ties into M8 resume archival), follow-up nudges (stories 49–50; scheduler job + UI).

### Track B — Job discovery + notifications
Sections §5, §6. Self-contained server work: new scheduler jobs, new tables, a new fetcher strategy. Per Decision 1, all crawler work runs in `mission-control-scheduler` (NOT Pulsar — that boundary is load-bearing).

Current state: `scheduler/index.ts` is a simple `setInterval` runner with one job (`cache-prune`). `lib/fetchers/` has four strategies (rss, scrape, snapi, google-news) used by the company news pipeline. None of the watchlist / posting / notification schema exists yet.

#### MB — Watchlists, crawler, in-app notifications (🔴 stories 16, 17, 19, 25)

Ships a working "hunt on my behalf" loop end-to-end at minimum viable scope: declare a careers-page watchlist, scheduler crawls it, new postings deduplicate into a feed, a notification fires in-app.

- **MB.1 — Schema.** Three new tables:
  - `Watchlist` (id, userId, name, kind: `'careers-page' | 'keyword'`, config JSON, scheduleMinutes Int, lastRunAt DateTime?, lastSuccessAt DateTime?, lastError String?, active Boolean default true). For `careers-page` the config is `{ rootUrl, listingSelector, titleSelector, linkSelector, locationSelector?, postedAtSelector?, snippetSelector? }`. For `keyword` (deferred): `{ source, query, filters }`.
  - `JobPosting` (id, watchlistId, externalId String — stable hash of company+title+link when no native id, company, title, location, postedAt?, snippet?, sourceUrl, status: `'new' | 'tracked' | 'hidden' | 'closed'`, firstSeenAt, lastSeenAt, removedAt?, raw JSON). `@@unique([watchlistId, externalId])` for dedup.
  - `Notification` (id, userId, kind: `'posting' | 'application' | 'system'`, title, body, payload JSON, channels: `'in_app,email'`, createdAt, readAt?, dismissedAt?). Index `[userId, createdAt]`.

  Migration name: `add_watchlists_postings_notifications`. Add `User.watchlists`, `User.notifications` relations.

- **MB.2 — Generic careers-page fetcher.** New `lib/fetchers/careers-page-fetcher.ts`: given the `careers-page` config, fetch the root URL with a politeness-respecting client (single concurrent request per host, 2s min delay between requests to the same host, User-Agent identifying the bot), parse with cheerio, run the configured selectors, return `RawPosting[]`. Reused by the scheduler job — never called from web tier. Errors are reported but don't throw (writes `lastError` on the Watchlist).

- **MB.3 — Scheduler job.** New `scheduler/jobs/job-watcher.ts` exporting `runJobWatcher()`. Registered in `scheduler/index.ts` JOBS array, runs every 10 minutes. Algorithm per tick:
  1. Load all `Watchlist` rows where `active = true` and `lastRunAt < now - scheduleMinutes`.
  2. For each watchlist, fetch via the configured strategy (`careers-page` for MB).
  3. Compute `externalId` per posting (hash of company+title+link).
  4. Upsert into `JobPosting`: new rows → `status: 'new'` + create a `Notification` row (kind: 'posting'); existing rows → bump `lastSeenAt`. Any prior posting *not* in the current fetch result for this watchlist → set `removedAt` and `status: 'closed'` (story 22's groundwork — schema-side support, no UI yet).
  5. Update Watchlist `lastRunAt`/`lastSuccessAt`/`lastError`.

- **MB.4 — Read/write API.**
  - `app/api/watchlists/route.ts` (GET list, POST create) + `[id]/route.ts` (PATCH update, DELETE). Session-gated.
  - `app/api/postings/route.ts` (GET feed; query params: `?status=new&watchlistId=...&limit=50`).
  - `app/api/postings/[id]/route.ts` (PATCH to set status; `tracked` is the one-click "track" from story 20 — pulled forward enough to wire to a future MB-followup "create Application from posting" flow, but no Application creation yet in MB).
  - `app/api/notifications/route.ts` (GET list, PATCH mark-read/mark-all-read). Notifications stream in via SSE using the existing `lib/events.ts` (`Notification.upsert` events).

- **MB.5 — In-app notification surface.** A new corner widget (bell icon in the dash header? or a slide-in overlay? — decide on implementation): unread count badge, dropdown lists recent notifications, click navigates to the posting in the feed. New `lib/api-client.ts` keys: `api.watchlists`, `api.postings`, `api.notifications`. SSE listener via `useServerEvents('Notification', invalidate)`.

- **MB.6 — Watchlists & feed view.** New section in the Applications dash (or a new dedicated "Discovery" dash, TBD when wiring): "Watchlists" card lists active watchlists with last-run status + edit/pause; "New postings" card lists `JobPosting` rows with `status: 'new'`, each with a "Track" / "Hide" button. Editing a watchlist's selectors is a form with inputs for each CSS selector + a "Test" button that runs the fetcher in-process and shows what got parsed (helps the user dial in selectors without waiting for the next scheduler tick).

Deferred to MB-followup (🟡 stories 18, 20, 21, 22, 26, 27):
- **Aggregator strategies** (story 18) — Greenhouse, Lever, Ashby, Workday each have a stable API or a stable HTML shape. One fetcher per source (`greenhouse-fetcher.ts`, etc.) reusing the politeness layer from MB.2.
- **LinkedIn** (story 21's hourly cadence + politeness-sensitive source) — separate, slowest cadence and most-likely-to-get-blocked; needs careful UA + rate strategy.
- **"Track" → draft Application** (story 20) — wires `POST /api/postings/[id]/track` to create an `Application` with `status: 'INTERESTED'` (new status value to add to the enum-by-convention) prefilled from the posting metadata.
- **Closed-posting UI** (story 22) — the schema already records `removedAt`; surface it as a "Closed" filter in the feed and a status badge on tracked postings.
- **Per-watchlist notification preferences** (story 26) — add `notificationMode: 'each' | 'digest'` to Watchlist, and a daily digest job that batches `each: false` watchlists.
- **Application-side notifications** (story 27) — reuse `Notification` table, fire on `ApplicationEvent` create when kind is one of (`INTERVIEW_SCHEDULED`, `OFFER`, `REJECTION`); a separate "no response in N days" scheduler job.
- **Email delivery** (Decision 2) — once a provider is picked, the notification dispatcher reads `channels` and sends via the provider. The scheduler job that fires notifications doesn't need to change.

Deferred to 🔵 round: negative filters (story 23), compensation parsing (story 24), quiet hours (story 28).

### Track C — Profile + resume + GitHub
Sections §7, §8, §9. Unblocked by Decision 4 (Option C). Largest new surface area.

#### M7 — Profile spine + import (🔴 stories 29, 30)

Ships a structured profile model and a way to import an existing resume into it. No resume generation yet (that's M8).

- **M7.1 — Schema.** Add `Profile`, `WorkRole`, `Project`, `Education` to `prisma/schema.prisma`. `WorkRole.bullets` / `Project.bullets` / `Education.bullets` are JSON columns shaped `[{id, text, tags[], locked, excluded}]`. `Project.metrics` JSON column reserved for §9 GitHub job. Migration name `add_profile_spine`. Run against `dev.db`; run separately against `prod.db`.
- **M7.2 — Read/write API.** `app/api/profile/route.ts` (`GET` upserts an empty profile on first call; `PATCH` for header fields). Child routes `app/api/profile/work-roles/route.ts` + `[id]/route.ts`, mirrored for `projects` and `education`. Bullet array writes go through helpers in `lib/profile/bullets.ts`. All routes scope by `userId` from `getServerSession`. No `withCache` — these are user-write paths.
- **M7.3 — `ProfileView` dash.** New dash registered in `BASE_DASHES`, default title + hue in the store, `components/views/ProfileView.tsx`. Sections: Header card (inline-edit identity), Work history (stack of `WorkRoleCard`s with drag-reorder + add-role), Projects (same shape), Education (same shape). Bullets render as `BulletRow`s with lock/exclude toggles. Tag chips read-only this milestone.
- **M7.4 — Import.** `POST /api/profile/import` accepts PDF (`pdf-parse`), DOCX (`mammoth`), LinkedIn export ZIP (unzip → `Positions.csv` / `Education.csv` / `Projects.csv`), or pasted text JSON. Extract → Claude with structured-output prompt → single Prisma transaction that upserts Profile and replaces children. UI is a modal from the ProfileView header with three tabs, drag-drop, and a destructive-overwrite confirmation.
- **M7.5 — Wiring.** `User.profile` relation; TanStack query keys `['profile']` etc.; invalidate the right keys per mutation; let `ProfileView` own its fetching (no preload from `Dashboard`).

Deferred to M7-followup (🟡): tag editing UI on bullets (story 32 — `tags[]` is already in the shape), inline tag autocomplete, profile snapshots/versioning (story 33; `ProfileSnapshot(userId, takenAt, payloadJson)`, button-press-only).

Out of scope (handled in later milestones): resume HTML→PDF rendering (M8), GitHub-driven project metrics (M9 writes to `Project.metrics`).

#### M8 — Tailored resume generation (current focus)

🔴 stories 34, 38. Ships a working "paste posting → get tailored PDF" loop end-to-end at minimum viable scope. Builds on M7's Profile spine — depends on the stable bullet ids and the `tags[]` / `locked` / `excluded` flags already in the bullet JSON shape (Decision 4).

Phase 1 ships the PDF; DOCX, archival, multi-template, cover letter, and skills-gap are deferred phases.

**Phase 1 — PDF MVP**

- **M8.1 — Dependencies.** Add `@google/genai` (Google's unified GenAI SDK; supports Gemini API key flow on the free tier) and `puppeteer-core` (no bundled Chromium — points at the system Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, verified present as Chrome 148.x on this machine). Add `GEMINI_API_KEY` to the untracked `.env` and document it in CLAUDE.md alongside the other secrets. Free-tier Gemini keys come from Google AI Studio (aistudio.google.com).
- **M8.2 — Gemini client wrapper.** New `lib/ai/gemini.ts` exposes `chatJSON<T>({system, user, schema, model?})` where `schema` is a Zod schema validated against the parsed response. Defaults to `gemini-2.0-flash` (free-tier friendly, fast, sufficient for bullet rewriting). Uses `@google/genai`'s `generateContent` with `responseMimeType: 'application/json'` for structured output, wraps retries (429 / 5xx), and surfaces a typed `AIError` on schema failure (so callers can show "couldn't parse posting" rather than a stack trace). All M8 prompts route through this — never construct the SDK inline. Log token usage to `console.info` so the in-app log viewer captures it.
- **M8.3 — Posting parser.** `lib/resumes/posting.ts` exports `parsePosting(input: {url?: string, text?: string}): Promise<ParsedPosting>` where `ParsedPosting = {title?, company?, location?, seniority?, rawText: string, keywords: string[]}`. URL inputs fetch the page, strip with cheerio, and feed the visible text. Keyword extraction is one Claude call: "Return the 10–25 most load-bearing terms from this posting — technologies, methodologies, seniority signals, domain words. JSON array of strings." Cached via `withCache(..., 60 * 60)` keyed on the URL or a hash of the pasted text, so re-generating against the same posting is free.
- **M8.4 — Bullet selection (deterministic).** `lib/resumes/select.ts` exports `selectBullets(profile, keywords): Selection[]`. For each bullet across work roles / projects / education:
  - **Score** = `2 × (tag-overlap count)` + `1 × (case-insensitive substring matches of any keyword inside the bullet text)`.
  - `locked: true` → score is `+Infinity` (always included).
  - `excluded: true` → bullet is skipped entirely.
  - Sort each entity's bullets by score desc; take top N per entity (defaults: work role 4, project 3, education 2). Drop entities whose entire bullet set scored 0 unless the entity is locked at the entity level (a future flag — for now, always include education and the most-recent work role even with zero matches).
  - Output `Selection[]`: `{kind: 'workRole'|'project'|'education', sourceId, bulletId, originalText, score, matchedTags[], matchedKeywords[]}`.
  - Pure / deterministic / no LLM. Easy to unit-test as `scripts/tests/resume-select-smoke.ts`.
- **M8.5 — Bullet rewrite (LLM).** `lib/resumes/rewrite.ts` exports `rewriteBullets(selections, posting): Promise<RewrittenBullet[]>`. Single Claude call. The prompt:
  - Includes the full `Selection[]` plus the posting's keywords + title/company/seniority.
  - Constraints: "lead with strong action verbs; do NOT invent metrics or claims absent from the original; match the posting's terminology where the concept already matches; keep each bullet to ~1 line / ≤ 25 words; preserve the bullet `id` exactly."
  - Returns `[{id, rewrittenText, matchedKeywords[]}]`. Validated by Zod; if any returned id doesn't match an input id, fail loudly.
  - Single call, not per-bullet — keeps token cost predictable (a profile of ~30 bullets stays well inside Sonnet's context).
- **M8.6 — Template + PDF render.** `lib/resumes/templates/ats-plain.tsx` is a server-only React component with no client JS: header (name, headline, links), Experience (work roles with rewritten bullets), Projects, Education. Styling is plain CSS-in-string or a single `<style>` tag in the rendered HTML (no Tailwind in the rendered page — keep the surface minimal for ATS parsers). `lib/resumes/render-pdf.ts` exports `renderResumePDF(props): Promise<Buffer>`:
  - `import { renderToStaticMarkup } from 'react-dom/server'` → wrap in `<!doctype html><html>…</html>` boilerplate.
  - Launch puppeteer with `{ headless: 'new' }`, `await page.setContent(html, { waitUntil: 'networkidle0' })`, `return page.pdf({ format: 'Letter', printBackground: false, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } })`.
  - Browser is **pooled on `globalThis`** to survive HMR and avoid paying the ~1s launch cost per request. Single shared browser, multiple pages per request.
- **M8.7 — API endpoint + trigger UI.** `app/api/resumes/route.ts`:
  - `POST` → body `{posting: {url?, text?}, options?: {template?: 'ats-plain'}}`. Session-gated through `requireSession`. Runs `parsePosting → selectBullets → rewriteBullets → renderResumePDF`. Streams back `application/pdf` with `Content-Disposition: attachment; filename="resume-<company>-<date>.pdf"`.
  - Errors return JSON `{error, stage}` (where `stage` is one of `parse | select | rewrite | render`) so the UI can show a useful failure message.
  - Trigger UI: new `components/cards/GenerateResumeCard.tsx` on the Profile dash. Inputs: URL field + textarea (paste posting). "Generate" button hits the endpoint via `fetch` (NOT TanStack mutation — we want the raw PDF blob). On success, `window.open(URL.createObjectURL(blob))` opens it in a new tab; user can save from there. Don't try to embed an `<iframe>` PDF preview in v1.
  - `api.resumes.generate(...)` helper in `lib/api-client.ts` returning `Promise<Blob>`.

**Phase 1 acceptance criteria:**
- A profile with ≥ 3 work roles and ≥ 3 bullets each produces a one-page PDF in ≤ 15 seconds against a real Greenhouse-hosted posting.
- The PDF opens in Chrome/Preview/Acrobat with no rendering glitches.
- Locked bullets always appear; excluded bullets never appear.
- A bullet's text in the PDF differs from the source bullet only in phrasing — no hallucinated metrics, no fabricated claims.

**Phase 2 — archival + traceability**

- **M8.8 — `GeneratedResume` schema.** New table: `(id, userId, createdAt, postingInput JSON, profileSnapshot JSON, selections JSON, rewrites JSON, templateKey, status enum, pdfPath String?, applicationId String?)`. Each generation gets persisted *after* the PDF renders successfully. `profileSnapshot` is the full hydrated profile at gen-time so future profile edits don't break the archive. `pdfPath` points at `data/resumes/<id>.pdf` (gitignored).
- **M8.9 — Traceability UI (story 35).** A "Why this bullet?" toggle on the trigger UI shows, per selection, the matched keywords + matched tags + score. Reads from the `selections` payload of the last generation.
- **M8.10 — Per-Application linkage (story 39).** Once MA ships the application detail overlay, `applicationId` on `GeneratedResume` lets the timeline show "Resume vN sent on 2026-XX-XX".

**Phase 3 — DOCX (story 38's second half)**

- **M8.11 — DOCX export.** Add `html-to-docx` (or equivalent — evaluate at implementation time). Same templated HTML feeds the converter; `?format=docx` on the API switches the response. Decision 3 explicitly puts this after PDF.

**Deferred to M8-followup (🟡):**
- Multiple templates (story 37) — single-column, two-column, modern, etc. Picker on the trigger UI.
- Lock / exclude UI for bullets (story 36) — schema already supports it via the M7 `BulletRow` toggles, just needs to be exposed prominently.

**Deferred to 🔵 round:**
- Cover letter generation (story 40) — same scaffolding, different prompt + template.
- Skills-gap report (story 41) — posting keywords minus the union of bullet tags + bullet substrings.

#### M9 — GitHub-driven project metrics (later)
🟡 stories 42–43. New scheduler job under `scheduler/jobs/` that hits the public GitHub API for the user's portfolio-flagged `Project` rows and writes into `Project.metrics`. Detailed plan when M7 ships.
