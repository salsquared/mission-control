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
- **Branch:** `main`. M7 ✅, M7.4 ✅, M8 Phase 1 ✅. End-to-end verified with PDF + DOCX through the import pipeline. Ready for real-world use.
- **Last commits on main:**
  - `329d765 feat(profile): M7.4 — multi-resume import with append-to-repository merge`
  - `b2cbeb6 feat(resume): M8 Phase 1 — tailored resume generation (Gemini + puppeteer-core)`
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

Nothing active. Track C MVP (profile + import + generation) is end-to-end. Pick from the "Immediate next actions" list above when continuing.

## Recently completed

- **2026-05-15** — M7.4 multi-resume import shipped (`329d765`). PDF + DOCX + TXT + JSON → LLM-extract via Gemini → deterministic dedup → append-merge into the profile repository (story 30a). End-to-end smoke verified: PDF + DOCX with overlapping content yields 1 work role created (deduped across the two files), 3 bullets deduped, 5 added, 14s. `next.config.ts` got `pdf-parse` / `mammoth` / `puppeteer-core` in `serverExternalPackages` to avoid webpack mangling their CJS exports at runtime.
- **2026-05-15** — M8 Phase 1 shipped (`b2cbeb6`). Tailored resume generation end-to-end: paste posting → Gemini keyword extraction → deterministic tag-overlap bullet selection → Gemini rewrite (no invented metrics) → React template → puppeteer-core PDF via system Chrome. Real e2e smoke: 47KB PDF in 19.6s. `GOOGLE_GENERATIVE_AI_KEY` powers it.
- **2026-05-14** — Headless M7 API + SSE smoke harness (`e41b6c0`): 17/17 HTTP CRUD + 9 Profile SSE broadcasts captured. Caught the `__Secure-next-auth.session-token` cookie-name gotcha.
- **2026-05-14** — M7 Profile dash UI shipped (`0367263`). Cards + view + wiring + lint cleanup + repo smoke harness (19/19).

## Known issues / parked TODOs

- **Manual UI smoke** is still nominally outstanding (eyeball the Profile dash, confirm cards render / drag-reorder works / Import + Generate cards look right, sanity-check `viewHue: 280`). Backend pipe is verified end-to-end so this is low-risk visual confirmation.
- **LLM fuzzy bullet dedup** — current merge dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity when this becomes painful.
- **LinkedIn export ZIP** — separate unzip path reading `Positions.csv` / `Education.csv`; not wired yet.
- **Legacy `.doc`** — mammoth handles `.docx` only. Either skip or wire a converter.
- **`viewHue: 280`** for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts`.
