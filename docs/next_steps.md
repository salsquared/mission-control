# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Companion docs:** [`docs/user-stories-applications.md`](./user-stories-applications.md) (what + why) · [`docs/implementation.md`](./implementation.md) (how + in what order, with milestone status + concrete schema / API / file shapes). This file points at the next concrete thing to do; the others are the canonical references.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-15
- **Branch:** `main`. M7/M7.4/M8 Phase 1+2 ✅, MA ✅, MB Phase 1+2a ✅, M9 ✅. Post-MVP polish in progress — global notification dispatcher, Workday/LinkedIn fetchers, EMAIL_ENABLED kill-switch, and watchlist negative filters all shipped. Hermetic pre-push gate at 9 suites green.
- **Last commits on main:**
  - `90cf9ec fix(email): EMAIL_ENABLED master kill-switch — stop pre-push spam`
  - `1ec936b feat(discovery): Workday + LinkedIn fetchers + kill M8-3.1/3.2`
  - `90398d7 feat: stale-app nudges + portfolio toggle UI + pre-push hermetic gate`
  - `941d3db refactor(notifications): central dispatchNotification API + tier model`
  - `c5c8905 feat(notifications): global bell + re-enable application-event email dispatch`

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

The full Profile → Import → Generate loop is shipped. Detailed designs in `docs/user-stories-applications.md` §M7 + §M8.

1. ~~**M7 + M7.4 + M8 Phase 1 — full Track C loop.**~~ ✅ Done 2026-05-15. Profile dash with CRUD + bullets, multi-file resume import (PDF / DOCX / TXT / JSON) with LLM-extract + dedupe + append merge, tailored resume generation (paste posting → PDF in ~20s). End-to-end smokes all green (19/19 repo + 17/17 API + 10/10 select + valid 62KB synthetic PDF + 47KB real e2e PDF + multi-file import 14s).
2. **Use it for a real application.** Upload your existing resumes via the "Import resumes" card on the Profile dash → review the resulting work roles + bullets → paste a real posting into "Generate" → send. Watch for prompt-quality issues (over-generic rewrites, missed terminology, etc.) — those feed into M8 Phase 2 prompt tuning.
3. **M8 Phase 2 — archival + traceability.** Add `GeneratedResume` table that persists each generation's posting, profile snapshot, selections, and the PDF path. Surface "Why this bullet?" in the UI (story 35). Plan in `docs/user-stories-applications.md` §M8 Phase 2 (M8.8 – M8.10).
4. **MA — pipeline writes + drill-in.** Once resumes flow, MA gives the kanban write-paths (manual add, drag-to-status, drill-in timeline, notes). Plan in `user-stories-applications.md` §MA.1–MA.6.

**Followups inside §M7.4 (not blocking 2):**
- LLM-judged fuzzy bullet dedup (current dedup is exact-text only — "Built a TS API" and "Built a TypeScript API" both survive).
- LinkedIn export ZIP support (separate unzip path that reads `Positions.csv` / `Education.csv`).
- Legacy `.doc` format (mammoth doesn't support it — would need a converter or to skip).
- Per-file progress streaming via SSE so the UI shows "extract → analyze → merge" stages live instead of one long spinner.

## In-progress work

Nothing active. Negative-filters feature shipped (commit pending) — Watchlist.negativeFilters column, /api/postings GET filtering with ?includeFiltered=true bypass, expandable editor on WatchlistsCard, 18-step hermetic smoke wired into pre-push.

## Recently completed

- **2026-05-15** — Watchlist negative filters (M: in post-MVP menu). `Watchlist.negativeFilters String?` (JSON array of regex patterns). API serializers parse to `string[]`; PATCH writes empty-array → NULL. /api/postings GET compiles patterns case-insensitively, matches against `title\nsnippet\nlocation`, supports `?includeFiltered=true` debug bypass. Compile cache keyed by raw JSON. UI: expandable "Negative filters" panel per watchlist row (textarea, per-line patterns, regex validation, count chip when collapsed). `scripts/tests/negative-filters-smoke.ts` covers null/empty/malformed/case/multi-haystack/cache — 18/18.
- **2026-05-15** — EMAIL_ENABLED master kill-switch (`90cf9ec`). Single env gate at `lib/email/send.ts` short-circuits Gmail send. 0 in `.env.development` + `scripts/pre-push.sh`, 1 in `.env.production`. Stops test email spam without ripping out the dispatch wiring.
- **2026-05-15** — Workday + LinkedIn fetchers (`1ec936b`). Workday tenant POST (Boeing + Blue Origin verified live), LinkedIn guest scraper. Workday gotchas locked in: PAGE_SIZE=20 (server cap), per-page AbortSignal, `total` only on first page, Chrome UA mandatory.
- **2026-05-15** — Stale-app nudge job + portfolio toggle + pre-push hermetic gate (`90398d7`). simple-git-hooks running ~9 suites in 3-5s before every push.
- **2026-05-15** — Central notification dispatcher + global bell (`941d3db`, `c5c8905`). Tier-based (critical/standard/low) → channels mapping. Critical-tier pinning + red border in the bell overlay.

## Known issues / parked TODOs

- **Manual UI smoke** is still nominally outstanding (eyeball the Profile dash, confirm cards render / drag-reorder works / Import + Generate cards look right, sanity-check `viewHue: 280`). Backend pipe is verified end-to-end so this is low-risk visual confirmation.
- **LLM fuzzy bullet dedup** — current merge dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity when this becomes painful.
- **LinkedIn export ZIP** — separate unzip path reading `Positions.csv` / `Education.csv`; not wired yet.
- **Legacy `.doc`** — mammoth handles `.docx` only. Either skip or wire a converter.
- **`viewHue: 280`** for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts`.
