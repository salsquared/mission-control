# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-14
- **Branch:** `main` (uncommitted Profile dash UI in working tree, not yet committed)
- **Last commit on main:** `b1f7513 feat(profile): add bullets management for work roles, projects, and education`

## Umbrella goal

**Finish `docs/user-stories-applications.md` so the user can apply to jobs and internships ASAP.** That doc is the canonical roadmap — three independent tracks (Track A: pipeline UX; Track B: job discovery + notifications; Track C: profile + resume generation + GitHub). Don't re-derive the plan here; consult that file for milestone definitions (MA, MB, M7, M8, M9).

**Top-level priority order** (chosen for "apply ASAP"):
1. **M7 — Profile spine** (Track C). 95% done; lint-blocked. *In progress.*
2. **M8 — Tailored resume generation** (Track C). The actual feature that produces sendable resumes. Detailed plan to be written once M7 ships.
3. **MA — Pipeline writes + drill-in** (Track A). So applications the user *sends* get tracked end-to-end (manual add, status drag, timeline, notes).
4. **MB — Watchlists + notifications** (Track B). Hunts for new postings. Lower urgency than M8 — the user can hand-source openings; what they can't easily do is hand-tailor a resume per posting.

Out of scope until top-of-stack ships: AI Companion prompt tuning, visual polish, M9 (GitHub-driven project metrics).

## Critical path — current

**M7 finish → commit → M8 design → M8 build → first generated resume → user applies.**

Everything else (MA, MB, M9, follow-ups) is parallelizable behind this.

## Immediate next actions (in order)

1. ~~**Fix lint blockers.**~~ ✅ Done 2026-05-14. Lint is green for all profile-related files (`ProfileView.tsx`, `app/api/profile/route.ts`, plus the three child routes `work-roles/route.ts` / `projects/route.ts` / `education/route.ts` — the audit missed 9 `catch (e: any)` errors in those, all fixed). Wire-type aliases now consumed in `ProfileView.tsx`.
2. ~~**Sign into dev mode + run repo smoke test.**~~ ✅ Done 2026-05-14. **19/19 passed** against `prisma/dev.db` (user `salsalcedo4321@gmail.com`). Covers `findOrCreateProfile` idempotency, header PATCH, full WorkRole/Project/Education CRUD, cross-user ownership, position assignment, bullet normalization, JSON round-trip. Does **not** cover API routes, SSE broadcasts, or concurrency.
    - **Gotcha discovered:** Prisma resolves a relative `DATABASE_URL` from the **schema file's directory** (`prisma/`), not the project root. The correct command is `DATABASE_URL="file:./dev.db" npx tsx scripts/tests/profile-repo-smoke.ts`. The previously-documented `file:./prisma/dev.db` resolves to `prisma/prisma/dev.db` and silently creates an empty DB.
3. ~~**Headless API + SSE smoke.**~~ ✅ Done 2026-05-14. New script `scripts/tests/profile-api-smoke.ts` forges a NextAuth db session against the dev user, exercises the full HTTP surface, and tears the session row down. **17/17 passed:** GET hydration, PATCH header round-trip, POST/PATCH/DELETE on work-roles/projects/education, bullets normalized + `locked` preserved, 400 on bad payload, 404 on unknown id, final GET shows nothing leaked. SSE listener on `/api/events` captured **9 `Profile` broadcasts** matching every successful write (6 upserts + 3 deletes; the 400/404 correctly did not broadcast).
    - **Cookie name gotcha** baked into the script: NextAuth here uses `__Secure-next-auth.session-token` even on `http://localhost` (likely because `NEXTAUTH_URL` is https). The default `next-auth.session-token` returns 401.
    - Re-run later with: `DATABASE_URL="file:./dev.db" npx tsx scripts/tests/profile-api-smoke.ts` (dev server must be on 4101).
4. **Manual UI smoke** (only user-actionable item left before commit). In `npm run dev` on port 4101: open Profile dash → create work role → add bullets → toggle locked/excluded → reorder → reload. Second tab to eyeball `'Profile'` SSE cross-tab sync **in the rendered UI** (the backend pipe is already verified). Confirm or change `viewHue: 280`.
5. **Commit M7 UI.** One commit: `feat(profile): add Profile dash UI`. Bundle cards + view + Dashboard wiring + state wiring + hook union + bullets utility refactor + child-route lint cleanup + new `scripts/tests/profile-api-smoke.ts`. No AI attribution per the `feedback_no_commit_attribution` memory.
6. **Start M8 design.** Read user stories §8 (34, 38 are the 🔴) + Decision 3 (HTML → headless-Chromium print to PDF). Write a milestone-level plan into this doc under "Immediate next actions" before coding.

## In-progress work — M7 (Profile dash UI)

Audit on 2026-05-14 confirmed all of the following are in place — only the lint blockers in step 1 above stand between this and a commit:

- **Committed in `b1f7513`:** schema (`prisma/schema.prisma:168-240`), migration `20260513010032_add_profile_spine`, repos (`lib/repositories/profile.ts`), `lib/profile/`, all four API routes (`app/api/profile/{route.ts,work-roles,projects,education}/route.ts`), Zod schemas.
- **Uncommitted (working tree):**
  - New UI: `components/views/ProfileView.tsx`, `components/cards/{ProfileHeaderCard,WorkRoleCard,ProjectCard,EducationCard}.tsx`, `components/ui/{EditableField,BulletRow}.tsx`.
  - New test: `scripts/tests/profile-repo-smoke.ts`.
  - Wiring: `components/Dashboard.tsx` (registers `'profile'`), `components/providers/state/index.ts` (titles/hues/order, hue `280`), `hooks/useServerEvents.ts` (adds `'Profile'`), `lib/profile/bullets.ts` (`crypto.randomBytes` → `globalThis.crypto.randomUUID`), `lib/schemas/profile.ts` (adds `ProfileWire`/`WorkRoleWire`/`ProjectWire`/`EducationWire`).
- **Verified working:** SSE broadcasts (all 4 routes publish `'Profile'`), api-client coverage (every method `ProfileView` calls exists), `queryKeys.profile = ['profile']`, smoke test coverage, full Prisma field surface.

## Recently completed

- **2026-05-14** — Headless M7 API + SSE smoke green: production `npm run build` clean, unauth probes correctly 401/405, authenticated CRUD via forged session 17/17, SSE captured 9 `Profile` broadcasts matching the writes. Caught a second cookie-name gotcha: `__Secure-next-auth.session-token` is the cookie even on `http://localhost`.
- **2026-05-14** — M7 repo smoke test green: 19/19 against `prisma/dev.db`. Caught a doc bug — `DATABASE_URL`'s relative path resolves from the schema dir (`prisma/`), not the repo root, so the correct value is `file:./dev.db`. Cleaned up the empty phantom `prisma/prisma/dev.db` left by previous attempts.
- **2026-05-14** — M7 lint cleanup. Cleared all 26 profile-related `@typescript-eslint/no-explicit-any` + 1 unescaped-entity errors: 16 in `ProfileView.tsx` (patch-handler params, reorder helper rewritten as 3 per-kind functions, `&quot;` for the literal `"`), 2 in `app/api/profile/route.ts`, and 9 in the three child routes (`work-roles`/`projects`/`education`) that the prior audit had missed. Wire-type aliases now imported and used in `ProfileView.tsx`.
- **2026-05-14** — Refocused `next_steps.md` around the umbrella goal (finish `docs/user-stories-applications.md` to enable applying to jobs/internships ASAP). Dropped the deferred AI Companion question per user direction.
- **2026-05-14** — Audit of M7 readiness: confirmed SSE, API client, query keys, smoke test harness, card components, and Prisma field coverage all green.
- **2026-05-14** — Bullets utility refactor: removed Node-only `crypto` import from `lib/profile/bullets.ts`; ids now via `globalThis.crypto.randomUUID`. Added wire-format type exports to `lib/schemas/profile.ts`.
- **Pre-session (`b1f7513`)** — Profile schema, repos, API routes, and bullets management committed to `main`.
- **Pre-session (`bb9de3f`)** — Google Calendar integration for application events.
- **Pre-session (`6dc24f9`)** — Gmail inbox backfill + multi-kind application classifier.

## Known issues / parked TODOs

- `viewHue: 280` (purple) for Profile dash is a placeholder — confirm at manual-smoke time.
