# next_steps.md — Living session context

**Purpose.** Cross-session memory for Claude Code: where the last session left off, what's in flight, the umbrella goal, and the immediate next actions. Code-derivable facts live in CLAUDE.md; *state-derivable* facts (uncommitted work, decisions deferred to "next time", critical-path ordering) live here.

**Companion docs:** [`docs/user-stories.md`](./user-stories.md) (what + why) · [`docs/implementation.md`](./implementation.md) (how + in what order, with milestone status + concrete schema / API / file shapes). This file points at the next concrete thing to do; the others are the canonical references.

**Session protocol** (referenced from CLAUDE.md):
- **At session start** — read this file in full before doing anything else. If "In-progress work" conflicts with what's on disk now (file deleted, commit landed, etc.), update this file before continuing.
- **At session end** — update the sections below: move finished items into "Recently completed" (keep last 3–5), refresh "Critical path" and "Immediate next actions", note anything the user deferred.
- **Date format** — absolute ISO dates (`2026-05-14`), never relative phrasings.

---

## Last session

- **Date:** 2026-05-24 (LLM observability infra + prompt-registry scaffold).
- **Branch:** `main`, 2 commits ahead of `origin/main`. **Two commits landed locally** (not yet pushed):
  - `0581845` — `docs: merge user-stories docs and add §15 local-auth section`. `docs/user-stories-applications.md → docs/user-stories.md` rename + §15 local-auth section addition (S15.1–S15.39 all unbuilt, with 7 inline Open Questions). Cross-refs in `docs/next_steps.md` + `lib/fetchers/github-public-fetcher.ts` updated to the new path.
  - `d9ecd07` — `feat(llm-obs): Lunary tracing + prompt registry + eval harness (LOP-1..5/7/8/10/11)`. Two halves:
    - **LOP-1 → LOP-5 + LOP-10 + LOP-11** — full LLM observability infra wiring + docs. All 9 LLM callsites now traced through Lunary when `LUNARY_PUBLIC_KEY` is set in `.env`; otherwise a true no-op at module-init in `lib/ai/gemini.ts`.
    - **LOP-7 + LOP-8** — prompt blob source-of-truth + Promptfoo eval scaffold. 10 `.md` files under `docs/llm-prompts/`, 14 files under `eval/` (provider + config + 9 suites + 13 fixtures + README), new `npm run test:prompts` script.
- **Final gate state:** pre-push 45/45 hermetic suites green (verified twice — once after LOP-1..5, once after LOP-7..8), typecheck clean, lint clean on touched files. NOT yet pushed.
- **Deferred from this phase:** LOP-6 (per-callsite prompt-registry cutover via `lunary.renderTemplate`) is incremental — needs user to create Lunary templates with matching slugs first. LOP-9 (real fixture captures via `CAPTURE_FIXTURES=1` seam) — needs the seam landed + ~30 min of app use to seed.
- **Dependency note:** installed `promptfoo` with `--legacy-peer-deps` (lunary's optional `openai@^4` peer clashed with promptfoo's required `openai@^6`; lunary doesn't actually need openai for our use). The resolver shuffle dropped `react-is` from the top-level hoist, breaking recharts at build time — pinned `react-is@^19.2.6` directly to guarantee hoisting.
- **Working tree:** clean. Two commits ahead of `origin/main`.

## Umbrella goal

**Apply to jobs.** The `docs/user-stories.md` roadmap is functionally closed — every 🔴 + 🟡 + 🔵 story is shipped, declined, or deferred-by-design. Forward motion now runs through real-world use:

1. Send applications.
2. When the LLM rewrites are off, capture the failure mode in `docs/implementation.md` §Prompt tuning and revise prompts.
3. When something in the pipeline misfires (wrong status classification, missed posting, calendar sync glitch), file it as a follow-up and patch.

Track A (Pipeline UX), Track B (Discovery + notifications), Track C (Profile + resume + GitHub) are all in production. Backups encrypted (RAH-13). Rate limits in place (RAH-12). The MA/MB/M7/M8/M9 milestone scaffolding referenced by older sessions is all behind us; consult `docs/implementation.md` for the per-milestone shipped detail.

## Critical path — current

**Apply, observe, iterate — now backed by structured LLM tracing.** The "apply ASAP" loop is fully closed (capture, kanban + side-track kanban, drill-in, contacts, watchlists, notifications with negative-filter + quiet hours, profile + multi-resume import + snapshots, tailored PDF + DOCX + skills-gap + resume-diff, GitHub metrics + README ingestion). 2026-05-24 added the LLM observability rail on top: every Gemini call lands in Lunary with `name` + tokens + latency when `LUNARY_PUBLIC_KEY` is set; prompt regressions catch in `npm run test:prompts` via Promptfoo. §Prompt tuning's free-text observations fold into Promptfoo fixtures going forward — see `eval/suites/<callsite>.yaml` and `docs/llm-prompts/<slug>.md`.

## Immediate next actions (in order)

1. **Push the two new commits.** `0581845` (doc-merge) + `d9ecd07` (LOP-N infra) are local-only — `git push` when ready. Pre-push gate already verified green; nothing else to gate on.
2. **Activate Lunary tracing.** Sign up at lunary.ai → create project → copy public key → drop `LUNARY_PUBLIC_KEY=<key>` into `.env` → `pm2 restart mission-control-{dev,scheduler-dev,scheduler-prod} --update-env`. Until done, the runtime path is a no-op (no overhead, no events sent). After: every LLM call shows up in the dashboard tagged by its `name`.
3. **LOP-6 per-callsite prompt-registry migration (incremental, opt-in per callsite).** For each callsite worth iterating on: paste `docs/llm-prompts/<slug>.md` into Lunary's UI as a template with the matching slug, then rewire the code to use `lunary.renderTemplate(slug, vars)` instead of inline `SYSTEM_PROMPT` constants. Recommended first: `bullet-assist-fill` + `bullet-assist-rewrite` + `resume-rewrite` (highest iteration churn). Flip the "Migrated to registry?" column in `docs/llm-calls.md` per callsite as they cut over.
4. **LOP-9 real fixture captures.** Add a `CAPTURE_FIXTURES=1` env gate to the start of `chatJSON` that emits `console.info('[FIXTURE]', JSON.stringify({ name, system, user }))`. Then `CAPTURE_FIXTURES=1 pm2 restart mission-control-dev --update-env`, use the app for ~30 min covering the flows you care about, grep the pm2 logs for `[FIXTURE]`, and replace the synthetic-but-realistic seed entries in `eval/suites/*.yaml` with the real captures.
5. **Story S7.6 rollback UX (🔵, deferred-by-design).** Capture side shipped; restore-from-snapshot is the deferred half. Build a destructive-overwrite confirm + transactional bulk-replace of `WorkRole` / `Project` / `Education` from the stored payload. Intentionally not shipped — destructive UI without a real trigger is more risk than safety; pick it up when you've actually made an edit you want to undo.

**Note: every other shippable 🔴/🟡/🔵 story (and both open RAH-N items) is now ✅ or ⛔.** The backlog moves to "real-world use → first applied posting → iterate on prompts." Failure modes captured via the Lunary trace and folded into Promptfoo fixtures rather than free-text in §Prompt tuning. Genuine MVP-followup TODOs from prior sessions (LLM fuzzy bullet dedup, LinkedIn export ZIP, legacy `.doc`, per-file SSE progress, ProjectCard portfolio toggle UI) are still around but none of them block applying.

**User-side follow-ups for RAH-13 (just shipped):**
- **Save the secret key to 1Password.** The file `~/.config/mission-control/backup.key` was generated this session. It's chmod-600 locally, but losing the Mac without an offsite copy means every encrypted backup is unrecoverable. Copy the file's full contents (including the `# created:` / `# public key:` header lines) into a 1Password secure-note titled `mission-control backup secret`.
- **Decrypt-smoke an encrypted backup** to be sure the round-trip works on a real artifact: `./scripts/backup-decrypt.sh ~/backups/mission-control/mc-20260522-201632.db.age` should produce a readable `.db` next to it. (This session already verified the round-trip end-to-end against the live keypair — same 37 Application rows in encrypted+decrypted vs `prisma/prod.db`.)
- **Purge the plaintext history** once decrypt-smoke passes: `rm -f ~/backups/mission-control/mc-*.db ~/backups/mission-control/mc-resumes-*.tar.gz` locally; if rclone is installed, also `rclone delete gdrive:backups/mission-control/ --include "mc-*.db" --include "mc-resumes-*.tar.gz"`. Until then, the security gap stays open on the historical snapshots even though new ones are encrypted.

**Genuine MVP-followup TODOs (cross-cutting, not story-numbered):**
- LLM-judged fuzzy bullet dedup (current dedup is exact-text only — "Built a TS API" and "Built a TypeScript API" both survive).
- LinkedIn export ZIP import support (separate unzip path that reads `Positions.csv` / `Education.csv`).
- Legacy `.doc` import format (mammoth handles `.docx` only).
- Per-file progress streaming via SSE so the UI shows "extract → analyze → merge" stages live instead of one long spinner.
- M9 Phase 2 UX: portfolio-toggle + `githubRepo` input on `ProjectCard` (currently DB-only).

## In-progress work

Nothing in flight. Working tree clean. Branch is 2 commits ahead of `origin/main` (push `0581845` + `d9ecd07` when ready).

**Unattended verifications waiting on user feedback (this session's commit):**

*LLM observability (no UI surface — verify via dashboard + manual eval run):*
- After dropping `LUNARY_PUBLIC_KEY` into `.env` and PM2-restarting with `--update-env`, trigger any LLM path (bullet fill, resume generate, posting parse, an inbound application email) and confirm the run appears in the Lunary dashboard tagged by its `name` (one of: `bullet-assist-fill`, `bullet-assist-rewrite`, `resume-rewrite`, `posting-parse`, `profile-import`, `profile-synthesize`, `discovery-suggest`, `employment-type-classifier`, `email-parser`).
- Run `npm run test:prompts` once end-to-end. Expected: ~30–60 Gemini calls, ~$0.01–0.05 spend, structured pass/fail output. Failures emit diffable JSON to `eval/output/results.json`. First run will likely surface flaky `llm-rubric` assertions on the synthetic fixtures — that's the cue to capture real fixtures (LOP-9) and tighten assertions.

**Unattended verifications still open from prior sessions:**

*Backups / infrastructure (no UI):*
- Confirm `~/.config/mission-control/backup.key` exists and is chmod-600. Run `./scripts/backup-decrypt.sh ~/backups/mission-control/$(ls -t ~/backups/mission-control/*.age | head -1)` once to verify the round-trip works against a real artifact.
- **Save the secret key to 1Password.** Losing the Mac without an offsite copy means every encrypted backup is unrecoverable.

*From 2026-05-22 — UI surfaces probably already verified by now (sweep if anything looks off):*
- Profile dash: "History" section (ProfileSnapshotsCard) + cross-tab SSE delete refresh.
- Applications dash: "Contacts" expander between Timeline and Resumes; ≥2 resume rows show checkboxes → "Compare selected" → inline ResumeDiffPanel; kanban header `CheckSquare` → select-mode → bulk-track footer bar with same-employer-both-tracks conflict toast.
- Postings: emerald comp chips on cleanly-parsed `NewPostingsCard` rows.
- Side-track UI: kanban sections, AddApplicationModal `defaultTrack="side"`, AddWatchlistModal hides career-curated tabs, per-track filter slices independent.
- `/api/system` `cacheStats.hits` actually moves (was pinned at 0 pre-`ae424e8`).

## Recently completed

- **2026-05-24 (LOP-1 → LOP-5 + LOP-7 + LOP-8 + LOP-10 + LOP-11)** — **LLM observability infra + prompt-registry scaffold.** Commit `d9ecd07`. Lunary `wrapModel` integration at module-init in `lib/ai/gemini.ts`, gated on `LUNARY_PUBLIC_KEY` so dev / CI / no-key runs are a true no-op. Required `name: string` field on `ChatJSONOptions` — TypeScript flags every callsite. All 7 chatJSON callsites tagged with stable kebab-case slugs (`bullet-assist-fill`, `bullet-assist-rewrite`, `resume-rewrite`, `posting-parse`, `profile-import`, `profile-synthesize`, `discovery-suggest`, `employment-type-classifier`). `lib/email-parser.ts` bypasses chatJSON (Vercel AI SDK), so it traces manually via `lunary.trackEvent` inside a defensive `safeTrack` helper. New `docs/llm-prompts/` (10 files, one per slug) with verbatim system + user template text + `{{var}}` markers ready to paste into Lunary's template UI for LOP-6 cutover. New `eval/` directory (14 files): TS custom provider `eval/provider.ts` dispatches per-fixture callsite to the real chatJSON-wrapped lib functions; `eval/suites/<slug>.yaml` × 9 with 13 seed fixtures total; `npm run test:prompts` script (NOT in pre-push — burns real Gemini tokens, ~$0.01–0.05/run). `docs/llm-calls.md` gains an Observability section + `Lunary slug` / `Migrated to registry?` columns in the inventory. CLAUDE.md gains an "LLM observability" subsection with the three invariants (name required; iterate via renderTemplate post-cutover; prompt edits ship with Promptfoo fixture updates). Dependency notes: installed `lunary@1.0.18` and `promptfoo@0.121.12 --legacy-peer-deps` (lunary's optional `openai@^4` peer clashed with promptfoo's required `openai@^6` — lunary doesn't need openai for our Gemini-only stack); resolver shuffle dropped `react-is` from the top-level hoist and broke recharts at build, fixed by pinning `react-is@^19.2.6` directly. Pre-push 45/45 hermetic green (verified twice). Typecheck clean. Lint clean on touched files. **NOT yet pushed** — local commit only.
- **2026-05-24 (docs)** — **`docs/user-stories-applications.md` → `docs/user-stories.md` rename + §15 local-auth section.** Commit `0581845`. Combines the applications roadmap with the in-flight local-auth draft into one canonical user-stories doc. Local auth lives at §15 (S15.1–S15.39, all unbuilt) with seven Open Questions inline before any implementation begins. Cross-refs in `docs/next_steps.md` and `lib/fetchers/github-public-fetcher.ts` updated to the new path; remaining refs in `docs/implementation.md` will land with in-flight work that's already modifying it.
- **2026-05-23 (M7.6)** — **LLM bullet assist + resume-upload archive (S7.7 + S7.8 + S7.9).** Commits `7ffd5ba` + `fffa038` (rewrite-tag enhancement). 11 numbered tasks M7.6.1–M7.6.11. `ResumeUpload` table + `data/resume-uploads/` storage holds raw resume bytes from every M7.4 import (the previous discard path was lossy). `lib/profile/bullet-assist.ts` ships fill (3–5 starter bullets on empty entries) + rewrite (single-bullet diff via wand icon) modes grounded on entry spine + sibling bullets + archive spans (S7.9) + project README. `MODEL_LITE` (`gemini-3.1-flash-lite`) — initially tried the non-lite SKU per direction but it 404'd; `-lite` is the only 3.1 variant Google ships. Rate-limited 20 / 10 min. Rewrite mode now returns updated tags reflecting wording shifts (not just text). Hermetic smokes `archive-spans-smoke` + `bullet-assist-smoke` + `resume-uploads-smoke` wired into pre-push. See `docs/implementation.md §M7.6` for the canonical design.
- **2026-05-23 (Track D)** — **Mobile layout MD-0 → MD-7.** Commit `893628a`, ~450 lines net across 11 files. Viewport meta + `useEffectiveMobileLayout` + Dashboard fork into `DesktopShell` / `MobileShell` + framer-motion swipe carousel + Launchpad sheet variant + Auto/Mobile/Desktop preference UI. No schema / API / repository / scheduler changes. Pre-existing desktop card-on-canvas frame preserved verbatim in `<DesktopShell>`; narrow viewports get the edge-to-edge swipe carousel.
- **2026-05-23 (Observability + fetcher-health fixes)** — Five commits in a small fix batch (`fee69ec`, `ba9e222`, `792c2d7`, `e0ff6d6`, `55dccb0`, `ebf9f7a`): self-healing SSE + log-buffer noise trim; kill dev-tier upstream errors flagged in audit; tier-aware log path + auth outside cache for fetcher-health; tighten host-extraction regex; `loggedFetch` wrapper so every external call is counted; implementation status table polish.
- **2026-05-22 (RAH-13)** — **DB backups now encrypted with age.** `scripts/backup-db.sh` reworked: auto-discovers an age recipient at `~/.config/mission-control/backup.pub`, encrypts each artifact in place before either local retention or offsite upload sees it, falls back to plaintext with a loud warning so cron doesn't break before initial key setup. New `scripts/backup-decrypt.sh` companion. **User still needs to copy the secret key to 1Password** — see §Immediate next actions follow-up checklist below the "Note" block.

_(Earlier entries pruned per the 3–5-entry protocol — detail lives in `docs/implementation.md` per-milestone sections + `git log`.)_

## Known issues / parked TODOs

- **Manual UI smoke** is still nominally outstanding (eyeball the Profile dash, confirm cards render / drag-reorder works / Import + Generate cards look right, sanity-check `viewHue: 280`). Backend pipe is verified end-to-end so this is low-risk visual confirmation.
- **LLM fuzzy bullet dedup** — current merge dedup is exact-text only. "Built a TS API" vs "Built a TypeScript API" both survive. Add an LLM "are these the same accomplishment?" pass scoped to one parent entity when this becomes painful.
- **LinkedIn export ZIP** — separate unzip path reading `Positions.csv` / `Education.csv`; not wired yet.
- **Legacy `.doc`** — mammoth handles `.docx` only. Either skip or wire a converter.
- **`viewHue: 280`** for Profile dash is a placeholder — easy one-liner change in `components/providers/state/index.ts`.
