# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session protocol — read on every start, update on every end

`docs/next_steps.md` is the living cross-session context doc (last session state, in-flight work, open questions, parked TODOs).

- **At the start of every session**, read `docs/next_steps.md` in full before touching the codebase. Reconcile it against current `git status` / on-disk state — if the file claims work is in progress that's already landed or been discarded, fix the doc first.
- **At the end of every session** (or when the user signals they're wrapping: "ok done", "let's stop here", "save progress", or before a context handoff), update `docs/next_steps.md`: move finished items into "Recently completed" (keep ~3–5), refresh "In-progress work" / "Open questions", and use absolute ISO dates (e.g. `2026-05-14`) — never relative ones.
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

Restart / inspect:
- `pm2 restart mission-control-dev` — pick up config changes (next.config.ts, env, etc.) on the dev tier.
- `pm2 restart mission-control` — same for prod after a fresh build.
- `pm2 logs mission-control-scheduler-dev` (or `-prod`) — tail per-tier scheduler logs.
- `pm2 list` — quick status of all processes.

**Dev vs prod tooling split** (2026-05-20):
- **`npm run dev` uses Turbopack** (`next dev --turbopack`). Measured ~35 % lower worker RSS than webpack dev, ~55 % lower peak CPU during compile bursts. Active on `mission-control-dev`.
- **`npm run build` stays on webpack** (`next build --webpack`). Prod runtime is a `next start` of the compiled output and doesn't care which compiler produced it; webpack's build path is the verified one. Don't flip `build` to Turbopack without re-running `npm run test:hermetic` and a manual route sweep — a few small differences (CSS chunk hashing, prerender behavior) can bite.
- The `webpack: (config, { dev, isServer, nextRuntime }) => { ... }` function in `next.config.ts` is **inert during `next dev`** (Turbopack ignores it) but still applies to `next build`. Keep it — the watchOptions.ignored entries and `node:*` scheme fallbacks are still load-bearing for prod builds.

The npm scripts themselves remain useful for one-offs:
- `npm run build` — production build (webpack). Run before restarting `mission-control` so it picks up new compiled code.
- `npm run lint` — ESLint (flat config, extends `eslint-config-next`).
- `npm run test:hermetic` — runs `./scripts/pre-push.sh` (the hermetic suite). Use this to verify before pushing without going through `git push`.
- `npm run test:integration` — runs `./scripts/test-integration.sh` against the dev PM2 process on :4101. Aborts early with a helpful message if `mission-control-dev` isn't online; bypass with `SKIP_INTEGRATION_TESTS=1`. Not part of the pre-push gate.
- `npm run test:all` — hermetic + integration in sequence. Use before merging non-trivial changes to `main`.
- `./launch-ms.sh` — convenience launcher that ensures the prod PM2 process is up and opens Chrome in `--app=` mode at `http://localhost:3101`. `./launch-ms.sh --restart` force-kills and recreates the PM2 process.
- `npx prisma migrate dev` / `npx prisma generate` — schema lives at `prisma/schema.prisma` (SQLite). Dev and prod use **separate DB files** in `prisma/`.

### Pre-push hook (mandatory gate before reaching `main`)

`scripts/pre-push.sh` runs the full hermetic suite (every file under `scripts/tests/hermetic/`). It is wired as a **git pre-push hook** via `simple-git-hooks` (config in `package.json: simple-git-hooks.pre-push`) and is installed automatically on `npm install` via the `postinstall` script. This means **every `git push` is gated on the suite passing** — you do not need to run it manually, but you should never reach for `--no-verify` without a specific load-bearing reason (the hook is the only thing keeping `main` green).

Verifying the hook is installed: `ls -la .git/hooks/pre-push` should show a 200-byte script ending in `./scripts/pre-push.sh`. If a fresh clone is missing it, run `npx simple-git-hooks` (or `npm install`) to re-install.

There is **no pre-commit hook** — local commits are unrestricted; the gate is at push time. If you want to dry-run the suite before committing, use `npm run test:hermetic`.

There is no test runner configured. `scripts/tests/` is partitioned by what each script depends on — pick the right subdir when adding a new one:

- **`scripts/tests/hermetic/`** — no network, no PM2, no live external API. Pure logic + in-process Prisma + optional in-process HTTP fixture server. **Every file here is wired into `scripts/pre-push.sh` and runs on every push.** Add new files here only if they're truly hermetic, and append them to the `SUITES` array in `pre-push.sh`.
- **`scripts/tests/integration/`** — real assertions, but require the dev PM2 process (`mission-control-dev` on :4101) running. Run via `npm run test:integration` (or `test:all` for hermetic + integration). Not in the pre-push gate because PM2 startup adds 5–10s and some smokes hit live boards (Anthropic Greenhouse, Lever demo, Ashby posthog) which can be flaky. Known-flaky in production: `resume-e2e-smoke` hits Gemini and can 429 on the free tier; `watchlist-phase2-smoke` has occasionally thrown a cleanup-phase ECONNRESET after its assertions pass.
- **`scripts/tests/probes/`** — live external API probes (Gemini, LinkedIn, Greenhouse, ATS slug verifiers, etc.). Diagnostic, not regression — exit-zero is not a contract. Run ad-hoc when debugging an outside system.
- **`scripts/tests/debug/`** — manual exploration / `console.log` dumps (`gmail-inbox-debug`, `check-cache`, `fix-lint`). No assertions; cwd-equivalent of `/tmp` for the repo.

Files run with `tsx` (e.g. `npx tsx scripts/tests/debug/check-cache.ts`). This is enforced — do not put experiments in the repo root or `/tmp`. One-off backfills and already-run migrations live under `scripts/archive/migrations/` (kept for forensic record, not re-runnable).

Node.js LTS is required (project pins to v24.x via nvm). Path alias `@/*` resolves to the repo root.

## Architecture

### App shell: Dashboard as a slide carousel of "Dashes"

`components/Dashboard.tsx` is the top-level client component (mounted via `app/page.tsx` with `ssr: false`). It renders one **View** (a "dash") at a time out of `BASE_DASHES` and provides three global overlays:

- **Launchpad** (`components/overlays/LaunchpadOverlay.tsx`) — grid picker for switching dashes.
- **Library** (`components/overlays/SavedPapersOverlay.tsx`) — saved research papers, scoped to the current dash's topic via `getTopic(id)`.
- **AI Companion** (`components/AICompanion.tsx`) — context-aware chat, receives the current dash id as `activeContext`.

Dash order, per-dash hue, custom titles, and screenshots are all owned by the unified Zustand store (`components/providers/state/index.ts:useAppStore`; `themeStore.ts` is a thin re-export shim). `Dashboard` mounts and calls `syncAvailableDashes(BASE_DASHES)` on every load to reconcile persisted state with the current code (purges stale ids, appends new ones, force-pins `internal-systems` last). The active dash id is on the same store as `activeViewId` and persisted **per-device in `localStorage` under `'app-state'`** via Zustand's `persist` middleware (alongside `viewScreenshots`, `autoResearch`, `aiCompanionEnabled`). Cross-device fields (`isDarkMode`, `viewHues`, `dashOrder`, `dashTitles`) sync separately via `/api/settings`. The legacy `'mc-active-view'` localStorage key is read once on mount as a migration path and then cleared.

When adding a new dash: add an entry to `BASE_DASHES` in `Dashboard.tsx`, register its topic in `getTopic()` if it has saved papers, and add a default title + hue in `themeStore.ts`. `syncAvailableDashes` will pick it up.

### Component hierarchy (enforced by directory)

`docs/frontend_terminology.md` is the canonical reference. Bottom-up: `ui/` & `widgets/` → `cards/` & `Window.tsx` → `grids/` → `Section.tsx` → `views/` → `Dashboard.tsx`. Cards wrap Widgets; Grids arrange Cards; Sections group Grids by theme; Views aggregate Sections; the Dashboard hosts Views. **Windows** (e.g., `AICompanion`) are floating-overlay siblings of Cards that escape the grid. Respect this when creating new components — the directory dictates the role.

**Compose from the layer below — don't hand-roll.** Every level builds on the next-lower one. If a primitive at the lower layer already encodes the structure or behavior you need, use it instead of re-implementing it. Concretely:

- **Cards in `components/cards/`** must wrap their content in `components/ui/Card.tsx` — never a bare `<div>` with a hand-rolled icon+title header. Card provides the standard header slot (`title`, `icon`, `iconColorClass`, `action`), the `flex-1 flex flex-col min-h-0 min-w-0` content container that lets internal scroll regions size to the card's actual height, and a `loading` state. Hand-rolling means inner lists tend to get fixed `max-h-[Nrem]` values that clip when the parent grid resizes — the canonical fix is `flex-1 min-h-0 overflow-y-auto` inside Card's body.
- **Canonical card chrome (bg/border/radius/padding) is set by `CardGrid`** (`components/grids/CardGrid.tsx`), not by individual cards. The class string is `bg-black/40 rounded-lg border border-white/5 hover:border-cyan-500/30 transition-colors` on the wrapper + `p-4` on the content. Cards rendered through `<Section><CardGrid items={...} /></Section>` inherit this automatically and should leave their own `wrapperClassName` empty (or limited to layout-only concerns like `relative`/`group`).
- **Cards rendered directly inside a `<Section>` (bypassing CardGrid)** — e.g. when a Section needs a vertical stack of full-width cards with interleaved Add buttons (as in `ProfileView`) — must replicate the canonical wrapper on their own `Card`: `bg-black/40 rounded-lg border border-white/5 hover:border-{theme}-500/30 transition-colors p-4`. Per-section theme color (`purple`, `cyan`, `emerald`) is fine for the hover border. Do NOT invent new chrome (tinted backgrounds, different radii, different padding) — drift breaks visual consistency across views.
- Same principle up the chain: Grids arrange Cards (don't re-implement layout inside a card), Sections wrap Grids, Views aggregate Sections. If you find yourself re-creating a lower-layer concern inside a higher-layer file, lift it down to the right layer.

shadcn/ui is configured (`components.json`, "new-york" style, neutral base, lucide icons) but components live under `components/ui/` as hand-written TSX rather than a generated registry.

### API routes + caching

API routes live under `app/api/<feature>/route.ts`. One cross-cutting wrapper:

- **`lib/cache.ts` `withCache(handler, ttlSeconds)`** — process-memory cache keyed on `pathname + sorted query` (the `?v=...` cache-buster is stripped before keying and forces a refresh). On handler error or non-OK response it falls back to the last good payload and rewrites the entry with a 60s retry TTL. Stats are surfaced via `/api/system`. Cache-Control is set to `no-store` in dev so the browser never caches; production sets `max-age` + `stale-while-revalidate`. Optional `userKeyFn` opts a route into per-user cache scoping (no current callers — see RAH-5 in `docs/implementation.md`).

Per-request HTTP logging is **not** done via Next middleware. The in-app log viewer captures every server-side `console.*` call (see "Logger ring buffer" below) including the per-query `[DATABASE]` lines the Prisma middleware in `lib/prisma.ts` emits — that's the canonical observability surface. There is no `middleware.ts` at the repo root.

Wrap any route that hits an external API (or does expensive work) in `withCache`. The cache survives HMR by attaching to `globalThis` in dev.

### Logger ring buffer

`instrumentation.ts` calls `lib/logger.ts:initLogger()` once on Node.js startup. This **monkey-patches `console.{log,info,warn,error}` and `process.stdout/stderr.write`** to push entries into a 500-deep in-memory ring buffer that lives on `globalThis` (HMR-safe). `/api/system/logs` reads it and the Internal Systems dash subscribes via `subscribeToLogs()` for live tailing. Implication: server-side `console.*` from anywhere in the app — including third-party libraries — shows up in the in-app log viewer. Don't replace `console` calls with a separate logger lib without considering this.

### Auth (Google OAuth + offline access)

`lib/auth.ts` wires NextAuth with `PrismaAdapter` and a single Google provider. The provider requests `access_type=offline` and the **Gmail readonly + send** and **Calendar events** scopes — the long-lived refresh token is stored on the `Account` row. `lib/googleapis.ts:getGoogleAuthClient(userId)` rebuilds an OAuth2 client from that refresh token; all server-side Gmail/Calendar code goes through it. The session callback attaches `user.id` onto `session.user` so route handlers can pass it straight to `getGoogleAuthClient`.

Anything that reads/sends Gmail or writes Calendar events depends on these scopes. Adding a new Google scope requires bumping the `scope` string in `authOptions` and re-consenting.

### Gmail webhook + ingest

`app/api/gmail/webhook/route.ts` is OIDC-verified (Google Pub/Sub → service-account JWT, checked by `verifyPubSubOIDC`). The first action on every envelope is `INSERT OR IGNORE` on `WebhookDelivery(messageId)` — P2002 → 200 + `deduped: true` (no history.list call, no ingest run). Then resumes from `min(user.lastSyncedHistoryId, envelope.historyId)`, processes each `messagesAdded` in a per-msg try/catch so one bad email can't abort the batch, and advances `lastSyncedHistoryId` on success.

`lib/applications/ingest.ts:ingestGmailMessage` is idempotent on both events (via `@@unique([applicationId, emailMsgId, kind])`) and side-effects (per-event `notifiedAt` / `gcalSyncedAt` checkpoints). On retry it re-fetches all events for `(applicationId, msgId)` and re-fires notify/gcal only for events whose checkpoint is null. Early `skipped: duplicate` only when every event for the msg is fully checkpointed.

### Gemini rate limiting + model fleet

`lib/ai/rate-limit.ts:acquireGeminiSlot()` is a process-shared token bucket gating every Gemini API call. Defaults: 12 req/min, burst cap 60. Tunable via `GEMINI_RATE_PER_MIN` / `GEMINI_RATE_BURST` env vars. Both `lib/email-parser.ts:parseApplicationEmail` and `lib/ai/gemini.ts:chatJSON` await it before each attempt — retries pay the rate cost too. New Gemini callers MUST go through one of those two helpers, never call the SDK directly without `await acquireGeminiSlot()`.

Three-tier model fleet (`MODEL_FLASH` / `MODEL_LITE` / `MODEL_LITE_CHEAP`) — per-callsite model + token-cap rationale lives in [`docs/llm-calls.md`](./docs/llm-calls.md). Default is the lite model; reach for `MODEL_FLASH` only on quality-sensitive paths (resume bullet rewrite is currently the only one). Add a row to that doc when you wire a new Gemini caller.

### Prisma + dual SQLite databases

`lib/prisma.ts` exports a single extended `PrismaClient` whose `$allOperations` middleware logs every query through `console.info` (so it lands in the in-app log viewer) — **prod only**. In dev the per-query log is muted by default because every `console.info` fans out to the SSE log subscribers (`/api/system/logs`) and re-renders the Internal Systems dash on each push; set `DEBUG_PRISMA=1` to re-enable when actively debugging. The same dev-mute pattern (prod on, dev off unless `DEBUG_VERBOSE_LOG=1`) gates `[CACHE HIT]` / `[CACHE MISS]` in `lib/cache.ts` and `[API Request]` in `proxy.ts` — both fire per-request and were significant SSE fan-out load in dev. The client is cached on `globalThis` in dev to survive HMR. **Dev and prod read different SQLite files** (`prisma/dev.db` vs `prisma/prod.db`) selected by which `.env.{development,production}` Next.js picks up. When debugging prod data issues, point at `prisma/prod.db` explicitly.

When invoking a `tsx` script against the dev DB (e.g. `scripts/tests/**/*.ts`), pass `DATABASE_URL="file:./dev.db"` — **not** `file:./prisma/dev.db`. Prisma resolves a relative `file:` URL from the schema's directory (`prisma/`), so `file:./prisma/dev.db` silently creates a phantom `prisma/prisma/dev.db` and you'll get empty-DB results.

Schema highlights: standard NextAuth tables (`Account`/`Session`/`User`/`VerificationToken`), `Application` + `ApplicationEvent` (job tracker), `Task` (DB-native, see below), `LifeGoal`, `SavedPaper` + weekly selection tables (`SelectedHistoricalPaper`, `SelectedReviewPaper`), `GlobalSetting` (single row keyed `id="global"`), `Watchlist` + `JobPosting` (discovery feed), `Notification` (in-app bell + email dispatcher), `WebhookDelivery` (Pub/Sub messageId dedup), `GeneratedResume`.

Race-safety + dedup invariants baked into the schema (don't paper over by bypassing):
- `Application.normalizedCompany` + `@@unique([userId, normalizedCompany])` — concurrent `createApplication` for the same employer throws P2002; `lib/applications/ingest.ts` catches and falls through to update. Use `normalizeCompanyName` from `lib/applications/normalize-company.ts` for any new comparison path.
- `Application.senderDomain` — secondary dedup key for LLM-classifier drift (e.g. CSULB / Cal State Long Beach / California State University Long Beach all referring to the same school). Set on every ingest from the Gmail From header via `extractSenderDomain` in `lib/applications/sender-domain.ts`, which returns null for multi-tenant ATS / admissions roots (Greenhouse, Lever, Common App, …). `ingestGmailMessage` tries `findApplicationByCompany` first, falls back to `findApplicationBySenderDomain` when the company-name lookup misses. On a domain-match hit, the existing `company` value is preserved (no LLM-drift flip-flop) and only status / nextSteps / role refresh.
- `ApplicationEvent.notifiedAt` + `gcalSyncedAt` — per-event checkpoints. Ingest re-fires side-effects only for events whose checkpoint is still null. Don't short-circuit ingest on `lastEmailMsgId === msgId` alone.
- `Notification.dedupKey String? @unique` — `dispatchNotification` returns `Notification | null`; callers passing dedupKey MUST handle null. Use `utcDateBucket()` from `lib/notifications/dispatch.ts` for date buckets, never `new Date().toLocaleDateString()`.
- `Watchlist.directoryKey` — when set, `config` is hydrated from `COMPANY_DIRECTORY` at read time via `lib/watchlists/hydrate.ts`. Manual PATCH to `config` clears the key so user overrides stick.
- `WebhookDelivery(messageId @id)` — Gmail webhook's first action is `INSERT OR IGNORE` on the envelope messageId; P2002 = redelivery → return 200 immediately. Daily prune at 30 days.

### Task system: DB + UI only

The `Task` table in `prisma/schema.prisma` is the source of truth for tasks. There is no markdown file sync — the previous `docs/todo.md` ↔ DB pipeline (`lib/tasks/parser.ts`, `regenerator.ts`, `watcher.ts`) was removed; `docs/todo.archive.md` is the read-only snapshot from before the cutover.

`app/api/tasks/route.ts` is pure DB CRUD:
- `GET` — returns all tasks ordered by `position` then `createdAt`.
- `POST` — creates a task; computes `position` via `nextPosition(parentId)` (parent's position + 1, or `MAX(position) + 1`).
- `PATCH` — partial update (`status`, `text`, `dueDate`, `priority`, `position`, `parentId`).
- `DELETE` — removes a task; cascading is handled by the schema (`parentId` `onDelete: SET NULL`).

When adding task fields: update `prisma/schema.prisma:Task`, the Zod schemas in `lib/schemas/tasks.ts`, the repository helpers in `lib/repositories/tasks.ts`, and the route in `app/api/tasks/route.ts`. No file-side parser to keep in sync.

### Pluggable news ingestion

`lib/company-registry.ts` is a registry of company news feeds, each declaring a fetch strategy. The strategies live in `lib/fetchers/` (`rss`, `scrape`, `snapi`, `google-news`) and the registry dispatches to them by `strategy` field. Bespoke API shapes (SpaceX JSON API, OpenAI's RSS-with-Microlink-image-fallback, Groq's dual-page scrape, etc.) are **inline custom fetchers** in `company-registry.ts` rather than new strategy modules — adding a new RSS source should be ~5 lines of config; only invent a new strategy when the shape is genuinely new. TTL presets (`TTL_STANDARD`, `TTL_LOW_VOLUME`, `TTL_VERY_LOW`) are picked per company based on posting cadence.

Article count is capped by `MAX_NEWS_ARTICLES` in `lib/constants.ts`.

### PWA / service worker

`@serwist/next` wraps the Next config in `next.config.ts` and emits `public/sw.js` from `app/sw.ts`. **The service worker is disabled in dev** (`disable: isDev`); the webpack `watchOptions.ignored` list also excludes `public/sw.js`, `public/sw.js.map`, and Prisma DB files to prevent reload loops during prod builds (and previously dev — see note below). If you add generated artifacts in `public/`, add them to that ignore list too. Under Turbopack-driven `next dev`, the watchOptions are inert (Turbopack uses its own watcher) but Turbopack's defaults handle these cases without manual ignores.

## Documentation conventions

- Node-based graphs (architecture diagrams, flowcharts, dependency graphs, etc.) must use Mermaid syntax — never ASCII art.
- Inside Mermaid node/edge labels, use `<br/>` for line breaks — **not** `\n`. The renderer used to preview these docs does not interpret `\n` inside labels and will render them literally. Parens inside edge labels (`|...|`) must be quoted (`|"text()"|`); parens inside quoted node labels (`["text()"]`) are fine.

## Conventions and gotchas

- `reactStrictMode: false` in `next.config.ts` — components are not double-mounted in dev. Don't rely on strict-mode side-effect detection.
- The dev-server-only `--max-old-space-size=2048` is intentional but **comfortably oversized** post-Turbopack: measured idle worker is ~280 MB (prod) / ~720 MB (dev under Turbopack). The 2 GB cap leaves headroom for fetcher/parser routes on big pages. Don't lower without re-measuring under heavy LinkedIn/Workday crawls.
- **Dev worker profile is asymmetric to PM2's view**: `pm2 jlist` reports the npm wrapper PID (~55 MB), not the `next-server` worker child that actually serves HTTP. To gauge real load, use `/api/system` (in-process `process.memoryUsage()`) or `scripts/perf-monitor.ts` (which walks the process tree to the worker). `pm2 list` will lie to you about how heavy dev is.
- **Dev process tree:** `npm → next dev → next-server` (3 procs under Turbopack). Prod tree: `npm → next-server` (2 procs — `next start` doesn't fork). `max_memory_restart` in `~/salsquared/ecosystem.config.cjs` watches the npm wrapper, not the worker, so the cap is effectively cosmetic for memory leaks in the actual server. Worker stability lives in `process.memoryUsage()` checks, not PM2's cap.
- **Verbose-log gates** (added 2026-05-20 for SSE fan-out reasons): `[DATABASE]` Prisma logs muted in dev unless `DEBUG_PRISMA=1`; `[CACHE HIT]` / `[CACHE MISS]` from `lib/cache.ts` and `[API Request]` from `proxy.ts` muted in dev unless `DEBUG_VERBOSE_LOG=1`. All on in production (the in-app log viewer is the canonical observability surface there).
- **Dev-server perf profile** lives at [`docs/perf-profile.md`](./docs/perf-profile.md). Active perf-monitor harness: `scripts/perf-monitor.ts` (env-configurable, supports `MC_PERF_RESTART=1` for cold-baseline AB comparisons). Writes JSONL + a markdown summary to `data/perf/`.
- Scope authorization via `lib/auth.ts` is the only place that requests Google tokens. Server-side Gmail/Calendar callers should always go through `getGoogleAuthClient(userId)`, never construct an OAuth client inline.
- API routes that fetch external data should be wrapped in `withCache` — bare external `fetch` per request is the exception, not the rule.
- For server-side logging use `console.info` / `console.warn` / `console.error` (they're captured by the in-app log viewer). Don't introduce a separate logger.
- `.env*` files are gitignored. The checked-in `.env.development` / `.env.production` hold non-secret runtime config: `DATABASE_URL`, `NEXTAUTH_URL`, `PULSAR_URL`, `CACHE_BACKEND`, and `EMAIL_ENABLED` (see below). Real secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `GEMINI_API_KEY`, `CHROME_EXECUTABLE_PATH` override, AI keys, etc.) live in an untracked `.env`. `GOOGLE_GENERATIVE_AI_KEY` powers the resume-generation pipeline (see `lib/ai/gemini.ts`; falls back to `GOOGLE_GEN_AI_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`). A free key comes from Google AI Studio (aistudio.google.com).
- **`EMAIL_ENABLED` is the master Gmail-send switch.** `lib/email/send.ts` checks it before calling `gmail.users.messages.send`. `EMAIL_ENABLED=1` in `.env.production` so prod actually delivers application-side notifications (OFFER / REJECTION / INTERVIEW_SCHEDULED / ASSESSMENT_REQUESTED). `EMAIL_ENABLED=0` in `.env.development` so test runs and the pre-push hook don't blast the inbox. When `EMAIL_ENABLED !== "1"`, `dispatchNotificationEmail` records `emailError = "Email muted (EMAIL_ENABLED != 1)"` on the notification row instead of dispatching — the in-app surface still fires. To verify the pipeline ad-hoc: `EMAIL_ENABLED=1 pm2 restart mission-control-dev` and hit `/api/notifications/test`.

## Backups + recovery

Two pieces of state matter:

- **`prisma/prod.db`** — every Application, ApplicationEvent, Profile entity, Watchlist, JobPosting, Notification, GeneratedResume row.
- **`data/resumes/<id>.<ext>`** — the actual PDF/DOCX bytes archived per generation. `GeneratedResume.artifactPath` points at this directory.

`scripts/backup-db.sh` snapshots both, mirrors to Google Drive via rclone, and prunes local copies older than 30 days. Designed for cron / launchd; run by hand any time. Falls back to local-only if rclone isn't on PATH (warns loudly).

**Set up the cron (run once):**

```sh
# Open crontab editor
crontab -e

# Add:
# 0 4 * * *  cd /Users/sal/salsquared/mission-control && ./scripts/backup-db.sh >> ~/backups/mission-control/backup.log 2>&1
```

**Recovery — Mac died, fresh machine:**

```sh
# 1. Pull the latest backup from Drive
rclone copy gdrive:backups/mission-control/  ~/restore/  --include "mc-*.db" --include "mc-resumes-*.tar.gz"

# 2. Stop everything
pm2 stop mission-control mission-control-dev mission-control-scheduler-dev mission-control-scheduler-prod

# 3. Restore the DB
cp ~/restore/mc-LATEST.db prisma/prod.db
rm -f prisma/prod.db-wal prisma/prod.db-shm   # let SQLite rebuild WAL sidecars

# 4. Restore artifacts
rm -rf data/resumes/*    # leave .gitkeep
tar -xzf ~/restore/mc-resumes-LATEST.tar.gz -C data/

# 5. Bring services back up
pm2 start mission-control mission-control-dev mission-control-scheduler-dev mission-control-scheduler-prod
```

The Cloudflare tunnel (`cloudflared` PID checked via `pm2 list` won't show it — it's a system-level process via Homebrew) handles the public-hostname side. `requireLocalOrSession` in `lib/auth-guards.ts` gates tunnel traffic behind NextAuth while LAN hosts (localhost / mc.local) skip auth.
