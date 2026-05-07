# Architecture Design Review

> **Document scope.** This is a synthesis review of the Mission Control system as it exists in the repository today. It complements the surface-level documents in `docs/` (`apis.md`, `frontend_terminology.md`, `hosting.md`, `todo.md`) by describing the system as a whole — its goals, layers, data flows, integration points, deployment model, observability, and the trade-offs and risks embedded in the current design. Where this document and the surface docs disagree, this document reflects what the code actually does.

---

## 1. Goals and Operating Context

Mission Control is a **single-user, self-hosted dashboard** that aggregates real-time and curated information across several life/work domains and exposes interactive control over a subset of them. It is not a SaaS product: it runs on the author's Mac mini at home, is reached locally (and intended to be reached from the LAN/PWA), and is consumed primarily through a Chrome "App Mode" window opened by `launch-ms.sh`.

The intentional design constraints that shape every other decision below are:

1. **Single user, single host.** Auth, session model, DB, caches, and hosting are all designed around one operator. There is no multi-tenancy, no horizontal scaling story, no role model.
2. **Always-on background process.** The production server is a persistent PM2 process; the UI is a thin client over it. Server uptime is part of the user experience.
3. **Hardware budget is small.** Mac mini RAM is the binding resource. Dev is capped at 2 GB old-space, prod at 1 GB (`package.json` scripts). Every "is it worth caching" decision is biased toward "yes."
4. **External APIs are flaky and rate-limited.** Most data does not originate here. The system's job is to wrap, normalize, cache, and degrade gracefully around a long tail of third-party APIs and HTML pages.
5. **The author is the only consumer.** "Documented" can mean "in `todo.md`," secrets can live in `.env`, and a feature can ship behind a `console.log`. This is reflected in the level of error-handling and validation throughout.

Everything that looks "weird" in the codebase — markdown-as-source-of-truth, in-process pub/sub for logs, an in-memory cache that survives HMR via `globalThis`, hand-written HTML scrapers per company — is downstream of these constraints.

---

## 2. System Context

```mermaid
graph TB
    subgraph External["External APIs / Pages"]
        Ext["CoinGecko · Mempool.space · Space Devs LL2 · SNAPI · CelesTrak · NOAA SWPC<br/>Hugging Face · arXiv · Semantic Scholar · LM Arena · HN Algolia · Yahoo Finance<br/>~40 company RSS/blogs · Microlink · open-graph-scraper · Google OAuth/Gmail/Calendar"]
    end

    subgraph Server["Next.js 16 server (PM2 → port 3101 / 4101)"]
        API["/api/*"] --> Cache["withCache (in-proc)"]
        API --> Prisma["Prisma"] --> SQLite["SQLite (dev.db | prod.db)"]
        API --> Fetchers["fetchers/ · company-registry"]
        API --> Tasks["tasks/parser ↔ docs/todo.md"]
        API --> Logger["logger (monkey-patched console)"]
        API --> GAPIs["googleapis (per-user OAuth client)"]
        Dashboard["Dashboard (RSC-disabled, use client)<br/>Views – Sections – Grids – Cards/Widgets"]
    end

    Ext -->|"HTTPS, mostly anon"| API
    User["User (browser)"] -->|"Chrome App Mode / PWA via Serwist"| API
    PubSub["Pub/Sub topic"] -->|"Google Cloud Pub/Sub push (Gmail history)"| API
```

The system has **one inbound integration that is not user-driven**: Google Cloud Pub/Sub pushes Gmail history events to `POST /api/gmail/webhook`. Everything else is initiated by the browser polling or fetching on demand.

---

## 3. Layered Architecture

The codebase is organized along the lines defined in `docs/frontend_terminology.md`. The full layering, including the server-side mirror, is:

| Layer | Location | Responsibility |
|---|---|---|
| **Hosting / Process** | `launch-ms.sh`, PM2 | Process supervision, environment loading, port management, Chrome app launcher |
| **Framework** | `next.config.ts`, `instrumentation.ts`, `middleware.ts` | Next.js (webpack), Serwist PWA wrapping, request logging, in-process logger init |
| **Persistence** | `prisma/`, `lib/prisma.ts` | SQLite via Prisma; dual DB files for dev/prod; query-level logging via `$extends` |
| **Domain libraries** | `lib/` | `cache`, `auth`, `googleapis`, `email-parser`, `company-registry`, `fetchers/*`, `tasks/parser`, `logger` |
| **HTTP API** | `app/api/**/route.ts` | Thin route handlers; dispatch to lib code; wrap with `withCache` where useful |
| **App shell** | `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `app/sw.ts` | Root providers, font loading, PWA SW, OKLCH theme variables |
| **Dashboard** | `components/Dashboard.tsx` | Slide carousel of dashes, global overlays (Launchpad, Library, AI Companion), bottom nav |
| **Views** | `components/views/*` | One per "dash" — owns data fetching for its section |
| **Sections** | `components/Section.tsx` | Thematic groupings inside a view, optional sub-headered groups |
| **Grids** | `components/grids/CardGrid.tsx` | Layout-only container; supports CSS-grid or CSS-columns masonry |
| **Cards** | `components/cards/*` | Bounded content units; receive data as props |
| **Widgets** | `components/widgets/*` | Stand-alone data/UX components (Kanban, Calendar, Graph, LaunchCalendar) |
| **Windows / Overlays** | `components/Window.tsx`, `components/overlays/*` | Floating/sliding UI that escapes the grid |
| **UI primitives** | `components/ui/*` | Card, ReloadButton, Scrollbar, PaperActions, TaskItem, CarouselControls |
| **State providers** | `components/providers/*` | NextAuth `SessionProvider`, `ThemeProvider`, Zustand stores (`themeStore`, `settingsStore`) |

A read-through of any feature touches at least four of these layers (e.g., FinanceView → CardGrid → AssetPriceCard → `/api/finance` → `withCache` → CoinGecko + Prisma).

---

## 4. Data Architecture

### 4.1 Storage choice

Persistence is **SQLite via Prisma**, with two separate database files swapped by environment:

- `prisma/dev.db` — selected by `.env.development`
- `prisma/prod.db` — selected by `.env.production`

This is appropriate for the single-host use case but means **every restart of `next dev` and `next start` works on a different dataset** unless the user is careful. There is no migration story across environments other than re-running `prisma migrate dev`.

### 4.2 Schema overview

The Prisma schema groups into four roughly orthogonal subdomains:

| Subdomain | Models | Purpose |
|---|---|---|
| **NextAuth** | `User`, `Account`, `Session`, `VerificationToken` | Standard NextAuth + Prisma adapter; stores Google refresh/access tokens on `Account` |
| **Applications pipeline** | `Application` | Job/internship/admissions tracker; owned by user; fed by Gmail webhook + manual edits |
| **Research library** | `SavedPaper`, `SelectedHistoricalPaper`, `SelectedReviewPaper` | User's saved papers + per-week deduplication ledgers for "paper of the week" features |
| **Crypto** | `CryptoPrice` | Time-series of BTC prices logged on each `/api/finance` hit and from seed scripts |
| **Tasks / Goals** | `Task`, `LifeGoal` | `Task` is a *projection* of `docs/todo.md`; `LifeGoal` is a separate, DB-native model |
| **Settings** | `GlobalSetting` | One row keyed `"global"` containing JSON of theme/dash preferences |

Notable: the `Task` table is **not** the source of truth for tasks. `docs/todo.md` is. Stable IDs are injected as inline HTML comments (`<!-- id: ... -->`) and the DB row is rewritten from the file on every mtime change.

### 4.3 Data flow patterns

The codebase uses **five distinct data-flow patterns**, each appropriate to a different class of data:

1. **External-API-only, fully cached** — most space/AI/research/news endpoints. `withCache(handler, ttl)` is the only persistence; on error, last-good is served. Examples: `/api/space/launches`, `/api/research`, `/api/ai/llmleaderboard`, `/api/company-news`.
2. **External + DB ledger** — `selectedReviewPaper` and `selectedHistoricalPaper` deduplicate weekly picks, and the historical/review endpoints check DB first before re-querying arXiv. The DB is a *commitment log*, not a cache.
3. **External + DB time-series** — `/api/finance` calls CoinGecko on every cache miss and inserts a `CryptoPrice` row, building a 24h history that the same response then reads back. The endpoint doubles as an opportunistic ingester. (`scripts/seed-crypto.ts` and `scripts/ingest-btc-history.ts` exist for backfill.)
4. **File-as-source-of-truth** — `docs/todo.md` ↔ `Task` table. `app/api/tasks/route.ts` re-syncs only when the file's mtime advances; PATCH/POST mutate the file *first*, then DB. An in-memory `Mutex` serializes file writes.
5. **External event-driven** — Google Cloud Pub/Sub pushes Gmail history events to `/api/gmail/webhook`, which decodes the base64 envelope, calls `gmail.users.history.list`, fetches new messages, and runs them through `parseApplicationEmail` (Gemini 3.0 Flash via `@ai-sdk/google`) to upsert `Application` rows. This is the only inbound integration.

Pattern 1 is the dominant one: **most endpoints are stateless cache-fronted external proxies.**

---

## 5. API Layer

### 5.1 Catalog (by feature area)

A complete inventory is maintained in `docs/apis.md`. The brief by-feature breakdown:

- **Auth** — `[...nextauth]` only. Google provider; offline access; Gmail r/o + Gmail send + Calendar events scopes.
- **System** — `/api/system` (telemetry — CPU, RSS, uptime, DB ping, cache stats), `/api/system/logs` (SSE stream).
- **AI** — `/api/ai` (HN Algolia AI stories), `/api/ai/llmleaderboard` (LM Arena scrape).
- **Research** — `/api/research`, `/research/hf`, `/research/historical`, `/research/review`, `/research/import`, `/research/saved`. Backed by Hugging Face Daily Papers, arXiv RSS, Semantic Scholar batch enrichment.
- **Finance** — `/api/finance`, `/api/finance/history`. CoinGecko, Mempool.space, Yahoo Finance for long-range BTC.
- **Space** — `/api/space` (SNAPI), `/space/launches` (Space Devs LL2), `/space/satellites` (CelesTrak), `/space/solar` (NOAA SWPC), `/space/moon` (deterministic ephemeris + hardcoded phenomena).
- **Company news** — `/api/company-news?company=<id>`. Strategy-dispatched (see §6).
- **Applications / Calendar / Gmail** — `/api/applications` (NextAuth-gated read), `/api/calendar/event` (Google Calendar GET/POST/DELETE), `/api/gmail/webhook` (Pub/Sub push).
- **Tasks / Goals / Settings** — `/api/tasks` (mtime-gated md ↔ DB sync), `/api/goals` (DB CRUD on `LifeGoal`), `/api/settings` (single JSON blob upsert).

### 5.2 Cross-cutting concerns

- **Middleware** (`middleware.ts`) — only logs `/api/*` requests via `console.info`. The matcher is narrow on purpose; broadening it sweeps assets and pages into the in-app log viewer.
- **Caching** (`lib/cache.ts`) — process-memory `Map<string, {data, expiry}>` keyed by `pathname + sorted query` (the `?v=...` cache buster is stripped before keying and forces a refresh). On handler error or non-2xx response, the last good entry is served and rewritten with a 60 s retry TTL. `Cache-Control` is `no-store` in dev and `max-age + stale-while-revalidate` in prod. Stats survive HMR via `globalThis`.
- **Auth gating** — only `/api/applications` reads the NextAuth session. `/api/calendar/event` takes `userId` as a query param and trusts it. `/api/gmail/webhook` trusts the Pub/Sub envelope's `emailAddress` to look up the user. **There is no Pub/Sub signature verification** — see §11.
- **Logging** — every route logs `[EXTERNAL API]`, `[DATABASE]`, `[CACHE HIT|MISS|FALLBACK]` lines through the patched `console`, which the SSE log stream re-broadcasts.

### 5.3 Conventions worth preserving

- `?v=<timestamp>` is the standard "force refresh" idiom across the frontend, handled inside `withCache`.
- Routes that fetch external data should be wrapped in `withCache`; bare `fetch` per request is the exception.
- Server-side logs go through `console.{info,warn,error}` so the SSE stream picks them up; introducing a separate logger would silently bypass the in-app log viewer.

---

## 6. Company News Subsystem

Out of all the per-feature subsystems, the company-news pipeline is the most engineered and deserves its own section. It is the answer to "given ~40 companies that publish through wildly different channels, how do we surface a uniform `NewsArticle[]` for each?"

### 6.1 Strategy registry

`lib/company-registry.ts` defines `COMPANY_REGISTRY: CompanyFeedConfig[]`. Each entry declares a fetch `strategy` and the strategy-specific config. Strategies (defined by `lib/fetchers/types.ts`):

- **`rss`** — `lib/fetchers/rss-fetcher.ts`. Parses an RSS/Atom feed; enriches each item with an OG image via `open-graph-scraper`. Used for NASA, ESA, Nvidia, Hugging Face, Microsoft Research, etc.
- **`scrape`** — `lib/fetchers/scrape-fetcher.ts`. Fetches a listing page, extracts `(slug, innerHTML)` pairs via a configurable `articleRegex`, optionally pulls title and date sub-regexes from the inner HTML, then enriches each via OGS. Used for Anthropic, xAI, Mistral, Qualcomm, Apple ML, ARM, Rocket Lab.
- **`snapi`** — `lib/fetchers/snapi-fetcher.ts`. Spaceflight News API search by `title_contains`. Used as a "what is third-party space press saying" feed for prime contractors and agencies that don't have RSS.
- **`google-news`** — `lib/fetchers/google-news-fetcher.ts`. Wraps Google News RSS search with a 7-day window; used as the fallback for paywalled or scrape-resistant sources (SemiAnalysis, foundries, Roscosmos, ByteDance).
- **`custom`** — inline functions in `company-registry.ts` for sources whose shape doesn't fit any of the above:
  - `fetchSpaceX` — SpaceX has its own JSON updates API.
  - `fetchOpenAI` — RSS + Microlink for images (Cloudflare blocks OGS).
  - `fetchGroq` — scrapes both `/blog` and `/newsroom` in parallel and merges by date; shifts midnight-UTC timestamps to noon-UTC to avoid timezone-rollback display bugs.
  - `fetchCerebras` — listing scrape with positional date/title pairing.
  - `fetchMetaAI` — listing scrape with proximity-based date/URL pairing because individual posts lack OG date metadata.

### 6.2 TTL discipline

Three tier presets (`TTL_STANDARD = 1h`, `TTL_LOW_VOLUME = 24h`, `TTL_VERY_LOW = 7d`) are assigned per company based on observed publishing cadence. Companies that post daily get the standard 1 h; small startups posting monthly get 7 d. This prevents the cache from constantly cycling on companies that don't change.

### 6.3 Operational implications

- **Adding a new RSS source is ~5 lines** of registry config; adding a new strategy requires a new fetcher module.
- **Custom fetchers are deliberately *inline*** — they're so per-source that abstracting them would be premature.
- **Failure mode is per-source.** A failing scraper doesn't break the view; the route returns whatever succeeds and the `withCache` layer keeps the last-good payload behind it.
- The registry is also consumed by the **frontend** — `AIView` and `SpaceView` import `COMPANY_REGISTRY` directly to know what to render and how to group it. The same file is the catalog for both fetcher dispatch *and* UI grouping.

---

## 7. Frontend Architecture

### 7.1 Shell: Dashboard as a slide carousel

`components/Dashboard.tsx` is the only top-level client component (`app/page.tsx` mounts it with `ssr: false`). It owns a `BASE_DASHES: DashConfig[]` array — currently seven entries: Space, Crypto/Finance, AI News, Internal Systems, Physics, Applications, Planning & Strategy. At any moment one dash is rendered full-screen; navigation is `←/→` buttons or the **Launchpad** overlay.

Three global overlays are owned by Dashboard:

- **LaunchpadOverlay** — grid view of all dashes with 0.25× live previews of each (real components, scaled via CSS transform inside a `pointer-events: none` mask so internal charts/inputs don't capture drags). Edit mode toggles drag-to-reorder + inline title editing. Local `localOrder` state during a drag prevents thrashing the global Zustand store and the `/api/settings` upstream sync on every frame; the `setDashOrder` call only fires on `dragend`.
- **SavedPapersOverlay** — right-sliding library panel scoped to the current dash's topic via `getTopic()`. Tabs for Waitlist / Favorites / Read / Import; the Import flow calls `POST /api/research/import` for preview, then `POST /api/research/saved` to persist.
- **AICompanion** — bottom-right floating Window receiving the current dash id as `activeContext`. **Currently a stub**: maintains local message state with a hardcoded delayed response (`AICompanion.tsx:36-42`). It does not call any API. This is the most prominent place where the UI's ambition exceeds the implementation; the surrounding work (auth scopes, Pub/Sub, Gemini integration in `email-parser.ts`) suggests the eventual implementation will use the same `@ai-sdk/google` plumbing.

### 7.2 The Dash registration contract

Adding a dash requires:

1. An entry in `BASE_DASHES` (id, title, component).
2. A topic mapping in `getTopic()` if the dash has saved papers.
3. A default title and hue in `themeStore.ts`'s `defaultDashTitles` and `viewHues`.

`syncAvailableDashes()` runs on every Dashboard mount and reconciles persisted state with current code: it purges stale ids, appends new ones, and force-pins `internal-systems` to the end of `dashOrder`. This means `themeStore` cannot accumulate dead state across code changes.

### 7.3 Per-view data ownership

Each view owns its own data fetching. There is no global polling daemon, no React Query, no SWR — just `useEffect` + `fetch` on mount and manual refresh handlers (with `?v=<ts>` cache busters). A handful of views set up intervals:

| View | Interval | What |
|---|---|---|
| `InternalView` | 5 s | `/api/system` poll + EventSource for `/api/system/logs` |
| `FinanceView` | 30 s (display) | The display-only "X minutes ago" pill rerenders; data itself is fetched on demand and via `withCache(300)` server-side |
| `SpaceView`, `AIView`, `PhysicsView` | none | Fetch on mount + manual refresh buttons; rely on server-side cache TTLs |
| `ApplicationsView` | none | Fetches on session ready |
| `PlanningView` | none | Fetches once; bumps `?force=true` on manual reload to force md re-sync |

Optimistic UI is used for state that the user mutates directly: `PlanningView` task status changes, `ResearchPaperCard` save toggles, `SavedPapersOverlay` deletes, `GoalCard` toggles. All revert on error.

### 7.4 State management

Two Zustand stores plus a few targeted browser primitives:

- **`themeStore`** (`components/providers/themeStore.ts`) — global UI preferences: `isDarkMode`, `viewHues` (per-view 0–360° hue), `viewHuesEnabled`, `dashOrder`, `dashTitles`, `defaultDashTitles`, `viewScreenshots`. **Not persisted by Zustand**: instead, `ThemeProvider` syncs the relevant subset to `/api/settings` (single-row JSON blob) on every change after first hydration. This was an explicit migration from `localStorage` to a DB-backed store so customizations follow the user across devices on the LAN (see `docs/todo.md` completed items).
- **`settingsStore`** (`components/providers/settingsStore.ts`) — feature flags (`autoResearch`, `backgroundTasks`). Persisted with Zustand `persist` middleware to `localStorage` under key `'settings-storage'`. These are device-local on purpose — they gate behaviors like background research polling that should not be active on every device simultaneously.
- **`localStorage` directly** — `mc-active-view` stores the last-viewed dash id, intentionally per-device.
- **NextAuth session** — `useSession()` in views that need the logged-in user (Applications, Internal for sign-in/out controls).

The result: **nothing about the UI requires global polling, websockets, or a Redux-like store**. The most "live" view is InternalView via SSE; everything else is fetch-on-mount with cache discipline on the server.

### 7.5 Theming

`app/globals.css` defines the design system in **OKLCH color space** parameterized by a single CSS custom property `--theme-hue: <angle>`. `ThemeProvider` writes that variable on every active-view change (`viewHuesEnabled ? viewHues[activeViewId] : 250`), and the 1 s CSS transition on `--theme-hue` makes per-dash color shifts smooth. Dark/light is toggled by adding/removing the `light` class on `<html>` and setting `colorScheme`. Light mode has a long `!important` override block because the rest of the app uses Tailwind opacity-on-black/white shorthands that need explicit inverts.

The PWA service worker (`app/sw.ts`, generated to `public/sw.js` via `@serwist/next`) is **disabled in dev** and unregistered defensively by an inline script in `app/layout.tsx` to prevent a stale dev SW from hijacking subsequent loads.

---

## 8. Cross-Cutting Subsystems

### 8.1 In-process logger

`lib/logger.ts` + `instrumentation.ts` install a 500-entry ring buffer on `globalThis` and **monkey-patch** `console.{log,info,warn,error}` and `process.stdout/stderr.write` to push every line into it. `getLogs()` and `subscribeToLogs(listener)` expose synchronous access plus a fan-out for the SSE consumer. The `inConsoleCall` re-entrancy guard prevents double-logging when the patched `console.log` itself writes to stdout.

This design has three notable consequences:

1. **Every `console.*` call from anywhere — including third-party libraries — appears in the in-app log viewer.** This is desired (it's how `[DATABASE]` and `[CACHE]` lines show up without explicit hooks) but it means a noisy dependency could flood the buffer.
2. **The buffer is global to the process, not per-request.** SSE clients see *all* server logs, not just their own. Acceptable for single-user.
3. **The fact that it's a `globalThis` ring buffer means it survives HMR**, so the Internal Systems view doesn't reset its history on every save in dev.

### 8.2 In-process cache

`lib/cache.ts` is the same pattern (a `globalThis` Map) for HTTP responses. `withCache(handler, ttl)` wraps a route handler; the wrapper:

1. Computes a cache key from `pathname + sorted query`, dropping the `v` param (and treating its presence as "force refresh").
2. On hit, returns the cached `NextResponse.json` with `X-Cache: HIT` and TTL-aware `Cache-Control`.
3. On miss, calls the handler. If it succeeds with JSON, the response is cloned, the body is parsed, and stored.
4. On handler **throw** *or* non-OK response: if a stale entry exists, it's served with `X-Cache: STALE-FALLBACK` and re-stored with a 60 s "retry window" so a flapping upstream doesn't get hammered.

This is a deliberately simple cache. There's no LRU eviction, no size cap, no per-key concurrency dedup ("thundering herd" if two clients miss simultaneously). For the single-user case those gaps are fine.

### 8.3 Auth and Google integrations

`lib/auth.ts` configures NextAuth with the Prisma adapter and a single Google provider. The provider asks for `access_type=offline` and the scopes `openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events`. The long-lived **refresh token is stored on the `Account` row** by the Prisma adapter.

`lib/googleapis.ts:getGoogleAuthClient(userId)` rebuilds an OAuth2 client from that refresh token on demand. All server-side Gmail and Calendar code goes through this helper:

- `/api/gmail/webhook` calls it after looking up the user by `emailAddress` from the Pub/Sub envelope.
- `/api/calendar/event` calls it after pulling `userId` from the query string.

Adding a new Google scope requires bumping the `scope` string in `authOptions` and re-consenting — there's no incremental authorization flow.

### 8.4 LLM-driven email parsing

`lib/email-parser.ts:parseApplicationEmail()` calls `generateObject` from `ai` with `google("gemini-3.0-flash")` and a Zod schema (`applicationSchema`). The schema enforces the canonical fields the dashboard needs (`company`, `role?`, `status` ∈ APPLIED/UPDATED/ASSESSMENT/INTERVIEW_REQUESTED/INTERVIEW/OFFER/REJECTED, `nextSteps?`, `extractedDates[]?`). The Gmail webhook only invokes this if the subject contains "application" or "interview" — a cheap heuristic to avoid wasting LLM calls on every inbound email.

This is the **only LLM call in the system**. The author-facing AICompanion is a stub.

---

## 9. Deployment and Operations

### 9.1 Process model

Production runs **three** related processes, each with a distinct scope:

| Process | PM2 name | Owner repo | Scope |
|---|---|---|---|
| Web tier | `mission-control` | this repo | HTTP API, dashboard, SSE event bus, file watcher, OAuth |
| Scheduler | `mission-control-scheduler` | this repo | Non-financial recurring jobs (cache pruning today; weekly paper picks, notification digests, fetcher health rollups planned) |
| Pulsar | `pulsar-*` (per source) | `salsquared/pulsar` | Financial data ingestion only — CoinGecko, Mempool, Yahoo, FRED, ExchangeRate. Mission-control consumes via REST + WS |

**This three-process boundary is intentional and load-bearing.** Pulsar stays narrow — *only* financial fetches. The scheduler exists precisely so mission-control doesn't acquire its own ingestion creep by adding "small" recurring jobs to Pulsar "since it already exists." A grep of `pulsar/` for non-financial concepts (papers, notifications, cache, settings) should return zero matches; a grep of `scheduler/jobs/` for financial concepts (CoinGecko, BTC, ETH, Mempool) should also return zero matches. If either grep produces hits, the boundary is leaking.

- **Dev**: `npm run dev` — `NODE_OPTIONS='--max-old-space-size=2048' next dev -p 4101 --webpack`. Watches the file system; `next.config.ts` excludes `prisma/*.db`, `prisma/*.db-journal`, `public/sw.js`, `public/sw.js.map` from the watcher to prevent reload loops. The scheduler process is **not** started in dev — cache pruning won't run unless you launch `node_modules/.bin/tsx scheduler/index.ts` separately.
- **Prod**: `launch-ms.sh` orchestrates everything:
  1. `nvm use 24` + `cd` into the repo.
  2. `set -a && source .env` so the binary inherits secrets (the script comments note that `next start` doesn't auto-load `.env` like `next dev` does — this caused a real incident, see `todo.md` completed items).
  3. Starts `node_modules/next/dist/bin/next` (not `npm start`) under PM2 named `mission-control`, with `--max-old-space-size=1024`. Going through PM2 directly to the next binary avoids npm leaving an orphaned node process when PM2 deletes it.
  4. Starts `node_modules/.bin/tsx scheduler/index.ts` under PM2 named `mission-control-scheduler`, with `--max-old-space-size=512`. Run via tsx so we don't need a build step or path-alias rewrites; same Prisma client and same `prisma/prod.db` as the web tier.
  5. Polls until the web port binds (IPv4 *or* IPv6) — bound to `localhost:3101` because hardcoding `127.0.0.1` broke Chrome on Node 17+ which prefers IPv6.
  6. Opens `open -n -W -a "Google Chrome" --args --app="$APP_URL"` (Caddy `https://mc.local` if installed, falling back to `http://localhost:$PORT`).
- The Chrome window closing **does not stop the server**. PM2 keeps both processes running; logs accessed via `pm2 logs mission-control` and `pm2 logs mission-control-scheduler`.

Because the scheduler and web tier both write to `prisma/prod.db`, `lib/prisma.ts` applies the SQLite write-concurrency pragmas (`journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`) on every `PrismaClient` instantiation. WAL is persistent in the file header; the others are per-connection. Without WAL, the two writers would race on `SQLITE_BUSY`.

### 9.2 Storage and configuration

- **DB files** in `prisma/` are gitignored. Dev and prod are *separate* files. There is no migration story between the two.
- **`.env` files** are gitignored. Two checked-in stubs (`.env.development`, `.env.production`) only contain `DATABASE_URL`. Real secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.) live in an untracked `.env`.
- **PM2 is not installed by `npm install`** — the `hosting.md` doc walks the user through `npm install -g pm2` and `pm2 startup` + `pm2 save`.

### 9.3 LAN access (planned)

`todo.md` has an open task to "broadcast the server on the local network and make it mobile-compatible." Today the binding is `localhost`, which means LAN access requires either changing the bind address in `launch-ms.sh` or proxying. The PWA + service worker pieces are already in place for the install-as-app flow once the network bind is opened.

### 9.4 Inbound webhook path

Per `todo.md`, the Gmail webhook is intended to be reached via **Cloudflare Tunnels** (`salsquared.xyz`) → Pub/Sub topic. This is the only way an external request gets to a Mac mini behind a residential NAT. Today the route works locally but the tunnel/Pub/Sub topic is an external prerequisite, not something the repo provisions.

---

## 10. Observability

The system has three observability surfaces, all in-process:

1. **`console`-based ring buffer** → `/api/system/logs` SSE → InternalView's "Event Log" panel. Provides ~500 most recent log lines with method/status colorization (`InternalView.tsx:formatLogMessage`). Server logs include request lines from `middleware.ts`, `[DATABASE]` lines from the Prisma `$extends` middleware, `[CACHE HIT|MISS|FALLBACK]` lines from `withCache`, `[EXTERNAL API]` lines from fetchers.
2. **Process telemetry** → `/api/system` polled at 5 s. Reports CPU% (delta over the polling window), RSS in GB vs. the `--max-old-space-size` parsed from `package.json`, uptime, DB connectivity (`SELECT 1`), and cache hit/miss + active entries.
3. **Cache stats** — embedded in (2). Lists active entry keys with remaining TTL. This is the only way to introspect the cache state.

**There is no external observability**: no metric export, no error reporting (Sentry, etc.), no log persistence beyond the ring buffer (lost on restart), no tracing. For a single-user system that's an explicit choice, but it means post-mortem debugging is limited to whatever was on screen.

---

## 11. Security and Threat Model

This is a **personal, LAN-bound** system, but several integration points still warrant attention:

- **Pub/Sub webhook is unauthenticated.** `/api/gmail/webhook` decodes the Pub/Sub envelope and looks up the `User` row by `emailAddress`. Anyone who can reach the endpoint and knows the user's email can synthesize a payload with a fake `historyId`. The endpoint will then call `gmail.users.history.list` against the *real* Gmail account using the stored refresh token, parse the result, and write `Application` rows. The harm is bounded (no data exfil, no token leak) but the endpoint should at minimum verify the `Authorization: Bearer` JWT that Pub/Sub attaches when push auth is enabled. **Recommendation: require Pub/Sub OIDC auth and verify the token before any side effects.**
- **Calendar endpoint trusts client-provided `userId`.** `/api/calendar/event` reads `userId` from query/body; any caller can pass any user id. On a single-user box this is a non-issue, but if LAN access opens up (per the open todo) this becomes a real privilege boundary. **Recommendation: derive `userId` from the NextAuth session, the same as `/api/applications`.**
- **`/api/goals`, `/api/research/saved`, `/api/settings`, `/api/tasks` are all unauthenticated.** Acceptable on `localhost`; not acceptable once exposed to LAN/tunnels.
- **HTML scrapers send a Mac UA and parse with regex.** Scrapers can break or hang on adversarial markup. The `withCache` STALE-FALLBACK behavior insulates the user from breakage but not from latency. Timeouts on `fetch` are not consistently set; OGS calls do set a 4 s timeout.
- **LLM input is uncontrolled email content.** A malicious sender could attempt prompt injection inside an email subject/body to coerce `parseApplicationEmail` into emitting a status it shouldn't. The Zod schema bounds the *shape* of the output but not its semantics; worst case is a wrong DB upsert.
- **Stored OAuth tokens.** Refresh tokens live in `prisma/prod.db` unencrypted. SQLite file permissions are the only defense. Acceptable for a personal Mac; not acceptable for any kind of multi-user deployment.
- **Service worker + `dangerouslySetInnerHTML` in `layout.tsx`** — only runs in dev, contents are static, no user input. Not a real risk but worth noting because it's the only `dangerouslySetInnerHTML` in the codebase.

The general posture is "trust the LAN, distrust nothing else." That's defensible given today's deployment but is brittle against the open todo "broadcast the server on the local network."

---

## 12. Performance Considerations

- **Memory budget is 1 GB in prod, 2 GB in dev.** RSS usage is monitored continuously by InternalView; the budget is what package.json declares, parsed at request time and cached.
- **Prisma query logging is per-request.** Every operation logs `[DATABASE] Executing <op> on <model>`. Cheap but not free; would be the first thing to disable if log volume becomes a problem.
- **The cache is unbounded.** A pathological caller passing arbitrary query strings could grow the in-memory map without limit. In practice the surface area is small (≈ a dozen stable cache keys at steady state).
- **Some endpoints do heavy work on the request path.** `/api/finance` writes a `CryptoPrice` row on every cache miss; `/api/space/launches` paginates LL2 results; HTML scrapers OGS-enrich every result item. The cache is what makes this acceptable.
- **OGS enrichment is sequential per article**, but `Promise.all` parallelizes within a fetch. A single failing OGS call can stall a fetch for the OGS timeout (4 s). That's bounded but visible on cold cache hits.
- **Prisma `$transaction` is used for the task sync** to make the "delete missing + upsert all" atomic. For a few hundred tasks this is fine; for thousands it would be the first place to look for slowness.

---

## 13. Trade-offs and Notable Design Decisions

| Decision | Trade-off |
|---|---|
| **SQLite in-process** | Zero-ops persistence, dual dev/prod files. No replication, no concurrent writers (`Mutex` already exists for the markdown file path). |
| **`docs/todo.md` as task source of truth** | Editing tasks in the editor *or* the UI is supported. PATCH writes the file *first*, bumps `lastSyncedMtime`, then updates the DB. The DB is a derived projection and can be rebuilt from the file at any time. |
| **In-process cache, not Redis** | Simpler, one fewer service. Loses cache on restart (mitigated by `globalThis` survival across HMR). No cross-process sharing — non-issue for single PM2 process. |
| **Monkey-patched `console`** | Every log line in the universe ends up in the in-app viewer for free. Cost: third-party library noise pollutes the feed; you can't have a "raw" `console.log` without it being captured. |
| **No React Query/SWR** | Less code, no extra dependency. Cost: every view manually wires `useEffect` + `fetch`; revalidation is ad hoc; there's no shared cache between two cards that need the same data. |
| **No tests** | Small surface, single user, fast iteration. Cost: regressions go unnoticed until the user hits them. The `scripts/tests/` directory contains *manual* test scripts (per `.agents/rules/scripts.md`), not automated ones. |
| **Webpack instead of Turbopack** | Stable, predictable. The `--webpack` flag is explicit on `next dev`/`next build`. |
| **`reactStrictMode: false`** | No double-mounts in dev. Cost: bugs that strict mode would catch (effect cleanup omissions, unstable identifiers) survive. |
| **Inline custom fetchers in the company registry** | New RSS company is 5 lines, idiosyncratic ones live next to their config. Cost: `company-registry.ts` is 900 lines and growing. |
| **Stub AICompanion** | Ships the surface area of the feature without the spend on LLM calls / persistence. Cost: mismatch between marketing copy ("Systems online. Monitoring all frequencies.") and reality. |
| **Two databases, one schema** | Clean separation between dev and prod data. Cost: no upgrade story, easy to forget which one a script is hitting. |

---

## 14. Risks and Tech Debt

Roughly ordered by severity:

1. **Pub/Sub webhook lacks signature verification.** See §11. Concrete code change: verify the `Authorization` JWT against the configured Pub/Sub push service account before processing.
2. **Calendar endpoint takes `userId` from the client.** See §11. Concrete code change: use `getServerSession` like `/api/applications` does.
3. **`/api/settings` is unauthenticated and global.** A single-row "global" config means *any* caller can rewrite the user's theme, dash order, and feature flags. Fine on localhost; problematic on LAN.
4. **Two `PrismaClient` instances.** `app/api/settings/route.ts` constructs its own `new PrismaClient()` rather than importing `lib/prisma.ts`. This means it bypasses the query-logging extension and risks connection pool exhaustion on hot reload. Concrete fix: import `prisma` from `@/lib/prisma` and delete the local construction.
5. **`/api/finance`'s opportunistic `CryptoPrice` insert** ties data ingestion to user traffic. If no one opens the FinanceView for a day, there is a gap in the time series. The seed scripts exist as a backstop but aren't scheduled. Concrete fix: a small cron-like ingester (or the new `/schedule` slash command) that calls the endpoint hourly.
6. **No automated tests.** `scripts/tests/*` are exploratory tsx scripts. Critical paths — the markdown task parser, the cache wrapper, the company registry dispatch — have no regression coverage.
7. **HTML scrapers rot silently.** When LM Arena or Anthropic redesigns its page, the regex breaks and the cache STALE-FALLBACKs forever (until restart). There is no "this fetcher is now consistently failing" alert.
8. **AICompanion is a stub.** UI promises functionality that doesn't exist; this is the most user-visible mismatch. The Gemini infrastructure already exists (`email-parser.ts`); reusing it for the chat is a small extension.
9. **Cache has no eviction.** A bug or attacker that keeps minting unique query strings will OOM the process before the 1 GB budget is hit.
10. **`scope` migration in NextAuth requires re-consent.** Adding a new Google scope silently breaks the app for the user until they re-sign-in; there's no mid-session prompt.
11. **`reactStrictMode: false`** masks effect-cleanup bugs. The interval+EventSource teardown in InternalView is correct today; nothing enforces it stays correct.
12. **Frontend interferes between sessions** — `todo.md` line 288 records this as an open issue. Two browser tabs editing the same task can cause the optimistic update to flicker / re-fetch unexpectedly. Without tests or per-tab state isolation it will keep recurring.

---

## 15. Where to Extend

Concrete extension points implied by the design — these are the seams the codebase currently exposes:

- **A new dash** → `BASE_DASHES` entry + `getTopic()` mapping + `themeStore.defaultDashTitles`/`viewHues` defaults. `syncAvailableDashes` handles the rest.
- **A new company news source (RSS)** → push a config to `COMPANY_REGISTRY`. No code.
- **A new news strategy** → new module under `lib/fetchers/`, add to the dispatch in `app/api/company-news/route.ts`, extend the `FetchStrategy` union.
- **A new external API endpoint** → route under `app/api/...`, wrap with `withCache` if cacheable, log via `console.info('[EXTERNAL API] ...')` so the SSE viewer picks it up.
- **A new Prisma model** → add to `prisma/schema.prisma`, run `npx prisma migrate dev`, import `prisma` from `@/lib/prisma` (not `new PrismaClient()`).
- **A new scheduled background job** → today there is no scheduler. The `/loop` and `/schedule` slash commands (Claude Code skills) are the de facto scheduling story. The `instrumentation.ts` register hook is also a viable home for a `setInterval`-based ingester.
- **AICompanion productionization** → reuse `@ai-sdk/google` from `email-parser.ts`. Streaming via the AI SDK's `streamText` would integrate cleanly with the existing client-side message state; the API surface (`POST /api/ai/chat` returning a stream) is the obvious next route.
- **Notification surface** (open todo) → there is no in-process scheduler today; the natural place for it is `instrumentation.ts` or a separate PM2 process. Push notifications would need a Web Push subscription stored alongside `User`.

---

## 16. Summary

Mission Control is a **single-host aggregation layer over many noisy external APIs**, presented through a single-page client carousel of "dashes" and persisted in SQLite. Its architecture is shaped by three forces: a tight RAM budget, the unreliability of upstream sources, and the fact that it has exactly one user.

The key invariants that make it work:

- **Stale-while-revalidate everything**: `withCache` makes flaky upstream APIs an internal concern, not a user-facing one.
- **Markdown ↔ DB for tasks**: the user's editor is a first-class write surface alongside the UI; the DB is a projection.
- **Console-as-bus**: every server-side `console.*` becomes an event in the in-app log viewer, no extra plumbing.
- **One source of truth per concern**: `themeStore`/`/api/settings` for cross-device prefs; `localStorage` for per-device prefs; `docs/todo.md` for tasks; `prisma` for everything else.
- **A registry, not a switch statement**: company news is a config table, not a tree of `if (company === ...)`. New sources are config; new shapes are code.

The most material open work is the **Gmail webhook auth gap**, the **stub AICompanion**, and the absence of any **automated tests**. Most other items in §14 are improvements rather than risks; together they describe a system that is comfortably correct for its current single-user, localhost deployment but would need meaningful hardening to face a wider blast radius.

---

## 17. Event State and Lifecycle Management

This section documents the real-time event system and state lifecycle introduced during MVP1. It covers the server-side event bus, the SSE transport, the file-watcher echo loop, the unified client state store, and the stale-data toast pipeline.

---

### 17.1 Overview

The system has **two independent event-driven pipelines** that together keep the UI consistent without polling:

1. **Server event bus → SSE → SWR invalidation** — mutations from any route (or an external Pub/Sub push) are broadcast to all connected SSE clients, which trigger SWR's `mutate()` to refetch from the server.
2. **File watcher → DB sync → broadcast** — edits to `docs/todo.md` in an external editor are detected by a Node `fs.watch`, synced to the DB, and broadcast as a `Task` invalidation event.

```mermaid
graph LR
    subgraph Server
        A["Route PATCH/POST/DELETE"] -->|broadcastEvent| B["lib/events.ts<br/>(globalThis fan-out)"]
        W["fs.watch<br/>(docs/todo.md)"] -->|debounce 500ms| P["syncTasksFromFile<br/>(parser → DB)"]
        P -->|broadcastEvent Task.invalidate| B
        B -->|fan-out to all listeners| SSE["/api/events<br/>SSE stream"]
    end
    subgraph Browser
        SSE -->|EventSource| H["useServerEvents(model)"]
        H -->|"onInvalidate()"| M["SWR mutate()"]
        M -->|refetch| API["/api/..."]
    end
```

---

### 17.2 Server event bus (`lib/events.ts`)

The event bus is a **`globalThis`-backed `Set<EventListener>`**. Using `globalThis` is the same pattern as the logger ring buffer and in-process cache — it means the listener set survives Next.js HMR across hot reloads without losing connected SSE clients.

```typescript
// Shape of every event
interface ServerEvent {
    model: 'Task' | 'Goal' | 'SavedPaper' | 'Application' | 'CalendarEvent' | 'Setting';
    action: 'upsert' | 'delete' | 'invalidate';
    id?: string;        // omitted for 'invalidate' (whole model refresh)
    timestamp: number;
}
```

`broadcastEvent(event)` iterates the set synchronously — it's fire-and-forget. Subscribers that throw will surface as uncaught exceptions; the set is not cleared on error. This is fine given a single-user load.

`subscribeToEvents(listener)` returns an unsubscribe function used by the SSE route to clean up when the client disconnects.

---

### 17.3 SSE endpoint (`/api/events`)

`app/api/events/route.ts` opens a `ReadableStream` and:

1. Immediately enqueues a `: connected` SSE comment so the browser `EventSource` doesn't time out waiting for the first byte.
2. Calls `subscribeToEvents` and enqueues every `ServerEvent` as a `data:` frame carrying the JSON-serialized event.
3. Sets a 30-second `: heartbeat` interval to prevent proxy/load-balancer idle-timeouts from closing the connection.
4. Listens on `req.signal` (AbortSignal) to clear the heartbeat and unsubscribe when the connection closes.

```mermaid
sequenceDiagram
    participant Browser
    participant SSE as /api/events
    participant Bus as lib/events

    Browser->>SSE: GET /api/events
    SSE->>Bus: subscribeToEvents(listener)
    SSE-->>Browser: ": connected"
    loop every 30s
        SSE-->>Browser: ": heartbeat"
    end
    Bus->>SSE: listener(event) [on broadcastEvent]
    SSE-->>Browser: "data: {model,action,id,timestamp}"
    Browser->>SSE: connection close (tab close / nav)
    SSE->>Bus: unsubscribe()
    SSE->>SSE: clearInterval(heartbeat)
```

There is **no reconnection logic on the server** — `EventSource` reconnects automatically (browser default back-off). On reconnect, the `useServerEvents` hook re-opens `EventSource('/api/events')` and the server sends `: connected` again; any mutations that occurred during the gap are not replayed, but SWR's `onFocus` revalidation and the next mutation event will close the gap.

---

### 17.4 Frontend hook (`hooks/useServerEvents.ts`)

```typescript
useServerEvents(model: ServerEventModel, onInvalidate: () => void)
```

The hook opens one `EventSource('/api/events')` per mount, filtered by `model`. It uses a `ref` to hold the latest `onInvalidate` callback so the effect closure never goes stale — the `EventSource` is opened once and the callback can change freely without reopening the stream.

```mermaid
flowchart TD
    Mount["Component mounts"] --> Open["new EventSource('/api/events')"]
    Open --> Listen["es.onmessage → parse JSON"]
    Listen --> Check{event.model<br/>=== model?}
    Check -->|yes| Call["onInvalidateRef.current()"]
    Check -->|no| Discard["ignore"]
    Call --> Mutate["SWR mutate() → refetch"]
    Unmount["Component unmounts"] --> Close["es.close()"]
```

**Current subscribers:**

| View / Component | model | SWR key invalidated |
|---|---|---|
| `PlanningView` | `Task` | `/api/tasks` |
| `PlanningView` | `Goal` | `/api/goals` |
| `ApplicationsView` | `Application` | `/api/applications` |
| `ApplicationsView` | `CalendarEvent` | `/api/applications` (re-fetches both) |
| `SavedPapersOverlay` | `SavedPaper` | papers SWR key |

---

### 17.5 Broadcast sites

Every mutating route calls `broadcastEvent` after a successful DB write:

| Route | Method(s) | Model | Action |
|---|---|---|---|
| `app/api/tasks/route.ts` | PATCH, POST | `Task` | `upsert` |
| `app/api/goals/route.ts` | POST, PATCH, DELETE | `Goal` | `upsert` / `delete` |
| `app/api/research/saved/route.ts` | POST, DELETE | `SavedPaper` | `upsert` / `delete` |
| `app/api/calendar/event/route.ts` | POST, DELETE | `CalendarEvent` | `upsert` / `delete` |
| `app/api/gmail/webhook/route.ts` | POST (Pub/Sub push) | `Application` | `upsert` |
| `lib/tasks/watcher.ts` | fs.watch callback | `Task` | `invalidate` |

`invalidate` (used only by the file watcher) means "something about this model changed — refetch everything." `upsert`/`delete` carry an `id` but the frontend currently treats all three the same way (calls `mutate()`).

---

### 17.6 Task file watcher and echo suppression

The file watcher introduces a **potential write loop**: when the UI mutates a task, the route writes `docs/todo.md`, the watcher fires, and without suppression the watcher would re-sync the file back to the DB and broadcast again.

The echo-suppression flag in `lib/tasks/regenerator.ts` breaks this loop:

```mermaid
sequenceDiagram
    participant UI
    participant Route as /api/tasks PATCH
    participant Regen as regenerator.ts
    participant Watcher as watcher.ts
    participant DB

    UI->>Route: PATCH {id, status}
    Route->>DB: task.update(...)
    Route->>Route: broadcastEvent(Task.upsert)
    Route->>Regen: regenerateMarkdownFromDB()
    Regen->>Regen: suppressNextFileChange() → _suppressNext=true
    Regen->>Regen: fs.writeFile(todo.md, ...)
    Regen-->>Route: done
    Note over Watcher: fs.watch fires (500ms debounce)
    Watcher->>Regen: consumeSuppressFlag()
    Regen-->>Watcher: true (was suppressed)
    Watcher->>Watcher: return early — no DB sync, no broadcast
```

Conversely, when the user edits `docs/todo.md` directly in their editor:

```mermaid
sequenceDiagram
    participant Editor
    participant Watcher as watcher.ts
    participant Parser as tasks/parser
    participant DB
    participant Bus as lib/events

    Editor->>Editor: save todo.md
    Note over Watcher: fs.watch fires (500ms debounce)
    Watcher->>Watcher: consumeSuppressFlag() → false (external edit)
    Watcher->>Parser: syncTasksFromFile(filePath)
    Parser->>DB: upsert tasks
    Watcher->>Bus: broadcastEvent(Task.invalidate)
    Bus->>SSE: fan-out to all listeners
    SSE->>Browser: data: {model:"Task", action:"invalidate"}
    Browser->>Browser: SWR mutate() → refetch /api/tasks
```

The 500 ms debounce in the watcher absorbs rapid successive saves (e.g. a formatter or auto-save bouncing the mtime) and collapses them into a single sync.

---

### 17.7 Unified client state store

The consolidated `useAppStore` (at `components/providers/state/index.ts`) has **three logical slices with different persistence policies**:

```mermaid
graph TD
    subgraph useAppStore["useAppStore (Zustand)"]
        T["theme slice<br/>isDarkMode, viewHues,<br/>viewHuesEnabled, dashOrder,<br/>dashTitles"]
        D["devicePrefs slice<br/>autoResearch,<br/>aiCompanionEnabled"]
        A["activeViewId<br/>viewScreenshots"]
    end

    T -->|"POST /api/settings<br/>(debounced 500ms)"| DB[("GlobalSetting<br/>in SQLite")]
    DB -->|"GET /api/settings<br/>on mount"| T

    D -->|"localStorage<br/>'app-state'"| LS[("localStorage")]
    A -->|"localStorage<br/>'app-state'"| LS

    DB -.->|"cross-device sync<br/>via LAN"| OtherDevice["Other LAN device"]
```

**Persistence policy per field:**

| Field | Persisted where | Rationale |
|---|---|---|
| `isDarkMode`, `viewHues`, `viewHuesEnabled`, `dashOrder`, `dashTitles` | `/api/settings` → SQLite | Cross-device: customizations follow the user across LAN devices |
| `autoResearch`, `aiCompanionEnabled` | `localStorage` under `app-state` | Per-device: background behaviors should only be active on one device at a time |
| `activeViewId`, `viewScreenshots` | `localStorage` under `app-state` | Per-device: each device remembers its own last-viewed dash and its own screenshot cache |
| `defaultDashTitles`, `activeViewId` (in-memory read) | not persisted via Zustand | Derived from `BASE_DASHES`; re-computed on every `syncAvailableDashes` call |

The two legacy files (`themeStore.ts`, `settingsStore.ts`) are now thin re-exports: `export { useThemeStore, useAppStore } from './state'`. They exist only for backward compatibility with existing consumers and will be removed once all callsites are updated to import from `@/components/providers/state`.

---

### 17.8 Settings sync lifecycle (`ThemeProvider`)

`ThemeProvider` owns the **hydration and persistence** of the `theme` slice. It mounts once at the app root (inside `app/layout.tsx`).

```mermaid
sequenceDiagram
    participant Browser
    participant TP as ThemeProvider
    participant Store as useAppStore
    participant API as /api/settings

    Browser->>TP: mount
    TP->>API: GET /api/settings
    API-->>TP: {isDarkMode, viewHues, dashOrder, ...}
    TP->>Store: setState(globalData)
    TP->>TP: setMounted(true)
    Note over TP: Now subscribes to store changes
    Store->>TP: subscribe callback fires on any change
    TP->>TP: diff getSyncableState(prev, next)
    alt changed
        TP->>API: POST /api/settings (debounced 500ms)
    end
    Browser->>Browser: CSS: --theme-hue = viewHues[activeViewId]
```

Key details:
- The subscription only starts **after** `mounted = true` — this prevents the initial `setState(globalData)` hydration call from immediately firing a POST back to the server with the just-loaded data.
- Only the five "cross-device" fields are diffed and synced: `isDarkMode`, `viewHues`, `viewHuesEnabled`, `dashOrder`, `dashTitles`. `activeViewId` and `viewScreenshots` are kept in `localStorage` only and are deliberately excluded from the sync payload.
- The 500 ms debounce collapses rapid bursts (e.g. the user dragging a hue slider) into one network request.

---

### 17.9 Stale-data toast pipeline

When `withCache` serves a cached response after an upstream failure, it sets `X-Cache: STALE-FALLBACK` on the response. The `fetcher` wrapper in `lib/fetcher-client.ts` inspects this header and pushes a warning toast:

```mermaid
graph LR
    SWR["useSWR('/api/...', fetcher)"] --> F["fetcher(url)"]
    F --> Fetch["fetch(url)"]
    Fetch --> Cache["withCache handler"]
    Cache -->|upstream error| SF["X-Cache: STALE-FALLBACK"]
    SF --> F
    F -->|header detected| TS["toastStore.push({type:'warning'})"]
    TS --> TH["ToastHost (bottom-left)"]
    TH --> User["amber toast: 'Stale data: /api/...'"]
    TH -->|5s auto-dismiss| Gone["toast removed"]
```

`toastStore` is a plain class singleton (not Zustand) with a minimal pub/sub pattern. `ToastHost` is mounted once in `app/layout.tsx` and subscribes to it. Toasts auto-dismiss after 5 seconds and can be dismissed early via the × button.

---

### 17.10 Complete event lifecycle: end-to-end example

A user checks off a task in `PlanningView`:

```mermaid
sequenceDiagram
    participant UI as PlanningView
    participant SWR as useSWR (tasks)
    participant Route as PATCH /api/tasks
    participant DB as SQLite
    participant Regen as regenerator.ts
    participant File as docs/todo.md
    participant Watcher as watcher.ts
    participant Bus as lib/events
    participant SSE as /api/events SSE
    participant Hook as useServerEvents('Task')

    UI->>Route: PATCH {id, status: 'DONE'} (optimistic update in UI)
    Route->>DB: task.update({status:'DONE'})
    Route->>Bus: broadcastEvent(Task.upsert, id)
    Route->>Regen: regenerateMarkdownFromDB()
    Regen->>Regen: _suppressNext = true
    Regen->>File: fs.writeFile (line patched: [x])
    Route-->>UI: 200 OK
    Bus->>SSE: fan-out event
    SSE-->>Hook: data: {model:'Task', action:'upsert'}
    Hook->>SWR: mutate() → refetch /api/tasks
    SWR-->>UI: updated task list (now authoritative from DB)
    Note over Watcher: fs.watch fires (500ms later)
    Watcher->>Regen: consumeSuppressFlag() → true
    Watcher->>Watcher: suppressed — exits early
```

The optimistic update in the UI provides instant feedback. The SWR `mutate()` triggered by the SSE event then replaces it with the authoritative DB value, typically within 100–200 ms of the PATCH completing. The file update is a side effect of the DB mutation, not a cause — and the suppress flag ensures the watcher doesn't create a second round-trip.

---

## 18. Glossary

Web-dev and systems terminology used throughout this document. Alphabetical.

- **AbortSignal** — Standard `AbortController.signal` that fires when a request or operation is cancelled. The SSE endpoint listens on `req.signal` to clean up the heartbeat and unsubscribe when the browser closes the connection.

- **Backfill** — Populating a data store with historical records that weren't captured live (e.g., `scripts/seed-crypto.ts`).

- **Broadcast** — Sending one event to multiple subscribers at once. `broadcastEvent` iterates a `Set` of registered listeners and calls each with the event.

- **Debounce** — Collapsing a burst of repeated calls into a single trailing call. Used by the file watcher (500 ms — coalesces rapid editor saves) and by `ThemeProvider`'s settings sync (500 ms — collapses keystroke-rate state changes into one POST).

- **Echo suppression** — A flag set before a programmatic file write so a subsequent file-watch event doesn't loop the change back into the DB. `suppressNextFileChange()` raises it; `consumeSuppressFlag()` reads-and-clears it.

- **Event** — A small, structured payload describing that *something happened*. In mission-control every `ServerEvent` carries `{model, action, id?, timestamp}`. Events are passive notifications: zero or more listeners can react to the same one, and the publisher doesn't know or care who consumes it. Distinct from a **request**, which is a directed call awaiting a response.

- **Event bus** — The pub/sub mechanism that holds the set of listeners and dispatches each published event to all of them. `lib/events.ts` is the in-process event bus: `broadcastEvent` publishes, `subscribeToEvents` registers a listener, and the listener set is hung off `globalThis` so it survives HMR.

- **EventSource** — Browser API for consuming Server-Sent Events. Auto-reconnects on disconnect; one-way (server → client).

- **Fan-out** — Distributing one input to many outputs. The event bus fans one `broadcastEvent` call out to every connected SSE client.

- **Fetcher** — In SWR, the function that turns a cache key (URL) into data. `lib/fetcher-client.ts` exports the project's standard fetcher, which inspects `X-Cache` headers and surfaces stale-fallback toasts.

- **globalThis** — Standard global-object reference shared across Node, browsers, and workers. Used here to attach state (cache, logger, event bus) that must survive Hot Module Replacement.

- **Heartbeat** — A periodic no-op message on a long-lived connection to defeat idle-timeouts. The SSE endpoint sends `: heartbeat` every 30 s.

- **HMR (Hot Module Replacement)** — Next.js's dev-mode mechanism that swaps individual modules without a full page reload. Module-level state is recreated on each swap, so anything that needs persistence in dev attaches to `globalThis`.

- **Hydration** — Initial syncing of client state from a server source. `ThemeProvider` hydrates the `theme` slice by GET-ing `/api/settings` on mount, then sets `mounted=true` and starts subscribing to changes.

- **In-flight dedup** — Server-side de-duplication of concurrent identical requests. Two callers that miss the same cache key share one upstream fetch instead of stampeding the source (Task 6C).

- **Invalidate** — Mark cached or derived state as stale so it gets refetched. The `Task.invalidate` event from the file watcher tells SWR to refetch `/api/tasks` wholesale rather than carrying a specific id.

- **Listener** — A callback registered with a pub/sub bus. `subscribeToEvents(fn)` adds `fn` to the `__EVENT_LISTENERS` set on `globalThis`.

- **LL2 (Launch Library 2)** — The Space Devs' rocket-launch metadata API consumed by `/api/space/launches`.

- **LRU (Least Recently Used)** — A common cache-eviction policy. `withCache` does *not* implement LRU — it has no eviction at all (see §14).

- **Middleware** — Next.js's request interceptor running before route handlers. Mission Control's only does request logging, scoped by the `matcher` to `/api/*`. (In Next 16 the file is `proxy.ts`.)

- **Migration** — A versioned schema change. Prisma migrations are SQL files under `prisma/migrations/`, applied with `prisma migrate dev` (writes) or `prisma migrate deploy` (prod).

- **Model** — In the event bus, an enum tag (`Task` | `Goal` | `SavedPaper` | `Application` | `CalendarEvent` | `Setting`) identifying which Prisma table the event pertains to. Subscribers filter by model so each view only refetches when its data changed.

- **Module** — A single source file with its own `import` / `export` graph. Webpack bundles modules into the running app; under HMR, an edited module is re-evaluated in place rather than triggering a full restart of the Node process.

- **Module-level state** — Variables declared at the top of a module file (outside any function or class). They live for the lifetime of *that module instance* — which under HMR means until the next time the module is hot-replaced, at which point the new copy starts with fresh values. Anything that must outlive an HMR swap (cache, logger ring buffer, event-bus listener set) is therefore attached to `globalThis` instead of held as module-level state.

- **Monkey-patching** — Replacing a method on an object at runtime to add behavior. `lib/logger.ts` monkey-patches `console.log/info/warn/error` so every log line lands in the in-app log buffer for free.

- **Mutate / Mutation** — A write operation (POST/PATCH/DELETE) that changes server state. In SWR, `mutate()` is also the client-side function that invalidates a cache key and triggers a refetch.

- **Mutex** — A lock that serializes access to a shared resource. The `docs/todo.md` writer uses an in-memory `Mutex` so concurrent PATCHes don't interleave their writes.

- **NextAuth** — Authentication library for Next.js. Handles OAuth flows, session cookies, and DB persistence via the Prisma adapter.

- **OAuth2 / OIDC** — Delegated-authorization protocol (OAuth2) plus an identity layer on top (OpenID Connect). The user authorizes Google on Google's site; Google issues tokens that mission-control uses on the user's behalf.

- **Offline access** — `access_type=offline` in the OAuth request. Asks Google for a long-lived **refresh token** so the server can mint new short-lived access tokens without the user being present.

- **OGS (open-graph-scraper)** — npm package that fetches a URL and parses its `<meta property="og:*">` tags. Used to enrich news/research items with hero images and titles.

- **Operation** — In the context of Prisma's `$allOperations` extension, the verb being executed against a table: `findMany`, `findUnique`, `create`, `update`, `upsert`, `delete`, `$transaction`, etc. Every operation produces a `[DATABASE] Executing <op> on <model>` log line, which is how DB activity surfaces in the in-app log viewer.

- **Optimistic UI / optimistic update** — Updating the UI before the server confirms a mutation, on the assumption it will succeed. Reverted on error. PlanningView's task checkboxes do this; the SSE-triggered `mutate()` then replaces the optimistic value with the authoritative one.

- **Pub/Sub** — Publish/subscribe pattern: publishers emit events without knowing who consumes them; subscribers register interest. Both `lib/events.ts` (in-process) and Google Cloud Pub/Sub (Gmail webhook) follow this pattern.

- **PM2** — Node.js process manager. Keeps the production server alive across crashes and reboots; logs accessed via `pm2 logs mission-control`.

- **Prisma** — TypeScript ORM. Generates a typed client from `schema.prisma` that mission-control uses for all DB access.

- **Projection** — A read model derived from another source of truth. The `Task` table is a projection of `docs/todo.md`; the markdown is canonical and the table is rebuildable from it.

- **PWA (Progressive Web App)** — A web app installable to the home screen with offline support via a service worker. Configured here via `@serwist/next`.

- **ReadableStream** — Web standard for incremental response bodies. The SSE endpoint constructs one whose `start(controller)` enqueues bytes as events arrive.

- **Ref (React)** — A mutable container that doesn't cause re-renders when its `.current` changes. `useServerEvents` uses a ref to hold the latest `onInvalidate` callback so the EventSource effect doesn't reopen on every render.

- **Refresh token** — Long-lived OAuth credential used to mint new short-lived **access tokens**. Stored on the `Account` row by NextAuth's Prisma adapter.

- **Request** — An inbound HTTP call to a Next.js route handler under `app/api/*`. Each request is logged once by `middleware.ts` (now `proxy.ts` in Next 16), keyed by `pathname + sorted query` inside `withCache`, and — on protected routes — gated by `requireSession` before reaching the handler. Distinct from an **event**, which is a passive notification with no caller awaiting a response.

- **Ring buffer** — A fixed-size circular buffer; new entries push out the oldest. The logger keeps the most recent 500 lines this way.

- **Scope (OAuth)** — A capability requested at consent time (e.g., `gmail.readonly`). Adding a new scope requires re-consenting.

- **Service worker** — A browser-managed background script that intercepts network requests for offline support and caching. Disabled in dev to avoid stale-cache reload loops.

- **Slice (state)** — A logical grouping of fields and actions inside a single store. `useAppStore` has three slices: `theme` (synced to API), `devicePrefs` (localStorage), and ephemeral UI fields.

- **SNAPI (Spaceflight News API)** — Third-party feed of space-industry press. Used as a fallback for prime contractors and agencies that don't publish their own RSS.

- **SSE (Server-Sent Events)** — A simple server→client streaming protocol over HTTP. The server keeps the connection open and pushes `data:` frames and `:` comment frames separated by blank lines. One-way and lighter than WebSockets; the browser surfaces it as `EventSource`.

- **Stale-fallback** — Mission Control's term for serving the last successful cached response when an upstream fetch fails. Marked on the response by `X-Cache: STALE-FALLBACK`.

- **Stale-while-revalidate** — Cache directive (and pattern) that serves stale data immediately while triggering an async refresh in the background. The library `SWR` is named after it.

- **Subscribe / Subscription** — Registering interest in events. On the server, `subscribeToEvents(fn)` adds a listener to the in-process bus. On the client, `useServerEvents(model, cb)` subscribes to the SSE stream and filters by model.

- **SWR** — Frontend data-fetching library named after the stale-while-revalidate cache directive. `useSWR(key, fetcher)` returns `{data, mutate}` and dedupes concurrent requests for the same key across components.

- **Thundering herd** — Many concurrent callers all missing the same cache key and stampeding the upstream simultaneously. Mitigated by in-flight dedup.

- **Transaction** — An atomic group of DB writes that succeed or fail together. The task sync uses `prisma.$transaction` to make "delete missing + upsert all" atomic.

- **TTL (Time To Live)** — How long a cache entry is considered fresh before it's treated as expired. `withCache` accepts a TTL in seconds.

- **Webhook** — An HTTP endpoint that accepts pushes from an external service. `/api/gmail/webhook` is the Pub/Sub push target.

- **WebSocket** — Bidirectional persistent connection over HTTP. Pulsar uses one for `/ws/prices`; mission-control currently does not.

- **Zod** — Runtime schema-validation library. `lib/schemas/*` defines Zod schemas that route handlers use to reject malformed payloads (Task 6A).

- **Zustand** — Minimal React state-management library. `useAppStore` is a Zustand store; consumers subscribe to specific slices and only re-render when those slices change.
