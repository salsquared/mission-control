# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Next.js dev server on **port 4101**, webpack, `--max-old-space-size=2048`. Loads `.env.development` (`DATABASE_URL=file:./dev.db`).
- `npm run build` — production build (webpack).
- `npm run start` — production server on **port 3101**, `--max-old-space-size=1024`. Loads `.env.production` (`DATABASE_URL=file:./prod.db`).
- `npm run lint` — ESLint (flat config, extends `eslint-config-next`).
- `./launch-ms.sh` — production launcher: starts the built server under PM2 (`mission-control` process) and opens Chrome in `--app=` mode at `http://localhost:3101`. `./launch-ms.sh --restart` force-kills and recreates the PM2 process. The PM2 process persists after the Chrome window closes; logs via `pm2 logs mission-control`.
- `npx prisma migrate dev` / `npx prisma generate` — schema lives at `prisma/schema.prisma` (SQLite). Dev and prod use **separate DB files** in `prisma/`.

There is no test runner configured. One-off scripts (DB checkers, fetcher experiments, parser tests) belong in `scripts/tests/` as kebab-case `.ts` files and are run with `tsx` (e.g. `npx tsx scripts/tests/check-cache.ts`). This is enforced — do not put experiments in the repo root or `/tmp`.

Node.js LTS is required (project pins to v24.x via nvm). Path alias `@/*` resolves to the repo root.

## Architecture

### App shell: Dashboard as a slide carousel of "Dashes"

`components/Dashboard.tsx` is the top-level client component (mounted via `app/page.tsx` with `ssr: false`). It renders one **View** (a "dash") at a time out of `BASE_DASHES` and provides three global overlays:

- **Launchpad** (`components/overlays/LaunchpadOverlay.tsx`) — grid picker for switching dashes.
- **Library** (`components/overlays/SavedPapersOverlay.tsx`) — saved research papers, scoped to the current dash's topic via `getTopic(id)`.
- **AI Companion** (`components/AICompanion.tsx`) — context-aware chat, receives the current dash id as `activeContext`.

Dash order, per-dash hue, custom titles, and screenshots are all owned by **`components/providers/themeStore.ts`** (Zustand). `Dashboard` mounts and calls `syncAvailableDashes(BASE_DASHES)` on every load to reconcile persisted state with the current code (purges stale ids, appends new ones, force-pins `internal-systems` last). The active dash id is persisted **per-device in `localStorage` under `mc-active-view`** — intentionally not in the Zustand store, so different devices remember different last-viewed dashes.

When adding a new dash: add an entry to `BASE_DASHES` in `Dashboard.tsx`, register its topic in `getTopic()` if it has saved papers, and add a default title + hue in `themeStore.ts`. `syncAvailableDashes` will pick it up.

### Component hierarchy (enforced by directory)

`docs/frontend_terminology.md` is the canonical reference. Bottom-up: `ui/` & `widgets/` → `cards/` & `Window.tsx` → `grids/` → `Section.tsx` → `views/` → `Dashboard.tsx`. Cards wrap Widgets; Grids arrange Cards; Sections group Grids by theme; Views aggregate Sections; the Dashboard hosts Views. **Windows** (e.g., `AICompanion`) are floating-overlay siblings of Cards that escape the grid. Respect this when creating new components — the directory dictates the role.

shadcn/ui is configured (`components.json`, "new-york" style, neutral base, lucide icons) but components live under `components/ui/` as hand-written TSX rather than a generated registry.

### API routes + caching

API routes live under `app/api/<feature>/route.ts`. Two cross-cutting wrappers:

- **`lib/cache.ts` `withCache(handler, ttlSeconds)`** — process-memory cache keyed on `pathname + sorted query` (the `?v=...` cache-buster is stripped before keying and forces a refresh). On handler error or non-OK response it falls back to the last good payload and rewrites the entry with a 60s retry TTL. Stats are surfaced via `/api/system`. Cache-Control is set to `no-store` in dev so the browser never caches; production sets `max-age` + `stale-while-revalidate`.
- **`middleware.ts`** — logs every `/api/*` request. The matcher is the only thing keeping middleware off non-API routes, so don't broaden it casually.

Wrap any route that hits an external API (or does expensive work) in `withCache`. The cache survives HMR by attaching to `globalThis` in dev.

### Logger ring buffer

`instrumentation.ts` calls `lib/logger.ts:initLogger()` once on Node.js startup. This **monkey-patches `console.{log,info,warn,error}` and `process.stdout/stderr.write`** to push entries into a 500-deep in-memory ring buffer that lives on `globalThis` (HMR-safe). `/api/system/logs` reads it and the Internal Systems dash subscribes via `subscribeToLogs()` for live tailing. Implication: server-side `console.*` from anywhere in the app — including third-party libraries — shows up in the in-app log viewer. Don't replace `console` calls with a separate logger lib without considering this.

### Auth (Google OAuth + offline access)

`lib/auth.ts` wires NextAuth with `PrismaAdapter` and a single Google provider. The provider requests `access_type=offline` and the **Gmail readonly + send** and **Calendar events** scopes — the long-lived refresh token is stored on the `Account` row. `lib/googleapis.ts:getGoogleAuthClient(userId)` rebuilds an OAuth2 client from that refresh token; all server-side Gmail/Calendar code goes through it. The session callback attaches `user.id` onto `session.user` so route handlers can pass it straight to `getGoogleAuthClient`.

Anything that reads/sends Gmail or writes Calendar events depends on these scopes. Adding a new Google scope requires bumping the `scope` string in `authOptions` and re-consenting.

### Prisma + dual SQLite databases

`lib/prisma.ts` exports a single extended `PrismaClient` whose `$allOperations` middleware logs every query through `console.info` (so it lands in the in-app log viewer). The client is cached on `globalThis` in dev to survive HMR. **Dev and prod read different SQLite files** (`prisma/dev.db` vs `prisma/prod.db`) selected by which `.env.{development,production}` Next.js picks up. When debugging prod data issues, point at `prisma/prod.db` explicitly.

Schema highlights: standard NextAuth tables (`Account`/`Session`/`User`/`VerificationToken`), `Application` (job tracker), `Task` (synced from `docs/todo.md`, see below), `LifeGoal`, `SavedPaper` + weekly selection tables (`SelectedHistoricalPaper`, `SelectedReviewPaper`), `CryptoPrice` time series, and `GlobalSetting` (single row of JSON keyed `id="global"`).

### Task system: markdown file ↔ DB

`docs/todo.md` is the **source of truth** for tasks. `lib/tasks/parser.ts:syncTasksFromFile()` walks the file, assigns/preserves stable ids in inline HTML comments (`<!-- id: ... -->`), parses priority emoji (🔴🟡🔵🟢), `@due(date)` annotations, and indentation-based parent/child relationships, then upserts the `Task` table.

`app/api/tasks/route.ts`:
- `GET` — re-syncs only when the file's mtime changed (uses `lastSyncedMtime`); accepts `?force=true`.
- `PATCH` — rewrites the matching markdown line **first**, bumps `lastSyncedMtime` to skip the next auto-sync, then updates the DB row directly for snappier UI. An in-memory `Mutex` serializes file writes.
- `POST` — appends a new task line (optionally under a parent), then re-syncs.

When adding task fields, both the regex parser and the PATCH line-rewriter need to be updated, and `prisma/schema.prisma:Task` extended.

### Pluggable news ingestion

`lib/company-registry.ts` is a registry of company news feeds, each declaring a fetch strategy. The strategies live in `lib/fetchers/` (`rss`, `scrape`, `snapi`, `google-news`) and the registry dispatches to them by `strategy` field. Bespoke API shapes (SpaceX JSON API, OpenAI's RSS-with-Microlink-image-fallback, Groq's dual-page scrape, etc.) are **inline custom fetchers** in `company-registry.ts` rather than new strategy modules — adding a new RSS source should be ~5 lines of config; only invent a new strategy when the shape is genuinely new. TTL presets (`TTL_STANDARD`, `TTL_LOW_VOLUME`, `TTL_VERY_LOW`) are picked per company based on posting cadence.

Article count is capped by `MAX_NEWS_ARTICLES` in `lib/constants.ts`.

### PWA / service worker

`@serwist/next` wraps the Next config in `next.config.ts` and emits `public/sw.js` from `app/sw.ts`. **The service worker is disabled in dev** (`disable: isDev`); the webpack `watchOptions.ignored` list also excludes `public/sw.js`, `public/sw.js.map`, and Prisma DB files to prevent dev-mode reload loops. If you add generated artifacts in `public/`, add them to that ignore list too.

## Documentation conventions

- Node-based graphs (architecture diagrams, flowcharts, dependency graphs, etc.) must use Mermaid syntax — never ASCII art.

## Conventions and gotchas

- `reactStrictMode: false` in `next.config.ts` — components are not double-mounted in dev. Don't rely on strict-mode side-effect detection.
- The dev-server-only `--max-old-space-size=2048` is intentional; lower it and parser/fetcher routes can OOM on big pages.
- Scope authorization via `lib/auth.ts` is the only place that requests Google tokens. Server-side Gmail/Calendar callers should always go through `getGoogleAuthClient(userId)`, never construct an OAuth client inline.
- API routes that fetch external data should be wrapped in `withCache` — bare external `fetch` per request is the exception, not the rule.
- For server-side logging use `console.info` / `console.warn` / `console.error` (they're captured by the in-app log viewer). Don't introduce a separate logger.
- `.env*` files are gitignored. There are checked-in `.env.development` and `.env.production` that **only** contain `DATABASE_URL` — real secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, AI keys, etc.) live in an untracked `.env`.
