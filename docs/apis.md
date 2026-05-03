# API Documentation

This document keeps track of the internal API routes created for the Mission Control application, as well as the external APIs those routes consume.

## Cross-cutting concerns

Read this section first — most routes share a small set of behaviors that aren't repeated in every entry below.

- **Caching (`lib/cache.ts`).** Read-heavy GET routes are wrapped in `withCache(handler, { ttlSeconds, upstreamHost })`. The cache key is `pathname + sorted query` (the `?v=...` cache-buster is stripped before keying and forces a refresh). On handler error or non-OK response, the wrapper falls back to the last good payload and rewrites the entry with a 60s retry TTL. `upstreamHost` (string or `(req) => string | null`) is included in `[CACHE HIT/MISS/FALLBACK]` log lines so the **Internal Systems** dash's "Fetcher Health" card can group activity by real upstream host instead of by route path. Stats are surfaced via `GET /api/system`.
- **Auth guards (`lib/auth-guards.ts`).** Three patterns are used:
  - `requireSession()` — must have a valid NextAuth session. Returns 401 otherwise.
  - `requireLocalOrigin(req)` — host header must be in `{localhost, 127.0.0.1, 0.0.0.0, mc.local}`. Returns 403 otherwise. Currently no callers — replaced everywhere by `requireLocalOrSession`.
  - `requireLocalOrSession(req)` — LAN traffic skips auth (trusted network); anything reaching the server through a public hostname (e.g. the Cloudflare tunnel `ms-dev.salsquared.xyz` / `ms-prod.salsquared.xyz`) must present a valid NextAuth session. Returns 401 otherwise.
- **Realtime invalidation (`lib/events.ts`).** Mutating routes call `broadcastEvent({ model, action, id, timestamp })` after the DB commit. Connected clients listening on `GET /api/events` receive the event over SSE and can refetch the affected resource. Models: `Task | Goal | SavedPaper | Application | CalendarEvent | Setting`. Actions: `upsert | delete | invalidate`.
- **Logging.** Server-side `console.{log,info,warn,error}` is captured by an in-memory ring buffer (`lib/logger.ts`) plus tee'd to PM2's stdout. Live tail via `GET /api/system/logs`; history via `GET /api/system/logs/historical`.

## Internal API Routes

These are the Next.js API routes defined in our application (`/app/api/...`), what they do, and the external data they fetch.

### Auth

#### NextAuth Handler
- **Route:** `GET|POST /api/auth/[...nextauth]`
- **Purpose:** Standard NextAuth.js handler. Single Google provider with `access_type=offline` plus the **Gmail readonly + send** and **Calendar events** scopes. Uses `prompt=select_account` so the Google account picker always appears (instead of silently re-selecting the current Chrome profile's default account). Refresh tokens are stored on the `Account` row by `PrismaAdapter`. Session callback attaches `user.id` onto `session.user` so route handlers can pass it directly to `getGoogleAuthClient(userId)`.
- **External APIs Used:** Google OAuth 2.0 (`accounts.google.com/o/oauth2/v2/auth`).

### Realtime / Events

#### Server Event Stream
- **Route:** `GET /api/events`
- **Purpose:** SSE channel that broadcasts `{ model, action, id, timestamp }` events whenever a mutating route writes to the DB. Connected clients invalidate/refetch on receipt. This is the mechanism that keeps multiple browser tabs / a phone + the Mac mini in sync (replacement for the old polling-only model).
- **Response Format:** Event Stream / SSE (`text/event-stream`); 30s heartbeats.
- **Event Schema:**
  ```typescript
  {
    model: 'Task' | 'Goal' | 'SavedPaper' | 'Application' | 'CalendarEvent' | 'Setting';
    action: 'upsert' | 'delete' | 'invalidate';
    id?: string;
    timestamp: number; // Date.now()
  }
  ```

### Planning Dashboard

#### Tasks
- **Route:** `GET|POST|PATCH /api/tasks`
- **Purpose:** Reads/writes the user's task list. The DB is the source of truth (`Task` table); `docs/todo.md` is a derived view regenerated asynchronously on every mutation by `regenerateMarkdownFromDB()`. External edits to `docs/todo.md` are picked up by the file watcher started in `instrumentation.ts` and synced back via `syncTasksFromFile()`. Mutations broadcast `{ model: 'Task', action: 'upsert' }` over `/api/events`. PATCH/POST are serialized through an in-memory `Mutex`. Both PATCH and POST return 503 while `restart-guard` indicates the server is restarting.
- **Auth:** `requireLocalOrSession`.
- **Query Parameters (GET):** `?force=true` to force a re-parse from the markdown file before returning DB rows.
- **Request Body (PATCH):** validated by `TaskPatchSchema` (`lib/schemas/tasks.ts`)
  ```typescript
  { id: string; status?: TaskStatus; text?: string; dueDate?: string|null; priority?: Priority }
  ```
- **Request Body (POST):** validated by `TaskPostSchema`
  ```typescript
  { text: string; parentId?: string; isGoal?: boolean }
  ```
  When `isGoal` is true, a child task ("Define action items for this goal") is auto-created.
- **Response Schema (GET):** `{ tasks: Task[] }` mapping to the `Task` Prisma model.

#### Life Goals
- **Route:** `GET|POST|PATCH|DELETE /api/goals`
- **Purpose:** CRUD for `LifeGoal` rows. Each mutation broadcasts `{ model: 'Goal', action: 'upsert'|'delete' }`.
- **Auth:** `requireLocalOrSession`.
- **External APIs Used:** None (Database only).
- **Request Body (POST):** `{ text: string; estimatedTime?: string }`
- **Request Body (PATCH):** `{ id: string; completed: boolean }`
- **Request Body (DELETE):** `{ id: string }`
- **Response Schema:** Returns `{ goal }` (single) or `{ goals }` (list) mapping to the `LifeGoal` Prisma model.

#### Calendar Event
- **Route:** `GET|POST|DELETE /api/calendar/event`
- **Purpose:** Read upcoming events, create/update an event, or delete an event on the user's primary Google Calendar. The user id is derived from the session (no client-supplied `userId` param). Mutations broadcast `{ model: 'CalendarEvent', action: 'upsert'|'delete' }`.
- **Auth:** `requireSession` (always authenticated, no LAN bypass — touches Google APIs under the user's tokens).
- **External API Used:** Google Calendar API v3 (`google.calendar({ version: "v3" })` via `getGoogleAuthClient(userId)`).
- **Query Parameters (GET):** `?query=[term]` (free-text filter).
- **Query Parameters (DELETE):** `?eventId=[id]`.
- **Request Body (POST):** validated by `CalendarEventPostSchema`
  ```typescript
  { eventId?: string; summary: string; description?: string; start: string /* ISO */; end: string /* ISO */ }
  ```
  When `eventId` is present the event is updated; otherwise a new event is inserted. All times treated as UTC.

#### Applications (Job Tracker)
- **Route:** `GET /api/applications`
- **Purpose:** Returns the current user's job applications, ordered by most recently updated. Rows are inserted/updated by the Gmail webhook when an inbox message classifies as application/interview correspondence.
- **Auth:** `getServerSession` inline (returns 401 if no session, 404 if no matching User row).
- **External APIs Used:** None (Database only).
- **Response Schema:** `{ applications: Application[] }` mapping to the `Application` Prisma model.

### Settings

#### Global Settings
- **Route:** `GET|POST /api/settings`
- **Purpose:** Reads/writes the single-row `GlobalSetting` table that backs `themeStore` (dark mode, viewHues, dashOrder, dashTitles) and other cross-device prefs. Reads run the row through `parseGlobalSetting()` (versioned envelope decoder); writes go through `serializeGlobalSetting()`.
- **Auth:** `requireLocalOrSession`.
- **External APIs Used:** None (Database only).
- **Response Schema (GET):** `{ data: GlobalSettings | null }` (null if no row exists yet).
- **Request Body (POST):** the GlobalSettings object; `id: 'global'` is added server-side via upsert.

### Gmail Integration

#### Gmail Pub/Sub Webhook
- **Route:** `POST /api/gmail/webhook`
- **Purpose:** Endpoint that Google Pub/Sub pushes Gmail history notifications to. For each new message, fetches the body via Gmail API; if the subject contains "application" or "interview", runs the body through `parseApplicationEmail()` (Gemini) and upserts an `Application` row keyed by company-name fuzzy match. Broadcasts `{ model: 'Application', action: 'upsert' }`.
- **Auth:** Shared-secret check — request must include `Authorization: Bearer <PUBSUB_WEBHOOK_SECRET>` (env var). Returns 401 otherwise. Set the same secret on the Pub/Sub push subscription's HTTP headers.
- **External APIs Used:** Gmail API v1 (`users.history.list`, `users.messages.get`); Gemini via `lib/email-parser.ts`.
- **Request Body:** Pub/Sub envelope, validated by `PubSubEnvelopeSchema`. The base64-decoded inner payload is validated by `PubSubPayloadSchema` and contains `{ emailAddress, historyId }`.

### AI Dashboard

#### AI News
- **Route:** `GET /api/ai`
- **Internal Cache:** 1 hour TTL. `upstreamHost: 'hn.algolia.com'`.
- **Purpose:** Fetches the latest stories related to "Artificial Intelligence" or "AI".
- **External API Used:** Hacker News Algolia API
  - Endpoint: `https://hn.algolia.com/api/v1/search_by_date?query="Artificial Intelligence" OR "AI"&tags=story&hitsPerPage=${MAX_NEWS_ARTICLES}` (default `MAX_NEWS_ARTICLES = 10`, see `lib/constants.ts`).
- **Response Schema:**
  ```typescript
  Array<{
    id: string;             // Hacker News Object ID
    title: string;          // Story Title
    url: string;            // External URL or fallback https://news.ycombinator.com/item?id=...
    source: "Hacker News";
    publishedAt: string;    // ISO Date String
    author: string;         // Author Username
  }>
  ```

#### Research Papers (Recent)
- **Route:** `GET /api/research?topic=[topic]&timeframe=[timeframe]&limit=[limit]&type=[type]`
- **Internal Cache:** 1 hour TTL. `upstreamHost: 'huggingface.co'` (primary; arXiv + Semantic Scholar are secondary enrichment paths).
- **Purpose:** Fetches recent research papers for a given topic ('ai', 'crypto', 'space'). Default timeframe is 'yesterday'. For the 'ai' topic, it first uses the Hugging Face Daily Papers API. For other topics or older timeframes, it falls back to the arXiv API. It enriches all papers with citation counts using the Semantic Scholar API.
- **External APIs Used:**
  - Hugging Face Daily Papers API: `https://huggingface.co/api/daily_papers`
  - arXiv API: `http://export.arxiv.org/api/query`
  - Semantic Scholar API (for enrichment): `https://api.semanticscholar.org/graph/v1/paper/batch`
- **Response Schema:**
  ```typescript
  Array<{
    id: string;
    title: string;
    summary: string;
    url: string;
    author: string;
    published_at: string;
    source: string;              // e.g., "Hugging Face Daily Papers" or "arXiv"
    arxivId: string;
    upvotes?: number;            // Only for Hugging Face source
    citationCount?: number;      // Fetched from Semantic Scholar
  }>
  ```

#### Historical Research Paper of the Week
- **Route:** `GET /api/research/historical?topic=[topic]`
- **Internal Cache:** 1 hour TTL. `upstreamHost: 'export.arxiv.org'`.
- **Purpose:** Selects and fetches one historical research paper (published 1 to 5 years ago) per week for a specific topic, circumventing duplicates. Assigned papers are locked in the database (`SelectedHistoricalPaper` table) for weekly persistence. Also enriches with the Semantic Scholar API.
- **External APIs Used:**
  - arXiv API: `http://export.arxiv.org/api/query`
  - Semantic Scholar API: `https://api.semanticscholar.org/graph/v1/paper/batch`
- **Response Schema:**
  ```typescript
  Array<{
    id: string;
    title: string;
    summary: string;
    url: string;
    author: string;
    published_at: string;
    source: string;              // "ArXiv Historical Selection"
    arxivId: string;
    citationCount?: number;      // Fetched from Semantic Scholar
  }>
  ```

#### Weekly Recommended Review Paper
- **Route:** `GET /api/research/review?topic=[topic]`
- **Internal Cache:** 1 hour TTL. `upstreamHost: 'export.arxiv.org'`.
- **Purpose:** Picks and features one review or survey research paper (from last 365 days) weekly for a specific topic. Ensures zero duplication by storing tracked IDs in the local database (`SelectedReviewPaper` table). Enriches with the Semantic Scholar API.
- **External APIs Used:**
  - arXiv API: `http://export.arxiv.org/api/query`
  - Semantic Scholar API: `https://api.semanticscholar.org/graph/v1/paper/batch`
- **Response Schema:**
  ```typescript
  Array<{
    id: string;
    title: string;
    summary: string;
    url: string;
    author: string;
    published_at: string;
    source: string;              // "Weekly Recommended Review"
    arxivId: string;
    citationCount?: number;      // Fetched from Semantic Scholar
  }>
  ```

#### Hugging Face Daily Papers (Direct Fetch)
- **Route:** `GET /api/research/hf?limit=[limit]`
- **Internal Cache:** 1 hour TTL. `upstreamHost: 'huggingface.co'`.
- **Purpose:** Fetches daily papers directly from the Hugging Face API without additional arXiv fallback or Semantic Scholar enrichment.
- **External API Used:** Hugging Face Daily Papers API
  - Endpoint: `https://huggingface.co/api/daily_papers`
- **Response Schema:**
  ```typescript
  Array<{
    id: string;                  // e.g. "2602.16729"
    title: string;
    summary: string;
    url: string;                 // URL to arxiv abs view
    author: string;
    published_at: string;        // ISO Date String
    source: "Hugging Face Daily Papers";
    upvotes: number;
  }>
  ```

#### Import Research Paper
- **Route:** `POST /api/research/import`
- **Purpose:** Imports a specific research paper by passing an ArXiv ID, DOI, or generic URL. Fetches comprehensive metadata by first trying Semantic Scholar and falling back to arXiv.
- **External APIs Used:**
  - Semantic Scholar API: `https://api.semanticscholar.org/graph/v1/paper/[id]`
  - arXiv API (Fallback): `http://export.arxiv.org/api/query?id_list=[id]`
- **Request Body Payload:** validated by `ResearchImportSchema`
  ```typescript
  { input: string; // DOI, ArXiv ID, or URL
  }
  ```
- **Response Schema:**
  ```typescript
  {
    id: string;                  // Semantic Scholar paperId or arXiv raw ID
    title: string;
    summary: string;             // Abstract
    url: string;
    author: string;
    published_at: string;
    source: string;              // "Semantic Scholar" or "arXiv"
    paperId: string;             // Cleaned ID used for tracking
    citationCount: number;
  }
  ```

#### Saved Research Papers
- **Route:** `GET|POST|DELETE /api/research/saved`
- **Purpose:** Manages the user's saved research library, including tracking read status and topics. Retrieves, upserts, or deletes tracked papers from the local database (`SavedPaper` table). Mutations broadcast `{ model: 'SavedPaper', action: 'upsert'|'delete' }`.
- **Auth:** `requireLocalOrSession`.
- **External APIs Used:** None (Database only).
- **Query Parameters (GET):** `?topic=[topic]&status=[status]`
- **Query Parameters (DELETE):** `?paperId=[paperId]`
- **Request Body Payload (POST):**
  ```typescript
  {
    paperId: string;
    title: string;
    summary: string;
    url: string;
    authors: string;
    publishedAt: string | Date;
    topic: string;
    status: string;              // e.g., "READ", "READ_LATER", "FAVORITE"
  }
  ```
- **Response Schema:** Returns database objects mapping to the `SavedPaper` Prisma model.

#### LLM Leaderboard
- **Route:** `GET /api/ai/llmleaderboard?category=[category]`
- **Internal Cache:** 1 hour TTL.
- **Purpose:** Fetches and parses the latest LLM Arena leaderboard for the specified category (default: "text"). Returns the top 50 models sorted by Elo score.
- **External API Used:** LM Arena Leaderboard HTML Parsing
  - Endpoint: `https://lmarena.ai/leaderboard/[category]`
- **Response Schema:**
  ```typescript
  Array<{
    id: string;
    rank: number;
    name: string;
    orgName: string;
    orgLogo: string;             // SVG HTML string
    eloScore: number;
    votes: number;
  }>
  ```

#### Company News
- **Route:** `GET /api/company-news?company=[company]&rss=[url]&title=[title]&list=true`
- **Internal Cache:** 1 hour TTL. `upstreamHost` is derived per-request from `lib/company-registry.ts:getCompanyUpstreamHost()` based on the `?company=` value (or from `?rss=` for the legacy generic-RSS path).
- **Purpose:** Fetches the latest news articles from the company registered in `lib/company-registry.ts` (currently ~40 entries spanning AI and space). The registry declares one of several **strategies** per company; the route dispatches to the matching fetcher in `lib/fetchers/`:
  - `rss` → `lib/fetchers/rss-fetcher.ts`
  - `scrape` → `lib/fetchers/scrape-fetcher.ts` (regex over HTML)
  - `snapi` → `lib/fetchers/snapi-fetcher.ts` (Spaceflight News API)
  - `google-news` → `lib/fetchers/google-news-fetcher.ts`
  - `json-api` → generic `fetch` + optional `apiTransform`
  - `custom` → an inline function in `company-registry.ts` (e.g. SpaceX's official JSON API, OpenAI's RSS-with-Microlink-image-fallback, Groq's dual-page scrape)

  The `?rss=[url]` legacy path bypasses the registry and pulls a single arbitrary RSS feed.
- **External APIs Used:** varies by company (RSS feeds, scraped HTML, Spaceflight News API, Google News RSS, vendor JSON APIs); image-enrichment fallback via Microlink (`https://api.microlink.io`) and Open Graph Scraper.
- **Response Schema:**
  ```typescript
  Array<{
    id: string;                  // Unique identifier or link
    title: string;
    url: string;
    source: string;              // Company name
    published_at: string;        // ISO Date String
    image_url: string;
    news_site: string;           // Site name
  }>
  ```
- **Article cap:** `MAX_NEWS_ARTICLES` (default 10) per company response.

### Finance Dashboard

> **Note:** Finance routes no longer call CoinGecko / Mempool.space directly. Mission Control reads from a local **Pulsar** ingestion service (set `PULSAR_URL` in env, e.g. `http://localhost:4103`). Pulsar is a separate process — see the personal repo `Pulsar` for the upstream ingestion / aggregation logic. From mission-control's perspective Pulsar is *the* upstream; cache logs tag it with whatever hostname `PULSAR_URL` resolves to (typically `localhost`).

#### Finance Data
- **Route:** `GET /api/finance`
- **Internal Cache:** 5 minutes TTL. `upstreamHost` derived from `PULSAR_URL` at request time.
- **Purpose:** Fetches latest crypto prices and the top-100 list (filtered for known spam/stable/RWA tokens via `SPAM_COIN_IDS` and BTC fee-tier ids in `BTC_FEE_IDS`), plus current Bitcoin recommended fees (fastest, half-hour, economy) sourced from Pulsar's mempool aggregator.
- **External API Used:** Pulsar (`PULSAR_URL`)
  - `${PULSAR_URL}/api/prices/latest?class=CRYPTO`
  - `${PULSAR_URL}/api/prices/btc-fee-fast`
  - `${PULSAR_URL}/api/prices/btc-fee-30min`
  - `${PULSAR_URL}/api/prices/btc-fee-eco`
- **Response Schema:**
  ```typescript
  {
    top100: Array<{
      id: string;
      name: string;
      symbol: string;
      marketCapRank: number;
      image: string;
      currentPrice: number;
      priceChange24h: number;
      marketCap: number;
    }>;
    prices: Record<string, { usd: number; usd_24h_change?: number }>; // keyed by coin id
    fees: { fastestFee?: number; halfHourFee?: number; economyFee?: number };
    timestamp: number; // Date.now()
  }
  ```

#### Finance History (Chart Data)
- **Route:** `GET /api/finance/history?coin=[coinId]&range=[days|"max"]`
- **Internal Cache:** 5 minutes TTL. `upstreamHost` derived from `PULSAR_URL`.
- **Purpose:** Retrieves historical price series for a coin. Short ranges (≤30 days) use hourly OHLCV bars from `/api/history/:id?interval=1h`; longer ranges or `range=max` use pre-aggregated daily summaries from `/api/history/:id/summary?from=...`, then downsampled to ~500 points client-side-friendly.
- **External API Used:** Pulsar (`PULSAR_URL`)
  - Short-range: `${PULSAR_URL}/api/history/${coin}?from=...&to=...&interval=1h`
  - Long-range: `${PULSAR_URL}/api/history/${coin}/summary?from=...`
- **Response Schema:**
  ```typescript
  {
    history: Array<{
      time: number;  // Timestamp in ms
      price: number; // Closing price
    }>
  }
  ```

### Space Dashboard

#### Space News
- **Route:** `GET /api/space`
- **Internal Cache:** 1 hour TTL. `upstreamHost: 'api.spaceflightnewsapi.net'`.
- **Purpose:** Retrieves the latest articles related to spaceflight and exploration.
- **External API Used:** Spaceflight News API (SNAPI)
  - Endpoint: `https://api.spaceflightnewsapi.net/v4/articles/?limit=100`
- **Response Schema:**
  ```typescript
  Array<{
    id: number;
    title: string;
    url: string;
    image_url: string;
    news_site: string;
    // ...other raw SNAPI fields
  }>
  ```

#### Rocket Launches
- **Route:** `GET /api/space/launches`
- **Internal Cache:** 30 minutes TTL. `upstreamHost: 'll.thespacedevs.com'`.
- **Purpose:** Fetches information about the next upcoming rocket launches worldwide (default), or a `net__gte`/`net__lte` window when those query params are passed.
- **External API Used:** The Space Devs Launch Library 2
  - Default: `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=102`
  - Windowed: `https://ll.thespacedevs.com/2.2.0/launch/?limit=100&net__gte=...&net__lte=...`
- **Response Schema:**
  ```typescript
  Array<{
    id: string;
    name: string;
    net: string; // ISO String Date
    status: { id: number; name: string; abbrev: string };
    launch_service_provider?: { name: string };
    pad?: { name: string; location: { name: string } };
    image: string;
    // ...other raw LL2 fields
  }>
  ```

#### Solar Activity
- **Route:** `GET /api/space/solar`
- **Internal Cache:** 5 minutes TTL. `upstreamHost: 'services.swpc.noaa.gov'`.
- **Purpose:** Fetches current solar activity (X-Ray flux from GOES primary).
- **External API Used:** NOAA Space Weather Prediction Center (SWPC)
  - Endpoint: `https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json`
- **Response Schema:**
  ```typescript
  {
    status: string;     // e.g. "Normal"
    xray_flux: string;  // e.g. "A4.2"
    updated_at: string; // ISO String
  }
  ```

#### Satellites
- **Route:** `GET /api/space/satellites`
- **Internal Cache:** 2 hours TTL (matches Celestrak's GROUP=active refresh cadence). `upstreamHost: 'celestrak.org'`.
- **Purpose:** Retrieves information and active counts for all currently active satellites in Earth-centric orbits, categorizing them by orbit type (LEO, MEO, GEO, SSO) and notable sub-categories (Starlink, OneWeb).
- **External API Used:** Celestrak GP Data
  - Endpoint: `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json`
  - Note: Celestrak returns 403 with body "GP data has not updated since your last successful download…" when re-requesting unchanged data; the route throws so `withCache` serves the stale entry instead of a 500.
- **Response Schema:**
  ```typescript
  {
    total_active: number;       // e.g. 9000+
    orbits: {
      LEO: number;
      MEO: number;
      GEO: number;
      SSO: number;
      other: number;
    };
    constellations: {
      starlink: number;
      oneweb: number;
    };
    updated_at: string;         // ISO String
  }
  ```

#### Moon
- **Route:** `GET /api/space/moon`
- **Internal Cache:** 24 hours TTL. **No `upstreamHost`** — pure local computation, intentionally absent from the Fetcher Health card.
- **Purpose:** Provides a weekly calendar of the moon's cycles and highlights upcoming global lunar phenomena (supermoons, lunar eclipses).
- **External API Used:** None (algorithmic phase calculation + hardcoded `LUNAR_PHENOMENA` table).
- **Response Schema:**
  ```typescript
  {
    weekly_cycles: Array<{
      date: string;         // ISO String Date
      phase: string;        // e.g., "Full Moon", "First Quarter"
      illumination: number; // e.g., 98.4 (percentage)
    }>;
    next_phenomenon: {
      type: string;         // e.g., "Total Lunar Eclipse" or "Supermoon"
      date: string;         // ISO String Date
      description: string;
    };
    updated_at: string;     // ISO String Date
  }
  ```

### Internal Systems Dashboard

#### System Telemetry
- **Route:** `GET /api/system`
- **Purpose:** Real-time application + system telemetry: process CPU usage (delta since last call), RSS memory vs. the `--max-old-space-size` limit (parsed out of `package.json` scripts), server uptime, DB connectivity check, Pulsar reachability check (2s timeout), and `withCache` hit/miss/key/size stats.
- **External APIs Used:** None directly — pings `${PULSAR_URL}/api/prices/latest` for liveness only.
- **Response Schema:**
  ```typescript
  {
    cpuUsagePercent: number;
    memoryUsageFormatted: string;   // e.g., "1.23 GB / 2 GB"
    maxAllocatedRamGB: number;      // parsed from package.json --max-old-space-size
    uptimeFormatted: string;        // e.g., "1d 2h 34m"
    dbConnected: boolean;
    pulsarOnline: boolean;
    cache: {
      hits: number;
      misses: number;
      activeEntries: Array<{ key: string; remainingTtl: number }>;
    };
  }
  ```

#### System Logs Stream (Live)
- **Route:** `GET /api/system/logs`
- **Purpose:** Subscribes to the in-memory log ring buffer (`lib/logger.ts`) over Server-Sent Events. Sends an `{ type: 'initial', logs: LogEntry[] }` frame on connect, then `{ type: 'new', log: LogEntry }` for each subsequent log line. 10s ping comments keep the connection alive.
- **External APIs Used:** None.
- **Response Format:** Event Stream / SSE (`text/event-stream`).

#### System Logs (Historical)
- **Route:** `GET /api/system/logs/historical?from=[iso]&to=[iso]&level=[level]`
- **Purpose:** Reads the on-disk PM2 log file (`~/.pm2/logs/mission-control-out.log`, overridable via `PM2_LOG_PATH` env var), parses JSON-lines entries, applies optional time-range and level filters, and returns up to the most recent 1000 matching entries. Lines that aren't structured JSON are skipped (handles the transition period from before structured logging was enabled). Used by the "Load older logs" button on the Internal Systems dash to scroll past what survives in the in-memory ring buffer.
- **External APIs Used:** None.
- **Response Schema:**
  ```typescript
  {
    logs: Array<{ ts: string; level: string; msg: string }>;
    total: number;
    note?: string; // present if PM2 log file is missing
  }
  ```

---

## Planned / Experimental Routes

*(Any future API integrations should be documented here before moving them into the main list.)*
