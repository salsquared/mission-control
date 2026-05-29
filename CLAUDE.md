# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session protocol — read on every start, update on every end

`docs/next_steps.md` is the living cross-session context doc (last session state, in-flight work, open questions, parked TODOs).

- **At the start of every session**, read `docs/next_steps.md` in full before touching the codebase. Reconcile it against current `git status` / on-disk state — if the file claims work is in progress that's already landed or been discarded, fix the doc first.
- **At the end of every session** (or when the user signals they're wrapping: "ok done", "let's stop here", "save progress", or before a context handoff), update `docs/next_steps.md`: move finished items into "Recently completed" (keep ~3–5), refresh "In-progress work" / "Open questions", and use absolute ISO dates (e.g. `2026-05-14`) — never relative ones.
- **Every commit MUST be paired with a `docs/next_steps.md` update in the same logical step** — at minimum reflect "In-progress work" / "Recently completed" / "Last session" so the doc never lies about what's landed. The update can live in the same commit or an immediately-following commit, but it must precede the next user-visible pause. Skipping this is what makes session handoffs lossy.
- **Every `git push` MUST flush `docs/next_steps.md` to match `origin/main` reality before the push** — the doc on the remote is the canonical handoff for a fresh clone or the next session. Before pushing, recheck: do "In-progress work" and "Last session" still describe what's about to be on `origin`? If not, update + commit the doc, THEN push (so the push includes the doc bump). Never push commits and leave next_steps stale on the remote.
- The doc is for *state-derivable* facts (uncommitted work, decisions deferred to "next time"). Code-derivable facts (architecture, conventions) belong in this CLAUDE.md, not there.

## Commands

**Both tiers run under PM2.** This is the canonical setup — do NOT run `npm run dev` / `npm run start` ad-hoc; PM2 already owns the ports and will fight you for them.

| PM2 process | Port | DB | Backing script |
| --- | --- | --- | --- |
| `mission-control-dev` | 4101 | `prisma/dev.db` (via `.env.development`) | `npm run dev` |
| `mission-control` | 3101 | `prisma/prod.db` (via `.env.production`) | `npm run start` (compiled build) |
| `mission-control-scheduler-dev` | — | `prisma/dev.db` | `scheduler/index.ts` (`MC_SCHEDULER_TIER=dev`) |
| `mission-control-scheduler-prod` | — | `prisma/prod.db` | `scheduler/index.ts` (`MC_SCHEDULER_TIER=prod`) |

One scheduler per tier — they're independent. Each scheduler logs with a `[SCHEDULER:<tier>]` prefix. If a tier's DB is schema-behind (Prisma `P2021`, e.g. prod.db is currently missing `Watchlist`/`JobPosting`/etc.), the affected job emits one loud warning and is disabled for that process's lifetime — so the schema-behind tier doesn't spam errors every tick. Bring the lagging DB current with `npx prisma migrate deploy` (point `DATABASE_URL` at the target SQLite first) and `pm2 restart mission-control-scheduler-<tier>` to re-enable.

Dev runs on Turbopack (`npm run dev` → `next dev --turbopack`); prod build stays on webpack (`npm run build`) — don't flip without re-running `npm run test:hermetic` (CSS hashing + prerender behavior differ subtly).

Non-obvious scripts: `./launch-ms.sh` (prod launcher, `--restart` recreates the PM2 process); `npm run test:integration` aborts unless `mission-control-dev` is online — bypass with `SKIP_INTEGRATION_TESTS=1`.

### Pre-push hook (mandatory gate before reaching `main`)

`scripts/pre-push.sh` runs the full hermetic suite (every file under `scripts/tests/hermetic/`). It is wired as a **git pre-push hook** via `simple-git-hooks` (config in `package.json: simple-git-hooks.pre-push`) and is installed automatically on `npm install` via the `postinstall` script. This means **every `git push` is gated on the suite passing** — you do not need to run it manually, but you should never reach for `--no-verify` without a specific load-bearing reason (the hook is the only thing keeping `main` green).

No test runner; `scripts/tests/` is partitioned by what each script depends on — pick the right subdir when adding a new one:

- **`scripts/tests/hermetic/`** — no network, no PM2, no live external API. **Every file runs on every push.** Append new files to the `SUITES` array in `pre-push.sh`.
- **`scripts/tests/integration/`** — real assertions; require `mission-control-dev` on :4101. Not in the pre-push gate (PM2 startup + live-board flakiness).
- **`scripts/tests/probes/`** — live external API probes (Gemini, LinkedIn, Greenhouse, ATS verifiers). Diagnostic only — exit-zero not a contract.
- **`scripts/tests/debug/`** — manual exploration / `console.log` dumps. No assertions.

Files run with `tsx`. Don't put experiments in the repo root or `/tmp` — use `scripts/tests/debug/`.

## Architecture

### App shell: Dashboard as a slide carousel of "Dashes"

`components/Dashboard.tsx` is the top-level client component (mounted via `app/page.tsx` with `ssr: false`). It renders one **View** (a "dash") at a time out of `BASE_DASHES` and provides three global overlays:

- **Launchpad** (`components/overlays/LaunchpadOverlay.tsx`) — grid picker for switching dashes.
- **Library** (`components/overlays/SavedPapersOverlay.tsx`) — saved research papers, scoped to the current dash's topic via `getTopic(id)`.
- **AI Companion** (`components/AICompanion.tsx`) — context-aware chat, receives the current dash id as `activeContext`.

Dash order, per-dash hue, custom titles, and screenshots are all owned by the unified Zustand store (`components/providers/state/index.ts:useAppStore`; `themeStore.ts` is a thin re-export shim). `Dashboard` mounts and calls `syncAvailableDashes(BASE_DASHES)` on every load to reconcile persisted state with the current code (purges stale ids, appends new ones, force-pins `internal-systems` last). Per-device state (`activeViewId`, `viewScreenshots`, `autoResearch`, `aiCompanionEnabled`) persists to `localStorage` under `'app-state'` via Zustand's `persist` middleware; cross-device fields (`isDarkMode`, `viewHues`, `dashOrder`, `dashTitles`) sync via `/api/settings`.

When adding a new dash: add an entry to `BASE_DASHES` in `Dashboard.tsx`, register its topic in `getTopic()` if it has saved papers, and add a default title + hue in `themeStore.ts`. `syncAvailableDashes` will pick it up.

### Component hierarchy (enforced by directory)

`docs/frontend_terminology.md` is the canonical reference. Bottom-up: `ui/` & `widgets/` → `cards/` & `Window.tsx` → `grids/` → `Section.tsx` → `views/` → `Dashboard.tsx`. Cards wrap Widgets; Grids arrange Cards; Sections group Grids by theme; Views aggregate Sections; the Dashboard hosts Views. **Windows** (e.g., `AICompanion`) are floating-overlay siblings of Cards that escape the grid. Respect this when creating new components — the directory dictates the role.

**Compose from the layer below — don't hand-roll.** Every level builds on the next-lower one. If a primitive at the lower layer already encodes the structure or behavior you need, use it instead of re-implementing it. Concretely:

- **Cards in `components/cards/`** must wrap their content in `components/ui/Card.tsx` — never a bare `<div>` with a hand-rolled icon+title header. Card provides the standard header slot (`title`, `icon`, `iconColorClass`, `action`), the `flex-1 flex flex-col min-h-0 min-w-0` content container that lets internal scroll regions size to the card's actual height, and a `loading` state. Hand-rolling means inner lists tend to get fixed `max-h-[Nrem]` values that clip when the parent grid resizes — the canonical fix is `flex-1 min-h-0 overflow-y-auto` inside Card's body.
- **Canonical card chrome (bg/border/radius/padding) is set by `CardGrid`** (`components/grids/CardGrid.tsx`), not by individual cards. The class string is `bg-black/40 rounded-lg border border-white/5 hover:border-cyan-500/30 transition-colors` on the wrapper + `p-4` on the content. Cards rendered through `<Section><CardGrid items={...} /></Section>` inherit this automatically and should leave their own `wrapperClassName` empty (or limited to layout-only concerns like `relative`/`group`).
- **Cards rendered directly inside a `<Section>` (bypassing CardGrid)** — e.g. when a Section needs a vertical stack of full-width cards with interleaved Add buttons (as in `ProfileView`) — must replicate the canonical wrapper on their own `Card`: `bg-black/40 rounded-lg border border-white/5 hover:border-{theme}-500/30 transition-colors p-4`. Per-section theme color (`purple`, `cyan`, `emerald`) is fine for the hover border. Do NOT invent new chrome (tinted backgrounds, different radii, different padding) — drift breaks visual consistency across views.
- Same principle up the chain: Grids arrange Cards (don't re-implement layout inside a card), Sections wrap Grids, Views aggregate Sections. If you find yourself re-creating a lower-layer concern inside a higher-layer file, lift it down to the right layer.

### API routes + caching

API routes live under `app/api/<feature>/route.ts`. One cross-cutting wrapper:

- **`lib/cache.ts` `withCache(handler, ttlSeconds)`** — process-memory cache keyed on `pathname + sorted query` (the `?v=...` cache-buster is stripped and forces a refresh). On handler error or non-OK response, falls back to the last good payload with a 60s retry TTL. Sets `Cache-Control: private, no-store, max-age=0` so the browser never short-circuits server-side cache. Stats via `/api/system`. Optional `userKeyFn` for per-user scoping.

Wrap any route that hits an external API (or does expensive work) in `withCache`. Per-request HTTP logging happens via the Logger ring buffer (below), not Next middleware.

**API reference is generated, not hand-maintained.** `docs/apis.html` is produced by `scripts/gen-api-docs.ts` (`npm run gen:api-docs`). It statically AST-parses every `app/api/**/route.ts` for the facts that rot — HTTP methods, auth guard, `withCache` TTL/upstream — and renders each route's Zod request schema via `z.toJSONSchema(schema, { io: 'input' })` (importing only the pure `lib/schemas/*` modules; routes are never executed). The only hand-authored part is intent: a one-line `purpose` + `external` service list, declared as `export const apiMeta: ApiMeta` (type in `lib/api-docs/meta.ts`) in a **sibling `meta.ts`** next to the route — e.g. `app/api/ai/meta.ts` for `app/api/ai/route.ts`. It must be a plain object literal (read statically, not run). **Put it in `meta.ts`, never in `route.ts`** — Next.js validates a route module's named exports (`OmitWithTag` in the generated `.next/types/**/route.ts`), so an `apiMeta` export in `route.ts` is a build/`tsc` error; the sidecar isn't a route file so it escapes that (and is never bundled). A pre-push hermetic smoke (`scripts/tests/hermetic/api-docs-smoke.ts`) runs the generator in `--check` mode and **fails the push if `apis.html` is stale** — so regenerate + commit `apis.html` whenever you change a route's surface. When adding a route, add its `meta.ts` (the generator's run output lists routes still missing one).

### Logger ring buffer

`instrumentation.ts` calls `lib/logger.ts:initLogger()` once on Node.js startup. This **monkey-patches `console.{log,info,warn,error}` and `process.stdout/stderr.write`** to push entries into a 500-deep in-memory ring buffer that lives on `globalThis` (HMR-safe). `/api/system/logs` reads it and the Internal Systems dash subscribes via `subscribeToLogs()` for live tailing. Implication: server-side `console.*` from anywhere in the app — including third-party libraries — shows up in the in-app log viewer. Don't replace `console` calls with a separate logger lib without considering this.

### Auth (Google OAuth + offline access)

`lib/auth.ts` wires NextAuth with `PrismaAdapter` and a single Google provider. The provider requests `access_type=offline` and the **Gmail readonly + send** and **Calendar events** scopes — the long-lived refresh token is stored on the `Account` row. `lib/googleapis.ts:getGoogleAuthClient(userId)` rebuilds an OAuth2 client from that refresh token; all server-side Gmail/Calendar code goes through it. The session callback attaches `user.id` onto `session.user` so route handlers can pass it straight to `getGoogleAuthClient`.

Anything that reads/sends Gmail or writes Calendar events depends on these scopes. Adding a new Google scope requires bumping the `scope` string in `authOptions` and re-consenting.

### Gmail webhook + ingest

`app/api/gmail/webhook/route.ts` is OIDC-verified (Google Pub/Sub → service-account JWT, checked by `verifyPubSubOIDC`). The first action on every envelope is `INSERT OR IGNORE` on `WebhookDelivery(messageId)` — P2002 → 200 + `deduped: true` (no history.list call, no ingest run). Then resumes from `min(user.lastSyncedHistoryId, envelope.historyId)`, processes each `messagesAdded` in a per-msg try/catch so one bad email can't abort the batch, and advances `lastSyncedHistoryId` on success.

`lib/applications/ingest.ts:ingestGmailMessage` is idempotent on both events (via `@@unique([applicationId, emailMsgId, kind])`) and side-effects (per-event `notifiedAt` / `gcalSyncedAt` checkpoints). On retry it re-fetches all events for `(applicationId, msgId)` and re-fires notify/gcal only for events whose checkpoint is null. Early `skipped: duplicate` only when every event for the msg is fully checkpointed.

**Watch registration + renewal.** The push that drives the webhook is armed by `lib/gmail/watch.ts:registerGmailWatch(userId)` — an INBOX-scoped `gmail.users.watch()` against the shared `GMAIL_PUBSUB_TOPIC` (no-ops when that env is unset; seeds `lastSyncedHistoryId` only when null, since on renewal the webhook owns the watermark). A Gmail `watch` expires after 7 days, so `scheduler/jobs/gmail-watch-renew.ts` re-arms every Google-linked user daily — and on every scheduler startup tick, so a restart self-heals (registered in `scheduler/index.ts` JOBS). `lib/auth.ts` also fires a best-effort arm on sign-in. **Both tiers arm the SAME mailbox** because `GMAIL_PUBSUB_TOPIC` lives in shared `.env`: Gmail allows one watch per mailbox, so dev+prod must point at one topic and Pub/Sub fans out to per-tier push subscriptions (`gmail-push-{prod,dev}`), each with `PUBSUB_AUDIENCE` set to its tier's public webhook URL (`ms-{prod,dev}.salsquared.xyz`, never `mc.local` — LAN is unreachable by Pub/Sub) and `PUBSUB_SERVICE_ACCOUNT_EMAIL` matching the OIDC signer the route asserts. Full GCP wiring (topic, subscriptions, and the signer-SA `roles/iam.serviceAccountTokenCreator` prereq) lives in [`docs/gmail-realtime-push.html`](./docs/gmail-realtime-push.html) §4.

### Gemini rate limiting + model fleet

`lib/ai/rate-limit.ts:acquireGeminiSlot()` is a process-shared token bucket gating every Gemini API call. Defaults: 12 req/min, burst cap 60. Tunable via `GEMINI_RATE_PER_MIN` / `GEMINI_RATE_BURST` env vars. Both `lib/email-parser.ts:parseApplicationEmail` and `lib/ai/gemini.ts:chatJSON` await it before each attempt — retries pay the rate cost too. New Gemini callers MUST go through one of those two helpers, never call the SDK directly without `await acquireGeminiSlot()`.

Three-tier model fleet (`MODEL_FLASH` / `MODEL_LITE` / `MODEL_LITE_CHEAP`) — per-callsite model + token-cap rationale lives in [`docs/llm-calls.html`](./docs/llm-calls.html). Default is the lite model; reach for `MODEL_FLASH` only on quality-sensitive paths (resume bullet rewrite is currently the only one). Add a row to that doc when you wire a new Gemini caller.

**Cross-tier call dedup** (`lib/ai/llm-cache.ts`; design [`docs/cross-tier-llm-dedup.html`](./docs/cross-tier-llm-dedup.html)). dev (:4101/dev.db) and prod (:3101/prod.db) — plus both schedulers — run the same code on one box against the same data, so every cacheable LLM step would call Gemini twice. `chatJSON` and `parseApplicationEmail` route through `llmCached(req, compute)`, which content-hashes the request (resolved model + rendered prompt + output JSON Schema), checks a **shared SQLite file both tiers open** (`data/llm-cache.db`, WAL, gitignored), and either returns a cached result, leads the compute, or follows the other tier's in-flight one (an `INSERT OR IGNORE` reservation gives single-flight even on simultaneous fire — the Gmail push fan-out case). The rate slot (`acquireGeminiSlot`) lives **inside** `compute()`, so only the leader spends a token. Caching is **default-on** via `cache?: boolean` on `ChatJSONOptions`; set `cache: false` for intentionally-generative "suggest/draft" callsites (the 6 opted-out today — see the cache-on/off table in `llm-calls.html`). Content-addressing means a prompt/model change auto-invalidates, so the daily `llm-cache-prune` scheduler job is pure housekeeping. The cache is **best-effort, never load-bearing**: any store failure (better-sqlite3 ABI mismatch after an nvm Node switch, unwritable file) degrades to a direct uncached `compute()`. `better-sqlite3` is a direct dep loaded via a guarded dynamic `import()` (in `serverExternalPackages` — it's a native module).

### LLM observability (Lunary + Promptfoo)

Design doc: [`docs/implementation.md`](./docs/implementation.md) §LLM observability + prompt registry. Callsite inventory: [`docs/llm-calls.html`](./docs/llm-calls.html). Three invariants every new LLM caller respects:

1. **Stable kebab-case `name` on every `chatJSON` call** — `ChatJSONOptions.name: string` is required (TypeScript flags misses). Same string is Lunary slug + Promptfoo key + prompt-registry slug. For SDK-bypassing callers (only `lib/email-parser.ts` today), wrap manually with `lunary.trackEvent` — see `safeTrack` in that file.
2. **Load prompts via `lib/ai/prompts.ts:loadPrompt(slug, vars)`** — Lunary-preferred, disk fallback to `docs/llm-prompts/<slug>.md` (keeps hermetic smokes + Lunary-less dev working). To push edits: `npx tsx scripts/sync-lunary-templates.ts` (idempotent; needs `LUNARY_SECRET_KEY` in `.env`, distinct from `LUNARY_PUBLIC_KEY`). One async wrinkle: `buildBulletAssistPrompt` is now async — `await` it.
3. **Output-shape changes need a Promptfoo update** — amend `eval/suites/<slug>.yaml` and run `npm run test:prompts` before pushing. Not in `pre-push.sh` (burns real Gemini tokens). A brand-new callsite needs: name in the inventory, prompt blob in `docs/llm-prompts/`, handler in `eval/provider.ts:HANDLERS`, fixture in `eval/suites/<slug>.yaml`.

Tracing is opt-in: set `LUNARY_PUBLIC_KEY` in `.env` + `pm2 restart mission-control-{dev,scheduler-dev,scheduler-prod} --update-env`. Absent = true no-op (`wrapModel` bypassed at module-init).

### Prisma + dual SQLite databases

`lib/prisma.ts` exports a single extended `PrismaClient` whose `$allOperations` middleware logs every query through `console.info` (lands in the in-app log viewer) — **prod only; dev muted unless `DEBUG_PRISMA=1`** (see verbose-log gates below). Client cached on `globalThis` in dev to survive HMR. **Dev and prod read different SQLite files** (`prisma/dev.db` vs `prisma/prod.db`) selected by `.env.{development,production}`.

When invoking a `tsx` script against the dev DB, pass `DATABASE_URL="file:./dev.db"` — **not** `file:./prisma/dev.db`. Prisma resolves relative `file:` URLs from `prisma/`, so the latter silently creates a phantom `prisma/prisma/dev.db`.

Race-safety + dedup invariants baked into the schema (don't paper over by bypassing):
- `Application.normalizedCompany` + `Application.normalizedRole` + `@@unique([userId, normalizedCompany, normalizedRole, track])` (2026-05-27 multi-role-per-company) — concurrent `createApplication` for the same employer+role+kanban throws P2002; `lib/applications/ingest.ts` catches and falls through to update. Use `normalizeCompanyName` from `lib/applications/normalize-company.ts` and `normalizeRoleName` from `lib/applications/normalize-role.ts` for any new comparison path. The unique key intentionally allows two different roles at the same employer on the same kanban (e.g. "Allied Universal — Security Officer Museum Rover" and "Allied Universal — Mall Patrol" coexist as separate apps). Role normalization (Rule B) keeps parens content as tokens, strips employment-modality words (part time, remote, contract, intern, …), preserves substantive modifiers (senior, lead, staff). `Application.sourceJobId` is the high-precision dedup hint populated at track-as-application time from `posting.externalId`; `lib/postings/track-as-application.ts`'s chain is postingId → sourceJobId → (company+role+track) → create.
- `Application.senderDomain` — secondary dedup key for LLM-classifier drift. Set on every ingest from the Gmail From header via `extractSenderDomain` in `lib/applications/sender-domain.ts` (returns null for multi-tenant ATS roots: Greenhouse, Lever, Common App, …). `ingestGmailMessage` tries `findApplicationByCompanyAndRole` first, then a `findApplicationByCompany` fallback (single cross-track query, two acceptance reasons: NULL-normalizedRole legacy rows that pre-date the backfill, **and** roleless emails — when the classifier emits no role, `incomingRole` defaults to `"Unknown"` so the role-aware lookup is structurally doomed; a generic ATS "finish your form" email then merges into the most-recently-updated app for the employer on **any** track, inheriting its track, instead of spawning an `"Unknown"`-role row that hardcodes `track="career"`), then `findApplicationBySenderDomain`. On a domain-match hit, existing `company` is preserved (no LLM-drift flip-flop); only status / nextSteps / role refresh. The roleless merge is gated on an *empty* role: a role-bearing email for a genuinely new role still creates a separate row (multi-role-per-company), and role-string *drift* on a present role is not covered here (falls to the senderDomain fallback).
- Stale-email status guard — `ingestGmailMessage` calls `findLatestStatusAnchor(appId)` before applying an email's classification. If the anchor's `occurredAt` (most recent `STATUS_CHANGED` or `APPLIED` event) is newer than the incoming email's `sentAt`, skip the `Application.status` / `role` / `nextSteps` / `lastUpdateAt` update and suppress the `STATUS_CHANGED` emission. Still record `EMAIL_RECEIVED` and factual `OFFER` / `REJECTION` / `INTERVIEW_SCHEDULED` / `ASSESSMENT_REQUESTED` events at the email's date.
- `ApplicationEvent.notifiedAt` + `gcalSyncedAt` — per-event checkpoints. Ingest re-fires side-effects only for events whose checkpoint is still null. Don't short-circuit ingest on `lastEmailMsgId === msgId` alone.
- `Notification.dedupKey String? @unique` — `dispatchNotification` returns `Notification | null`; callers passing dedupKey MUST handle null. Use `utcDateBucket()` from `lib/notifications/dispatch.ts` for date buckets, never `new Date().toLocaleDateString()`.
- `Watchlist.directoryKey` — when set, `config` is hydrated from `COMPANY_DIRECTORY` at read time via `lib/watchlists/hydrate.ts`. Manual PATCH to `config` clears the key so user overrides stick.
- `WebhookDelivery(messageId @id)` — Gmail webhook's first action is `INSERT OR IGNORE` on the envelope messageId; P2002 = redelivery → return 200 immediately. Daily prune at 30 days.
- **Closed-posting detection is probe-gated** (2026-05-25, see [`docs/close-detection-probe.md`](./docs/close-detection-probe.md)). `scheduler/jobs/job-watcher.ts` no longer auto-closes a `JobPosting` purely because the fetcher hasn't returned its `externalId` in 6h — it first probes the posting's `sourceUrl` via `lib/postings/liveness.ts:probeBatch` and only flips to `status="closed"` on positive evidence of removal. Probes returning `"alive"` bump `lastSeenAt` instead (re-arming the 6h clock so a posting permanently absent from the fetch list but live on the source — LinkedIn 24h-filtered, Workday past page 10 — never false-closes). Per-ATS profiles (concurrency / delay / cap / timeout) live in `PROBE_PROFILES`. Hermetic-test override: `MC_LIVENESS_BYPASS={alive|closed|unknown}` short-circuits probes for smokes that assert at scale; production never sets it.

### Task system

`Task` in `prisma/schema.prisma` is the source of truth; `app/api/tasks/route.ts` is pure DB CRUD. When adding fields, touch: schema, `lib/schemas/tasks.ts` (Zod), `lib/repositories/tasks.ts`, and the route.

### Pluggable news ingestion

`lib/company-registry.ts` is a registry of company news feeds, each declaring a fetch strategy. The strategies live in `lib/fetchers/` (`rss`, `scrape`, `snapi`, `google-news`) and the registry dispatches to them by `strategy` field. Bespoke API shapes (SpaceX JSON API, OpenAI's RSS-with-Microlink-image-fallback, Groq's dual-page scrape, etc.) are **inline custom fetchers** in `company-registry.ts` rather than new strategy modules — adding a new RSS source should be ~5 lines of config; only invent a new strategy when the shape is genuinely new. TTL presets (`TTL_STANDARD`, `TTL_LOW_VOLUME`, `TTL_VERY_LOW`) are picked per company based on posting cadence.

Article count is capped by `MAX_NEWS_ARTICLES` in `lib/constants.ts`.

### Resume-gen relevance pipeline

`POST /api/resumes` runs a multi-stage pipeline: importance-weighted bullet scoring (`TAG_WEIGHT=2` × Σ importance + `SUBSTRING_WEIGHT=1` × Σ importance, case-insensitive dedupe) → entity-level `pinKeywords` force-include + lead-of-section → LLM-decided `sectionOrder` + `entityOrder` via the `resume-tagline` callsite → pin-front re-assert → no-match bullet prefilter (skips Flash rewrite) → Skills/Languages/Interests posting-filter → two-phase one-page pruner (entity-level, then bullet-level on `>= 2`-bullet entities).

Full rules + the touch list for adding a selection-affecting field live in [`docs/resume-pipeline.md`](./docs/resume-pipeline.md). **The most common bug** when adding a profile field intended to influence selection is forgetting to thread it through `lib/resumes/select.ts` and/or `lib/resumes/one-page.ts:getUnremovableEntityIds` — see that doc's touch list.

### PWA / service worker

`@serwist/next` emits `public/sw.js` from `app/sw.ts`; disabled in dev. New generated artifacts in `public/` need to be added to the webpack `watchOptions.ignored` list in `next.config.ts` (prod-build only; Turbopack uses its own watcher in dev).

## Documentation conventions

- Node-based graphs (architecture diagrams, flowcharts, dependency graphs, etc.) must use Mermaid syntax — never ASCII art.
- Inside Mermaid node/edge labels, use `<br/>` for line breaks — **not** `\n`. The renderer used to preview these docs does not interpret `\n` inside labels and will render them literally. Parens inside edge labels (`|...|`) must be quoted (`|"text()"|`); parens inside quoted node labels (`["text()"]`) are fine.

### HTML over markdown (in-progress migration, 2026-05-28)

`docs/` is migrating from `.md` to `.html` for richer layout, embedded diagrams, and consistent styling that markdown previewers can't deliver. **New docs are HTML; existing `.md` files convert when next touched** — no big-bang sweep.

- **Template:** `docs/_template.html` — copy and rename when starting a new doc. It renders *as* a live style guide (every component shown rendered, with the markup to write it), so the template is itself the cheat-sheet. Convention: an `<h4 class="kicker">` project name above the `<h1>` doc title, then a `<p class="subtitle">`; each `<h2>` section is a numbered, collapsible `<details class="section">` whose body sits in a `<div class="section-body">`. **Every section carries at least one *named* `<h3>` subsection** (its `X.1`) so all content is referenceable as `X.Y` even when there's only one — subsection numbers are auto-generated by a nested CSS counter, so you write only the name (no manual `X.Y` prefix). Only `<h3>` is auto-numbered; `<h4>` is not.
- **Shared stylesheet:** `docs/assets/style.css` — every doc links to it. From `docs/foo.html` use `./assets/style.css`; from `docs/sub/foo.html` use `../assets/style.css`. **Don't inline `<style>` in individual docs** — drift between docs is exactly what the shared stylesheet exists to prevent. Edit `style.css` instead.
- **Mermaid** still uses Mermaid syntax. The template embeds an ES-module CDN init for `mermaid@10`; diagrams render client-side, so first open needs network (browser caches the bundle thereafter). Rendered diagrams are wrapped with `svg-pan-zoom@3` (drag-to-pan, scroll/buttons to zoom, fit-to-view on open) — applied after each diagram renders (and re-applied when a collapsed section is first expanded); the `.pannable` viewport + control-icon theming live in `style.css`.
- **Code blocks** are syntax-highlighted via an ES-module CDN import of `highlight.js@11` in the same script (`hljs.highlightAll()`). The token theme lives in `style.css` (on-brand, keyed to the palette) — no external highlight theme CSS. Auto-detects language; add `class="language-json"` / `language-typescript` / etc. to the `<code>` to force one. Offline, code degrades to the flat `--code-block` green.
- **Stay markdown — don't convert:**
  - `README.md` (anywhere) — GitHub renders markdown; HTML support there is poor and inconsistent.
  - `docs/llm-prompts/*.md` — these are **machine-read prompt blobs** loaded by `lib/ai/prompts.ts:loadPrompt` as the Lunary disk fallback. Converting them would break the loader.
- **Converting a doc:** rename `.md` → `.html`, port the content using the template + cheat-sheet, then grep for the old `.md` path and update inbound links — including from `CLAUDE.md` itself and any other doc that referenced the old path.

## Conventions and gotchas

- `reactStrictMode: false` in `next.config.ts` — components are not double-mounted in dev. Don't rely on strict-mode side-effect detection.
- **Dev-server perf + process-tree quirks** — PM2 watches the npm wrapper, not the `next-server` worker, so `pm2 list` understates real memory. Use `/api/system` or `scripts/perf-monitor.ts` for worker numbers. Full notes in [`docs/perf-profile.md`](./docs/perf-profile.md). The `--max-old-space-size=2048` cap is intentional; don't lower without re-measuring.
- **Verbose-log gates**: `[DATABASE]` Prisma logs muted in dev unless `DEBUG_PRISMA=1`; `[CACHE HIT]` / `[CACHE MISS]` / `[API Request]` muted unless `DEBUG_VERBOSE_LOG=1`. All on in prod.
- Scope authorization via `lib/auth.ts` is the only place that requests Google tokens. Server-side Gmail/Calendar callers should always go through `getGoogleAuthClient(userId)`, never construct an OAuth client inline.
- API routes that fetch external data should be wrapped in `withCache` — bare external `fetch` per request is the exception, not the rule.
- For server-side logging use `console.info` / `console.warn` / `console.error` (they're captured by the in-app log viewer). Don't introduce a separate logger.
- Checked-in `.env.{development,production}` hold non-secret runtime config; real secrets (Google OAuth, NextAuth, Gemini) live in an untracked `.env`. `GOOGLE_GENERATIVE_AI_KEY` (or fallbacks `GOOGLE_GEN_AI_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`) powers Gemini callers — free key from Google AI Studio.
- **`EMAIL_ENABLED` is the master Gmail-send switch.** `lib/email/send.ts` checks it before calling `gmail.users.messages.send`. `EMAIL_ENABLED=1` in `.env.production` so prod actually delivers application-side notifications (OFFER / REJECTION / INTERVIEW_SCHEDULED / ASSESSMENT_REQUESTED). `EMAIL_ENABLED=0` in `.env.development` so test runs and the pre-push hook don't blast the inbox. When `EMAIL_ENABLED !== "1"`, `dispatchNotificationEmail` records `emailError = "Email muted (EMAIL_ENABLED != 1)"` on the notification row instead of dispatching — the in-app surface still fires. To verify the pipeline ad-hoc: `EMAIL_ENABLED=1 pm2 restart mission-control-dev` and hit `/api/notifications/test`.

## Backups + recovery

Two pieces of state matter: `prisma/prod.db` (contains plaintext `Account.refresh_token` — treat as mailbox-equivalent) and `data/resumes/<id>.<ext>`. `scripts/backup-db.sh` snapshots both, age-encrypts when `~/.config/mission-control/backup.pub` is present, mirrors to Google Drive via rclone, prunes >30d. Runbook (one-time encryption setup, cron, fresh-machine recovery) lives in [`docs/backup-recovery.md`](./docs/backup-recovery.md).

The Cloudflare tunnel (`cloudflared`, system-level via Homebrew — won't appear in `pm2 list`) handles the public-hostname side. `requireLocalOrSession` in `lib/auth-guards.ts` gates tunnel traffic behind NextAuth while LAN hosts (localhost / mc.local) skip auth.
