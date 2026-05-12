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

### ⚠ 4. Profile schema — needs your call. Expanded:

The two paths and what they actually buy or cost:

**Option A — Normalized tables.** Roughly:
- `Profile` (userId, headline, summary)
- `WorkRole` (profileId, company, title, startDate, endDate, location)
- `Bullet` (roleId, text, order, locked, excluded) — atomic resume line
- `Skill` (name, category)
- `BulletSkill` (bulletId, skillId) — many-to-many tag table
- `Project` (profileId, name, repoUrl, description, metricsJson)
- `ProjectSkill` (projectId, skillId)
- `Education` (profileId, institution, degree, dates)

Pros:
- Story 32 ("tag bullets by skill") and Story 34 ("pick the most relevant bullets per posting") become a SQL query — `SELECT bullet WHERE skill IN (posting_keywords) ORDER BY relevance`. No LLM judgement required for selection, only for *rewriting* the chosen bullets to fit the role.
- Story 35 ("show *why* each bullet was selected") works because every selected bullet has a stable id and a known tag overlap with the posting.
- Story 36 ("lock specific bullets, exclude others") is a column on `Bullet`.
- Editing a single bullet is one UPDATE; doesn't rewrite the whole profile.
- Versioning is per-row (snapshot table or audit trail).

Cons:
- 6–8 new tables, a non-trivial migration, more UI to build (one form per entity type).
- Story 30 ("import from PDF/DOCX/LinkedIn") still needs an LLM extraction step to *map* free-form bullets into the normalized shape. The import work doesn't shrink — it just produces structured output instead of a blob.
- More schema to keep stable while we iterate.

**Option B — Single JSON blob per user.** One row in `Profile` with a `profileJson` column.

Pros:
- Ships fast. The import step is "dump the PDF text into the blob, ask the user to clean it up in a textarea."
- No migrations when the profile's mental model shifts.
- Snapshot versioning is "copy the blob" — Git-style.

Cons:
- Bullet selection (story 34) becomes "LLM, here's my whole profile, here's the posting, return a tailored resume." It works, but it's opaque and slow per generation. Traceability (story 35) is weak.
- "Lock a bullet" / "exclude a bullet" (story 36) needs every bullet to have stable IDs *inside* the blob, which is half-normalized anyway.
- Filtering / dashboards on top of the profile (e.g., "show me every bullet tagged Go") require either loading every blob into memory or maintaining a denormalized index.

**My recommendation:** Option A. Sections 7–8 (the actual differentiator) lean on tag-driven bullet selection. The blob shortcut makes the first import easier and the first generation harder — and we're going to do the generation many times.

But this is a real fork in the road; pick the one you'll actually maintain.

### ✅ 5. GitHub access — public API only

No OAuth scope to maintain. We pull public repo metadata (commits, languages, stars, READMEs). Private repos are out of scope; if you want one represented on a resume you can add it manually as a `Project` row.
