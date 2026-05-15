# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-15
- **Branch:** `main`. M8 Phase 1 implementation complete; **awaiting `GEMINI_API_KEY` from the user** to verify the happy path end-to-end.
- **Last commits on main:**
  - `e41b6c0 test(profile): add headless API + SSE smoke harness`
  - `0367263 feat(profile): implement work roles, projects, and education management with bullet functionality`

## Umbrella goal

**Finish `docs/user-stories-applications.md` so the user can apply to jobs and internships ASAP.** That doc is the canonical roadmap — three independent tracks (Track A: pipeline UX; Track B: job discovery + notifications; Track C: profile + resume generation + GitHub). Don't re-derive the plan here; consult that file for milestone definitions (MA, MB, M7, M8, M9).

**Top-level priority order** (chosen for "apply ASAP"):
1. ✅ **M7 — Profile spine** (Track C). Shipped 2026-05-14 in `0367263` + `e41b6c0`.
2. **M8 — Tailored resume generation** (Track C). *Current focus.* Detailed plan in `docs/user-stories-applications.md` §M8. Phase 1 produces the first sendable PDF.
3. **MA — Pipeline writes + drill-in** (Track A). So applications the user *sends* get tracked end-to-end (manual add, status drag, timeline, notes).
4. **MB — Watchlists + notifications** (Track B). Hunts for new postings. Lower urgency than M8 — the user can hand-source openings; what they can't easily do is hand-tailor a resume per posting.

Out of scope until top-of-stack ships: AI Companion prompt tuning, visual polish, M9 (GitHub-driven project metrics).

## Critical path — current

**Happy-path verify → first generated resume → user applies.** Phase 2 archival, MA, MB, M7.4 import, M9 are all parallelizable behind this.

## Immediate next actions (in order)

M8 Phase 1 is fully wired. Detailed design lives in `docs/user-stories-applications.md` §M8.

1. ~~**M8.1–M8.7 — Phase 1 build.**~~ ✅ Done 2026-05-15. Dependencies installed (`@google/genai`, `puppeteer-core`), Gemini wrapper at `lib/ai/gemini.ts` (default model `gemini-2.5-flash`; reads `GOOGLE_GENERATIVE_AI_KEY` with `GOOGLE_GEN_AI_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` fallbacks), posting parser at `lib/resumes/posting.ts`, deterministic bullet selection at `lib/resumes/select.ts` (10/10 unit smoke green), Gemini rewrite at `lib/resumes/rewrite.ts`, ATS template + puppeteer renderer at `lib/resumes/templates/ats-plain.tsx` + `lib/resumes/render-pdf.ts` (render smoke produced a valid 62KB PDF in 2.3s), API route at `app/api/resumes/route.ts`, trigger card at `components/cards/GenerateResumeCard.tsx` wired into ProfileView under a new "Resume" section. Production build passes; unauth → 401 and auth+bad-payload → 400 with `{error, stage}` shape both confirmed.
2. **Happy-path verification.** `GOOGLE_GENERATIVE_AI_KEY` is in `.env`. With the dev server on 4101, open the Profile dash → "Resume" section → paste a job posting (URL or text) → "Generate". A PDF should open in a new tab in ≤ 15s. Acceptance criteria (from §M8 Phase 1): one page, locked bullets always present, excluded bullets absent, no hallucinated metrics or claims.
3. **Phase 2 — archival.** If Phase 1 acceptance holds, start §M8 Phase 2 (M8.8 — `GeneratedResume` table; M8.9 — traceability UI; M8.10 — per-Application linkage). Adds the schema + persists each successful generation so the user can later see "which bullets did I send to Acme?".
4. **MA — pipeline writes + drill-in.** Once resumes are reliably generated, MA gives the user the kanban write-paths (manual add, drag-to-status, drill-in timeline, notes). Plan already in `user-stories-applications.md` §MA.1–MA.6.

**Phase 2 deferred (post-MVP):** `GeneratedResume` archival table (story 39), per-bullet traceability surfaced in the UI (story 35), multi-template (story 37 🟡), DOCX export (story 38's DOCX half — Decision 3 says comes after PDF), cover letter (story 40 🔵), skills-gap report (story 41 🔵).

## In-progress work — M8 (Tailored resume generation)

Currently at the **design / pre-implementation** boundary. M7 prerequisites are all landed:
- Profile schema + repos + API routes (commit `0367263`).
- Headless API + SSE smoke harness (commit `e41b6c0`).
- Bullets carry the `tags[]` + `locked` + `excluded` flags M8's selection step depends on.

Open design questions to settle while building Phase 1:
- **API key handling.** `GEMINI_API_KEY` lives in untracked `.env`. M8 is the first AI-dependent feature in the repo; document the var in CLAUDE.md and surface a clear error message if it's missing.
- **Sync vs async.** Phase 1 is synchronous (one request → one PDF). If the rewrite call sometimes exceeds a sensible web-request budget (say 30s), revisit and move generation to a job row + polling in Phase 2.

## Recently completed

- **2026-05-14** — M7 shipped in two commits. `0367263` lands the full Profile dash UI (cards, view, wiring, lint cleanup, repo smoke test). `e41b6c0` adds the headless API + SSE smoke harness that backs up M7 without any browser interaction needed.
- **2026-05-14** — Headless M7 API + SSE smoke green: production `npm run build` clean, unauth probes correctly 401/405, authenticated CRUD via forged session 17/17, SSE captured 9 `Profile` broadcasts matching the writes. Caught the `__Secure-next-auth.session-token` cookie-name gotcha (NextAuth uses the secure-prefixed cookie even on `http://localhost`).
- **2026-05-14** — M7 repo smoke test green: 19/19 against `prisma/dev.db`. Caught a doc bug — `DATABASE_URL`'s relative path resolves from the schema dir (`prisma/`), not the repo root, so the correct value is `file:./dev.db`. Documented in CLAUDE.md.
- **2026-05-14** — M7 lint cleanup. Cleared all 26 profile-related `@typescript-eslint/no-explicit-any` + 1 unescaped-entity errors. Wire-type aliases now imported and used in `ProfileView.tsx`.

## Known issues / parked TODOs

- **Manual UI smoke for M7** is still nominally outstanding (eyeball the Profile dash in `npm run dev`, confirm cards render and drag-reorder works, sanity-check the `viewHue: 280` accent). Backend pipe is verified end-to-end so this is a low-risk visual confirmation, not a blocker. Do it whenever you're next at a browser.
- **M7.4 — Profile import from PDF/DOCX/LinkedIn export** is deferred. M8 doesn't strictly require it (you can type bullets into the Profile dash directly), but it's the next M7-track work after M8 ships. Plan stub lives in `docs/user-stories-applications.md` §M7.4.
- **`viewHue: 280`** (purple) for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts` once you've eyeballed it.
