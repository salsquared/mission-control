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
| `mission-control-scheduler` | — | shared | `scheduler/index.ts` |

Restart / inspect:
- `pm2 restart mission-control-dev` — pick up config changes (next.config.ts, env, etc.) on the dev tier.
- `pm2 restart mission-control` — same for prod after a fresh build.
- `pm2 logs mission-control-dev` (or `mission-control` / `mission-control-scheduler`) — tail logs.
- `pm2 list` — quick status of all three.

The npm scripts themselves remain useful for one-offs:
- `npm run build` — production build (webpack). Run before restarting `mission-control` so it picks up new compiled code.
- `npm run lint` — ESLint (flat config, extends `eslint-config-next`).
- `./launch-ms.sh` — convenience launcher that ensures the prod PM2 process is up and opens Chrome in `--app=` mode at `http://localhost:3101`. `./launch-ms.sh --restart` force-kills and recreates the PM2 process.
- `npx prisma migrate dev` / `npx prisma generate` — schema lives at `prisma/schema.prisma` (SQLite). Dev and prod use **separate DB files** in `prisma/`.

There is no test runner configured. One-off scripts (DB checkers, fetcher experiments, parser tests) belong in `scripts/tests/` as kebab-case `.ts` files and are run with `tsx` (e.g. `npx tsx scripts/tests/check-cache.ts`). This is enforced — do not put experiments in the repo root or `/tmp`.

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

### Gemini rate limiting

`lib/ai/rate-limit.ts:acquireGeminiSlot()` is a process-shared token bucket gating every Gemini API call. Defaults: 12 req/min, burst cap 60. Tunable via `GEMINI_RATE_PER_MIN` / `GEMINI_RATE_BURST` env vars. Both `lib/email-parser.ts:parseApplicationEmail` and `lib/ai/gemini.ts:chatJSON` await it before each attempt — retries pay the rate cost too. New Gemini callers MUST go through one of those two helpers, never call the SDK directly without `await acquireGeminiSlot()`.

### Prisma + dual SQLite databases

`lib/prisma.ts` exports a single extended `PrismaClient` whose `$allOperations` middleware logs every query through `console.info` (so it lands in the in-app log viewer). The client is cached on `globalThis` in dev to survive HMR. **Dev and prod read different SQLite files** (`prisma/dev.db` vs `prisma/prod.db`) selected by which `.env.{development,production}` Next.js picks up. When debugging prod data issues, point at `prisma/prod.db` explicitly.

When invoking a `tsx` script against the dev DB (e.g. `scripts/tests/*.ts`), pass `DATABASE_URL="file:./dev.db"` — **not** `file:./prisma/dev.db`. Prisma resolves a relative `file:` URL from the schema's directory (`prisma/`), so `file:./prisma/dev.db` silently creates a phantom `prisma/prisma/dev.db` and you'll get empty-DB results.

Schema highlights: standard NextAuth tables (`Account`/`Session`/`User`/`VerificationToken`), `Application` + `ApplicationEvent` (job tracker), `Task` (DB-native, see below), `LifeGoal`, `SavedPaper` + weekly selection tables (`SelectedHistoricalPaper`, `SelectedReviewPaper`), `GlobalSetting` (single row keyed `id="global"`), `Watchlist` + `JobPosting` (discovery feed), `Notification` (in-app bell + email dispatcher), `WebhookDelivery` (Pub/Sub messageId dedup), `GeneratedResume`.

Race-safety + dedup invariants baked into the schema (don't paper over by bypassing):
- `Application.normalizedCompany` + `@@unique([userId, normalizedCompany])` — concurrent `createApplication` for the same employer throws P2002; `lib/applications/ingest.ts` catches and falls through to update. Use `normalizeCompanyName` from `lib/applications/normalize-company.ts` for any new comparison path.
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

`@serwist/next` wraps the Next config in `next.config.ts` and emits `public/sw.js` from `app/sw.ts`. **The service worker is disabled in dev** (`disable: isDev`); the webpack `watchOptions.ignored` list also excludes `public/sw.js`, `public/sw.js.map`, and Prisma DB files to prevent dev-mode reload loops. If you add generated artifacts in `public/`, add them to that ignore list too.

## Documentation conventions

- Node-based graphs (architecture diagrams, flowcharts, dependency graphs, etc.) must use Mermaid syntax — never ASCII art.
- Inside Mermaid node/edge labels, use `<br/>` for line breaks — **not** `\n`. The renderer used to preview these docs does not interpret `\n` inside labels and will render them literally. Parens inside edge labels (`|...|`) must be quoted (`|"text()"|`); parens inside quoted node labels (`["text()"]`) are fine.

## Conventions and gotchas

- `reactStrictMode: false` in `next.config.ts` — components are not double-mounted in dev. Don't rely on strict-mode side-effect detection.
- The dev-server-only `--max-old-space-size=2048` is intentional; lower it and parser/fetcher routes can OOM on big pages.
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
pm2 stop mission-control mission-control-dev mission-control-scheduler

# 3. Restore the DB
cp ~/restore/mc-LATEST.db prisma/prod.db
rm -f prisma/prod.db-wal prisma/prod.db-shm   # let SQLite rebuild WAL sidecars

# 4. Restore artifacts
rm -rf data/resumes/*    # leave .gitkeep
tar -xzf ~/restore/mc-resumes-LATEST.tar.gz -C data/

# 5. Bring services back up
pm2 start mission-control mission-control-dev mission-control-scheduler
```

The Cloudflare tunnel (`cloudflared` PID checked via `pm2 list` won't show it — it's a system-level process via Homebrew) handles the public-hostname side. `requireLocalOrSession` in `lib/auth-guards.ts` gates tunnel traffic behind NextAuth while LAN hosts (localhost / mc.local) skip auth.
