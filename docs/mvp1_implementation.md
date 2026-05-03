# MVP1 Implementation Plan

> **Scope.** This document is the concrete plan for the first implementation pass against `docs/architecture-critique.md`. It includes only options selected as the **primary** pick. Items marked "plan for X" go in `docs/mvp2_implementation.md`.
>
> **Convention.** Each task is labeled with its critique id (e.g. `[1.1a]`). Phases are ordered so later phases can lean on earlier ones; within a phase, tasks are mostly independent.
>
> **Status legend.** `✅ DONE` — shipped and verified in dev. `🔜 READY` — unblocked, not yet started. `⏳ GATED` — waiting on an external condition. `🔁 DEFERRED` — moved to MVP2.

---

## 0. Locked-in decisions

### 0.1 `[1.2a]` confirmed — calendar `userId` derived from session

The calendar endpoint will drop the client-supplied `userId` param and derive the user from the NextAuth session. This matches the pattern already used by `/api/applications` and is consistent with the rest of Phase 1's `requireSession` work.

**Future path (MVP2 Phase A2):** if Pulsar or another internal service ever needs to create calendar events programmatically, a separate `/api/internal/calendar/event` route with shared-secret auth (`PULSAR_INTERNAL_TOKEN`-style) is the right approach — same progression as `[1.1a] → [1.1b]`.

### 0.2 Pulsar integration — how it actually works

After reading `docs/architecture.md` and `README.md` in `/Users/sal/salsquared/pulsar`, the integration is the **inverse of what was previously assumed**.

**Pulsar is a standalone financial data service. Mission Control is a consumer. There is no endpoint to create in mission-control.**

Pulsar architecture in brief:
- **Hono** backend, port **3103** (prod) / **4103** (dev). Own SQLite DB (`prisma/prod.db` inside the Pulsar repo). Own PM2 entries in `/Users/sal/salsquared/ecosystem.config.cjs`.
- **Ingest jobs** are short-lived PM2 processes scheduled via `cron_restart`. Each job fetches one source, inserts `PriceTick` rows into Pulsar's DB, then exits. Schedules: CoinGecko every 5 min, Mempool every 2 min, Yahoo every 15 min, ExchangeRate hourly, FRED daily. A nightly rollup job aggregates `PriceTick → DailySummary`.
- **REST API** (`/api/prices/latest`, `/api/history/:id`, `/api/macro`, `/api/status/jobs`, etc.) is what mission-control calls — all server-to-server, no CORS concerns.
- **WebSocket** (`/ws/prices`) — subscribe by assetId, server pushes `tick` messages. Best-effort, not durable; client resyncs via REST on reconnect.
- **Auth on public reads**: none (Cloudflare Tunnel is the network boundary). Internal endpoints (`/internal/notify`, `/ingest/:sourceId`) use `Authorization: Bearer $PULSAR_INTERNAL_TOKEN`.

**Migration path** (from Pulsar's own architecture doc):
1. Stand up Pulsar with CoinGecko + Mempool sources.
2. Verify `GET /api/prices/latest?class=crypto` and `/api/history/bitcoin` output match mission-control's existing `/api/finance` response shape.
3. Swap mission-control's direct CoinGecko/Mempool calls → `fetch('http://localhost:3103/api/...')` in the finance routes.
4. Remove the opportunistic `prisma.cryptoPrice.create` in `/api/finance` — Pulsar now owns that data.
5. Drop the `CryptoPrice` model from mission-control's Prisma schema.
6. Decommission `scripts/seed-crypto.ts` and `scripts/ingest-btc-history.ts` — Pulsar handles backfill via its own `/history/:id` + `scripts/` directory.

Task 7A below reflects this correctly. The old plan (creating `/api/ingest/crypto-price` in mission-control) is replaced entirely.

---

## Phase 0 — Pre-flight: audit `scripts/tests/*` before Task 1B ships

Task 1B adds `requireSession` to `/api/settings`, `/api/goals`, `/api/research/saved`, and `/api/tasks`. Any script in `scripts/tests/` that calls these routes over HTTP will start returning 401 after that ships. This pre-flight task resolves it by making those calls server-internal *before* the auth guard lands.

### Task 0A ✅ — Convert test scripts that hit protected routes to server-internal calls

**Files:** affected files in `scripts/tests/`

Audit every file in `scripts/tests/` for `fetch('/api/settings')`, `fetch('/api/goals')`, `fetch('/api/research/saved')`, `fetch('/api/tasks')`, or `fetch('http://localhost...' + any of those paths`. For each hit:

- Replace the HTTP `fetch` call with a direct import of the relevant lib/repository function (e.g., `import { prisma } from '@/lib/prisma'` and query the model directly, or import a function from `lib/tasks/parser.ts`, `lib/repositories/...` etc.).
- The script should never go through the HTTP layer — it should call the same DB/lib functions the route would call, just without the HTTP boundary.

Scripts that call **public** routes (not in the protected list above — e.g., `/api/space`, `/api/research`, `/api/finance`) do not need to change.

**Dependencies:** none. Must complete before Task 1B.
**Acceptance:** `grep -r "fetch.*api/settings\|fetch.*api/goals\|fetch.*api/tasks\|fetch.*api/research/saved" scripts/tests/` returns zero matches. All existing test scripts still run to completion via `npx tsx scripts/tests/<name>.ts`.

---

## 1. Phase 1 — Security and persistence hygiene

These are the foundation everything else leans on. Low risk, fast to ship, fixes real problems today.

### Task 1A ✅ — `[1.1a]` Pub/Sub webhook shared-secret auth
**File:** `app/api/gmail/webhook/route.ts`
- Add `process.env.PUBSUB_WEBHOOK_SECRET` check at the very top of `POST`.
- Reject with 401 if `req.headers.get('authorization') !== \`Bearer ${secret}\``.
- Document the env var in `.env` example (untracked) and update `docs/hosting.md` Pub/Sub section to note "set the push-subscription's `Authorization` header to `Bearer $PUBSUB_WEBHOOK_SECRET`."

**Dependencies:** none.
**Acceptance:** A `curl -X POST` with no auth → 401. With wrong token → 401. With correct token + valid Pub/Sub envelope → 200 and `Application` upsert.

---

### Task 1B ✅ — `[1.3a]` `requireSession` helper for unauthenticated routes
**Files:**
- New `lib/auth-guards.ts`:
  ```typescript
  import { getServerSession } from 'next-auth/next';
  import { authOptions } from './auth';
  import { NextResponse } from 'next/server';

  export async function requireSession() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
    }
    return { session } as const;
  }
  ```
- Consumer pattern at the top of every protected handler:
  ```typescript
  const guard = await requireSession();
  if ('error' in guard) return guard.error;
  const { session } = guard;
  ```
- Apply at the top of every method in:
  - `app/api/settings/route.ts`
  - `app/api/goals/route.ts`
  - `app/api/research/saved/route.ts`
  - `app/api/tasks/route.ts`
- Skip `app/api/system/*`, `app/api/system/logs/*`, `app/api/auth/*`, `app/api/gmail/webhook` (already authed via 1A).

**Dependencies:** Task 0A (must complete first so `scripts/tests/*` aren't broken by the auth guard).
**Acceptance:** Unauthenticated `curl` to any of the four routes → 401. Logged-in browser session → 200 (existing behavior). All scripts in `scripts/tests/*` still run via `npx tsx scripts/tests/<name>.ts` (verified by Task 0A).

---

### Task 1C ✅ — `[1.2a]` Drop client-supplied `userId` on calendar route
**File:** `app/api/calendar/event/route.ts`
- Replace `userId = searchParams.get("userId")` (GET/DELETE) and `const { userId, ... } = body` (POST) with the `requireSession` helper from Task 1B; resolve `userId` to `session.user.id` on the server.
- Update `components/widgets/CalendarWidget.tsx` to drop `?userId=...` from every fetch URL and remove it from POST bodies.

**Dependencies:** Task 1B (reuses `requireSession`).
**Acceptance:** Calendar GET/POST/DELETE without a session → 401; with a valid session, no `userId` ever travels over the wire.

---

### Task 1D ✅ — `[2.1a]` Fix duplicate `PrismaClient` in settings route
**File:** `app/api/settings/route.ts`
- Delete `import { PrismaClient } from '@prisma/client'` and `const prisma = new PrismaClient()`.
- Add `import { prisma } from '@/lib/prisma'`.

**Dependencies:** none.
**Acceptance:** Settings writes appear as `[DATABASE] Executing upsert on globalSetting` lines in InternalView's log panel (they don't today).

---

### Task 1E ✅ — `[2.3a]` `migrate:prod` script in `package.json`
**Files:**
- `package.json`:
  ```json
  "migrate:prod": "DATABASE_URL=file:./prod.db npx prisma migrate deploy"
  ```
  > **Path note:** Prisma resolves SQLite `file:./` paths relative to `prisma/schema.prisma`, not the project root. `file:./prod.db` → `prisma/prod.db`. The earlier draft said `file:./prisma/prod.db` which resolves to `prisma/prisma/prod.db` (double directory) and fails with `P1003`. The `.env.production` value `DATABASE_URL="file:./prod.db"` is the reference: always match that exact form.
- `launch-ms.sh`: `npm run migrate:prod` runs inside the cold-start branch (inside the `else` block before `pm2 start`). Warm-path (port already bound) skips migrations.

**Prod.db baseline (one-time, already done):** `prod.db` was originally bootstrapped via `prisma db push`, so it had tables but no `_prisma_migrations` history. Applied the three pending migrations manually via `sqlite3`, then registered them with `prisma migrate resolve --applied <name>` for each. After this, `npm run migrate:prod` runs cleanly and `prisma migrate status` reports "Database schema is up to date."

**Dependencies:** none.
**Acceptance:** `./launch-ms.sh` cold start applies pending migrations automatically; warm path skips them.

---

## 2. Phase 2 — Cache, observability, backups

These are independent of Phase 1 but I'd ship Phase 1 first because Phase 2 changes are larger and hairier.

### Task 2A ✅ — `[3.3c]` Move `withCache` to durable SQLite-backed storage
**Files:**
- `prisma/schema.prisma`: add
  ```prisma
  model CacheEntry {
    key       String   @id
    data      String   // JSON-serialized response body
    expiry    DateTime
    createdAt DateTime @default(now())

    @@index([expiry])
  }
  ```
- Run `npx prisma migrate dev --name add_cache_entry`.
- Rewrite `lib/cache.ts`:
  - On miss: query `CacheEntry`, return if not-expired; else handler → `prisma.cacheEntry.upsert`.
  - On error: serve last-good (existing behavior) and re-store with 60 s retry TTL.
  - Keep an **in-memory L1** (`Map<string, {data, expiry}>`) in front of the DB to avoid a sync DB hit on every request. L1 invalidates whenever its expiry passes; L2 is the durable backstop.
- A new `pruneExpiredCache()` function called every 5 minutes from a small interval registered in `instrumentation.ts` to keep the table from growing unboundedly.

**Dependencies:** none, but Phase 1B should ship first so /api/system isn't reading a confusing cache-stats shape mid-flight.
**Acceptance:** Hot keys survive a `pm2 restart`; `X-Cache: HIT` lands within ~1 s of restart instead of after the next miss. `CacheEntry` row count stays bounded. Unit test (`lib/cache.test.ts`) covers hit, miss, stale-fallback, expired-eviction.
**Risk:** Medium. `withCache` is in the hot path of every public API. Ship behind a feature env var (`CACHE_BACKEND=memory|sqlite`) for first deploy and flip after a day of soak.

---

### Task 2B ✅ — `[3.2a]` Fail-loud sentinel for fetchers
**Files:**
- New `lib/fetchers/errors.ts`:
  ```typescript
  export class ScraperBrokenError extends Error {
    constructor(public source: string, public sampleLength: number) {
      super(`[SCRAPER BROKEN] ${source} returned 0 items (sample HTML length: ${sampleLength})`);
    }
  }
  ```
- Wrap each fetcher so that if it returns `[]` AND its raw response had non-empty HTML/JSON, throw `ScraperBrokenError`. Specifically:
  - `lib/fetchers/scrape-fetcher.ts` — after the regex loop, if `articles.length === 0 && html.length > 0` → throw.
  - `lib/fetchers/rss-fetcher.ts` — if `feed.items.length === 0` AND status was 200 → throw.
  - Custom fetchers in `lib/company-registry.ts` (Groq, Cerebras, Meta AI, OpenAI, SpaceX) — same guard.
- `console.error` outputs land in the SSE log feed and InternalView already color-codes them red.

**Dependencies:** none.
**Acceptance:** When a scraper's regex stops matching, the route returns 500 (and `withCache` STALE-FALLBACKs from Task 2A's durable cache), and a red `[SCRAPER BROKEN]` line appears in InternalView within seconds.

---

### Task 2C ✅ — `[4.1c]` Pipe logs to PM2's structured stdout, replace ring buffer reads
**Files:**
- `lib/logger.ts`:
  - Replace the in-memory ring buffer with stdout JSON-lines emission (one per `addLog` call): `process.stdout.write(JSON.stringify({ts, level, msg}) + '\n')`.
  - Keep the existing `subscribeToLogs` listeners pattern for the live SSE feed. The buffer becomes a small (50-entry) "current burst" cache so newly-connecting SSE clients still get a snippet of context before the first real-time entry.
- New `app/api/system/logs/historical/route.ts`:
  - Reads `~/.pm2/logs/mission-control-out.log` (path resolved from `pm2 jlist` or env).
  - Tails-from-end with optional `?from=<iso>&to=<iso>&level=<level>` filtering.
  - Returns up to 1000 entries.
- `components/views/InternalView.tsx`: extend the log panel with a "Load older" button that hits the new historical endpoint.
- `launch-ms.sh`: pin PM2 log rotation:
  ```bash
  pm2 install pm2-logrotate
  pm2 set pm2-logrotate:max_size 10M
  pm2 set pm2-logrotate:retain 30
  ```

**Dependencies:** none.
**Acceptance:** After a `pm2 restart`, the log panel shows the last 1000 lines from before the restart via "Load older." Disk usage from logs stays ≤300 MB.

---

### Task 2D ✅ — `[4.2a]` Fetcher health dashboard tile
**File:** `components/views/InternalView.tsx`
- Subscribe to the existing SSE log feed and parse lines matching `^\[CACHE FALLBACK\]`, `^\[SCRAPER BROKEN\]`, and host names from `^\[EXTERNAL API\]`.
- Aggregate the last hour into `{ host: { ok, fallback, broken } }`.
- Render a new card on InternalView: a sortable table of hosts with their status counts and a derived health pill (Green ≥95%, Yellow ≥70%, Red <70%).

**Dependencies:** Task 2B (so `[SCRAPER BROKEN]` lines exist).
**Acceptance:** Manually break a scraper (point its URL to `https://example.invalid`) → tile shows the host as Red within ~1 minute.

---

### Task 2E ✅ — `[4.3a]` Toast on `X-Cache: STALE-FALLBACK`
**Files:**
- A small wrapper around `fetch` in `lib/fetcher-client.ts` that inspects response headers and pushes a toast via a new minimal toast store (Zustand or a simple ref).
- A `<ToastHost />` component mounted once in `app/layout.tsx`, positioned **bottom-left**.
- Use the wrapper in views that hit cached endpoints (or replace later when SWR adoption lands in 5A).

**Dependencies:** none, but cleanest if done after Phase 4 (SWR) — at which point you can hook the toast into SWR's `onSuccess` and inspect headers there. **Defer this task to after 5A** to avoid double work.

**Acceptance:** When `withCache` STALE-FALLBACKs, a yellow toast appears **bottom-left** naming the route and host.

---

### Task 2F ✅ — `[9.1a]` Nightly DB backup to Google Drive
**Files:**
- `scripts/backup-db.sh`:
  ```bash
  #!/bin/bash
  set -e
  LOCAL_DIR="$HOME/backups/mission-control"
  mkdir -p "$LOCAL_DIR"
  TS=$(date +%Y%m%d-%H%M%S)
  DEST="$LOCAL_DIR/mc-$TS.db"

  # 1. Hot backup of prod.db (safe while server is live — SQLite BACKUP API handles WAL)
  sqlite3 /Users/sal/salsquared/mission-control/prisma/prod.db ".backup '$DEST'"

  # 2. Push to Google Drive via rclone
  rclone copy "$DEST" "gdrive:backups/mission-control/"

  # 3. Keep last 30 days locally
  find "$LOCAL_DIR" -name 'mc-*.db' -mtime +30 -delete
  ```
- `~/Library/LaunchAgents/com.salsquared.mc-backup.plist` — `launchd` plist that fires `scripts/backup-db.sh` daily at 03:00 local time.

**One-time setup:** `brew install rclone && rclone config` — configure a remote named `gdrive` pointing at your Google account. `rclone config` runs an OAuth flow in the browser; once done, `rclone lsd gdrive:` should list your Drive root.

**Dependencies:** none.
**Acceptance:** After 24 hours, `rclone ls gdrive:backups/mission-control/` shows at least one `mc-*.db` file. `sqlite3 <downloaded-file>.db .schema | head -5` shows recognizable Prisma tables. Restoration: `rclone copy "gdrive:backups/mission-control/mc-<ts>.db" prisma/prod.db && pm2 restart mission-control`.

---

## 3. Phase 3 — DB-as-source-of-truth (`5.3` per `db_source_of_truth_plan.md`)

This is the biggest single change in MVP1. The plan in `docs/db_source_of_truth_plan.md` is the spec; this section is the implementation checklist mapped against it.

### Task 3A ✅ — Event bus and SSE endpoint
**Files:** `lib/events.ts`, `app/api/events/route.ts`.
- Implement exactly per `db_source_of_truth_plan.md` §1.

**Dependencies:** none.
**Acceptance:** `curl -N http://localhost:3101/api/events` stays open and prints `: connected` immediately, `: heartbeat` every 30 s.

---

### Task 3B ✅ — Flip task routes to DB-first
**File:** `app/api/tasks/route.ts`.
- `PATCH` rewrite: DB update → `broadcastEvent({model:'Task', action:'upsert', id})` → async `regenerateMarkdownFromDB()`.
- `POST` rewrite: DB insert → broadcast → async regenerate.
- `GET` rewrite: drop the mtime check, just read DB (the watcher in 3D handles file → DB).
- Extract the existing line-rewriting code (lines 73–136) into `regenerateMarkdownFromDB()` in `lib/tasks/regenerator.ts`.

**Dependencies:** Task 3A (event bus must exist before broadcast calls compile).
**Acceptance:** PATCH a task via the UI → both panel tabs update without polling. Editing the file in VS Code works (Task 3D), no race with the writer (Mutex).

---

### Task 3C ✅ — Markdown regenerator (Strategy A: line-level patching)
**File:** `lib/tasks/regenerator.ts`.
- Pull `tasks` from DB.
- Read `docs/todo.md`, find each `<!-- id: ... -->` line, rewrite per current `PATCH` logic.
- Call `suppressNextFileChange()` (from 3D) before write.

**Dependencies:** Task 3B (the route invokes this).
**Acceptance:** After a UI mutation, `docs/todo.md`'s changed line matches the DB. Headers, notes, and unrelated lines are untouched.

---

### Task 3D ✅ — File watcher
**Files:** `lib/tasks/watcher.ts`, `instrumentation.ts`.
- Implement exactly per `db_source_of_truth_plan.md` §3.
- 500 ms debounce around `fs.watch` callbacks. Echo-suppression flag set by Task 3C before each programmatic write.

**Dependencies:** Tasks 3A and 3B.
**Acceptance:** Open `docs/todo.md` in your editor, change a status `[ ]` → `[x]`, save. Within ~1 s the dashboard reflects the change with no manual reload.

---

### Task 3E ✅ — Frontend SSE consumer hook
**Files:** `hooks/useServerEvents.ts`, `components/views/PlanningView.tsx`.
- Implement per `db_source_of_truth_plan.md` §"Frontend: SSE Client Hook."
- Subscribe to `'Task'` model in PlanningView; on event, refetch.

**Dependencies:** Task 3A.
**Acceptance:** Opening two browser tabs side by side; mutating in one updates the other ≤500 ms later (no manual refresh, no double-refetch storm).

---

### Task 3F ✅ — Extend events to other mutating routes
- Add `broadcastEvent` calls in:
  - `/api/goals` (PATCH/POST/DELETE) → `{ model: 'Goal', action, id }`.
  - `/api/research/saved` (POST/DELETE) → `{ model: 'SavedPaper', action, id: paperId }`.
  - `/api/gmail/webhook` after each `Application` upsert → `{ model: 'Application', action: 'upsert', id }` (this is the only writer of `Application` rows; `/api/applications` is GET-only).
  - `/api/calendar/event` (POST/DELETE) → `{ model: 'CalendarEvent', action, id: eventId }`.

**Dependencies:** 3A, 3B.
**Acceptance:** `useServerEvents('Goal')`, `useServerEvents('SavedPaper')`, `useServerEvents('Application')`, and `useServerEvents('CalendarEvent')` can be wired into their respective views (`PlanningView` already has `Goal` from earlier; `ApplicationsView` consumes both `Application` and `CalendarEvent`; `SavedPapersOverlay` consumes `SavedPaper`) and each one auto-refreshes its data on the corresponding event.

---

## 4. Phase 4 — Frontend modernization

### Task 4A ✅ — `[5.1a]` Adopt SWR
**Files:** every view, `components/cards/*`, `components/widgets/*`.
- Add dependency: `npm install swr`.
- Replace `useEffect(() => { fetch(...).then(setData) }, [...])` patterns with `const { data, mutate } = useSWR('/api/...', fetcher)`.
- Combine with `useServerEvents(model, () => mutate())` from Task 3E for live invalidation.
- Migrate views in this order to limit blast radius: PlanningView → ApplicationsView → SavedPapersOverlay → AIView → SpaceView → PhysicsView → FinanceView → InternalView (last because of SSE log feed).

**Dependencies:** Task 3E (SSE hook) for the `mutate()` integration.
**Acceptance:** Switching between dashes is instant on warm cache. Network tab shows zero duplicate `/api/research?...` calls when AI and Physics views are visited in quick succession.
**Risk:** Medium. Some views have intricate fetch state (FinanceView's `LastUpdated` pill, PlanningView's force-reload). Test each view manually before moving on.

---

### Task 4B ✅ — `[5.2a]` AICompanion behind a feature flag
**Files:**
- `components/providers/settingsStore.ts`: rename `backgroundTasks` → `aiCompanionEnabled` (it's currently unused; `localStorage` will need a one-line shim to read the old key as a fallback for one release).
- `components/Dashboard.tsx`: gate the AI Companion bottom-nav button and the `<AICompanion>` mount on `aiCompanionEnabled`. Default `false`.
- `components/views/InternalView.tsx`: surface a "AI Companion (preview)" toggle in the agent toggles section.
- `components/AICompanion.tsx`: keep the stub but add a clear "PREVIEW — not connected to a real model yet" banner so the misleading copy doesn't ship enabled.

**Dependencies:** none.
**Acceptance:** Default install has no AI button visible. Toggling on shows the stub with the preview banner. (Real Gemini integration is critique 5.2b/c, not in MVP1.)

---

### Task 4C ✅ — `[6.1a]` Debounce theme sync
**File:** `components/providers/ThemeProvider.tsx`.
- Wrap the `useThemeStore.subscribe` handler's POST call in a 500 ms debounce.
- Use `lodash.debounce` (already a transitive dep via NextAuth) or hand-roll.

**Dependencies:** none.
**Acceptance:** Editing a dash title via the launchpad input fires one POST after the user stops typing, not one per keystroke. (Network tab.)

---

### Task 4D ✅ — Toast on stale fallback (`[4.3a]`, deferred from Phase 2E)
- Hook the toast into SWR's `onSuccess` fetcher wrapper: inspect `res.headers.get('X-Cache')`, push to the toast store if it reads `STALE-FALLBACK`. Toast renders **bottom-left** via the `<ToastHost />` from Task 2E.

**Dependencies:** Task 4A (SWR), Task 2E (`<ToastHost />` already mounted).

---

## 5. Phase 5 — Schema and state restructuring

### Task 5A ✅ — `[6.2c]` Promote `GlobalSetting` JSON to columns

Prisma migrations are pure SQL and can't run TypeScript transformations on existing rows. The cleanest path is **three sequential migrations + a one-shot backfill script**, in this order:

**Step 1 — Add new columns as nullable (`prisma migrate dev --name add_globalsetting_columns`):**
```prisma
model GlobalSetting {
  id              String   @id @default("global")
  data            String?  // existing JSON blob; nullable now (was required)
  isDarkMode      Boolean? @default(true)
  viewHuesEnabled Boolean? @default(true)
  viewHues        String?  // JSON: Record<string, number>
  dashOrder       String?  // JSON: string[]
  dashTitles      String?  // JSON: Record<string, string>
  updatedAt       DateTime @updatedAt
}
```
(`viewHues`, `dashOrder`, `dashTitles` stay JSON strings because their value shapes are inherently variable; the *envelope* is now strongly typed.)

**Step 2 — Backfill script (`scripts/migrate-globalsetting.ts`):** reads the existing `data` JSON from the single `id="global"` row and projects each top-level field into the matching new column. Idempotent: re-running on already-migrated rows is a no-op. Run via `npx tsx scripts/migrate-globalsetting.ts` once in dev, once in prod.

**Step 3 — Drop the legacy column and tighten constraints (`prisma migrate dev --name drop_globalsetting_data`):** removes `data`, marks the new columns NOT NULL with their defaults.

**Files affected:**
- `prisma/schema.prisma` — twice (steps 1 and 3).
- `scripts/migrate-globalsetting.ts` (new, deleted after step 3 ships).
- `app/api/settings/route.ts` — rewrite GET/POST to read/write the new column shape after step 2.
- `lib/repositories/settings.ts` (new) — `parseGlobalSetting(row)` returns a typed object; used by both the route and `ThemeProvider`.

**Dependencies:** Task 1D (settings route already imports shared `prisma`), Task 1E (so migrations run in prod automatically).

**Acceptance:** Existing prod settings survive all three migrations. After step 3, `select * from GlobalSetting` shows real columns and no `data` blob. GET returns the same shape `ThemeProvider` already expects. The backfill script can be re-run safely (no-op on a fresh row).

---

### Task 5B ✅ — `[6.3c]` Single-source-of-truth state store
**Files:**
- New `components/providers/state/index.ts` with a unified Zustand store split by domain:
  ```typescript
  // Pseudo:
  interface AppState {
    theme: ThemeSlice;          // synced to /api/settings (cross-device)
    devicePrefs: DevicePrefsSlice; // localStorage (per-device)
    ui: UISlice;                // ephemeral (in-memory only)
  }
  ```
- Persistence policy declared on the slice: each slice exports `{ persist: 'remote' | 'local' | 'memory' }`.
- A wrapper subscribes to the store and routes mutations to the right backend (the existing `ThemeProvider` POST → `/api/settings` for `remote`; `localStorage.setItem` for `local`; nothing for `memory`).
- Migrate `themeStore` into `theme` slice, `settingsStore` into `devicePrefs` slice. Drop the standalone files.

**Dependencies:** Task 5A (the `theme` slice's remote shape is the new typed `GlobalSetting`).
**Acceptance:** All consumers compile with one import path; behavior is unchanged from the user's POV.

---

## 6. Phase 6 — Validation, tests, dedup

### Task 6A ✅ — `[8.2a]` Zod on critical write routes
**Files:** new `lib/schemas/` directory with one file per route:
- `lib/schemas/tasks.ts` — request schemas for PATCH/POST.
- `lib/schemas/calendar.ts` — request schema for POST.
- `lib/schemas/research-import.ts` — request schema for POST.
- `lib/schemas/gmail-webhook.ts` — Pub/Sub envelope schema.

Each route does `const parsed = Schema.safeParse(await req.json()); if (!parsed.success) return 400`.

**Dependencies:** none.
**Acceptance:** Malformed payload to any of the four routes returns 400 with a Zod issue path; valid payloads pass through unchanged.

---

### Task 6B ✅ — `[3.1a]` Vitest on parser + cache
**Files:** new `vitest.config.ts`, `lib/tasks/parser.test.ts`, `lib/cache.test.ts`.
- `npm install -D vitest @vitest/ui`.
- Parser tests: idempotent re-parse, ID injection on a freshly authored task, indent → parent, priority emoji, due-date extraction, notes binding. (`lib/tasks/parser.ts` itself doesn't change in Phase 3 — only its callers do.)
- Cache tests: hit, miss, stale-fallback on handler throw, stale-fallback on non-OK, expiry behavior, durable-store interaction (post-2A), in-flight dedup (post-6C).
- New `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

**Dependencies:** Task 2A (cache shape final). Parser tests can be written any time. Run after 6C if you want the in-flight-dedup behavior covered in the same suite.
**Acceptance:** `npm run test` runs ≤30 tests, all passing.

---

### Task 6C ✅ — `[7.2a]` Server-side in-flight dedup
**File:** `lib/cache.ts`.
- Track `Map<key, Promise<NextResponse>>` of pending fetches alongside the existing data store.
- Second concurrent miss for the same key awaits the existing promise instead of running the handler.

**Dependencies:** Task 2A (rewrite already touches this file).
**Acceptance:** Unit test fires 10 simultaneous requests against a slow handler; handler runs once, all 10 callers receive the same response.

---

## 7. Phase 7 — Pulsar integration

The integration is mission-control **fetching from** Pulsar. No new endpoints are created in mission-control.

### Task 7P — Pulsar health indicator in InternalView

**Status: DONE.** `GET /api/system` now probes `$PULSAR_URL/api/prices/latest` with a 2 s timeout and returns `pulsarOnline: boolean`. InternalView renders a "Pulsar Status" tile (amber = offline, green = online) alongside the DB status tile, polling every 5 s via the existing `/api/system` SWR subscription.

While Pulsar is being built and its dev instance is offline, FinanceView will STALE-FALLBACK from cache (or error on cold start). The tile makes this state visible in InternalView without polluting other views.

### Task 7A ✅ — `[2.2b]` Migrate finance routes to Pulsar REST API

This task is executed in two sub-steps: first a shape-compatible proxy swap, then a cleanup of the now-dead ingest code.

**Sub-task 7A-i ✅ — proxy swap (no user-visible change)**

Files:
- `app/api/finance/route.ts`:
  - Replace the parallel `fetch(COINGECKO_TOP100_URL)`, `fetch(COINGECKO_PRICES_URL)`, `fetch(MEMPOOL_FEES_URL)` calls with a single `fetch('http://localhost:3103/api/prices/latest?class=crypto')`.
  - Map Pulsar's `PriceTick`-derived response (`assetId`, `symbol`, `close`, `change24h`, `volume`) to mission-control's existing response shape (`top100`, `prices.bitcoin.usd`, `fees.*`). A small `adaptPulsarToFinanceShape()` function in the route handles this mapping.
  - Remove `prisma.cryptoPrice.create` — the opportunistic insert is gone entirely. No new Prisma calls.
- `app/api/finance/history/route.ts`:
  - Replace the CoinGecko `/market_chart` call and the Yahoo Finance fallback with `fetch(\`http://localhost:3103/api/history/${coin}?from=${from}&to=${to}&interval=1h\`)` for short ranges and `fetch(\`http://localhost:3103/api/history/${coin}/summary?from=${from}\`)` for long-range chart data (Pulsar's `DailySummary` rows).
  - Remove the `prisma.cryptoPrice.findMany` query and the `createMany` batch insert.

New env var: `PULSAR_URL`. Per-environment, same pattern as `DATABASE_URL`:
- `.env.production`: `PULSAR_URL=http://localhost:3103`
- `.env.development`: `PULSAR_URL=http://localhost:4103`

Both finance routes read `process.env.PULSAR_URL`. Hard-fail at startup if it's missing rather than silently falling back to a guess.

**Dependencies:** Pulsar must be running with at least the CoinGecko and Mempool sources active. Mission-control's withCache wrapper remains; the TTLs stay the same (5 min). No frontend changes.

**Acceptance:** `GET /api/finance` returns the same shape as before; prices come from Pulsar. `GET /api/finance/history?coin=bitcoin&range=30` returns chart points sourced from Pulsar. FinanceView renders identically. `prisma.cryptoPrice.findMany` is never called.

---

**Sub-task 7A-ii 🔁 — cleanup (moved to MVP2)**

The `app/api/finance/route.ts` has zero references to `prisma` or `CryptoPrice` — the proxy swap was clean. The cleanup (drop the `CryptoPrice` model, delete seed scripts) is deferred to MVP2 Phase 0 alongside the broken-scraper fixes. No code risk; just housekeeping that makes sense to bundle with the Pulsar stabilisation work.

---


## 8. Phase 8 — Code health and deployment

### Task 8A ✅ — `[8.1a]` Split `lib/company-registry.ts`
**Files:**
- `lib/companies/registry.ts` — the `COMPANY_REGISTRY` array, lookup helpers, aliases.
- `lib/companies/custom-fetchers.ts` — `fetchSpaceX`, `fetchOpenAI`, `fetchGroq`, `fetchCerebras`, `fetchMetaAI`.
- Keep `lib/company-registry.ts` as a thin re-export for one release to avoid a wide find/replace; remove in MVP2.

**Dependencies:** none.
**Acceptance:** All current imports keep working; a `find` for `from '@/lib/company-registry'` still resolves.

---

### Task 8B ✅ — `[8.3a]` Re-enable `reactStrictMode`
**File:** `next.config.ts`.
- Flip `reactStrictMode: false` → `true`.

**Dependencies:** Task 4A (SWR). SWR's internal dedup window prevents double network requests under strict-mode double-invocation, so re-enabling is safe once all views use SWR.

**Status: DONE.** Enabled after Task 4A (SWR) was confirmed complete. Boot log is clean; SWR deduplicates concurrent fetches so no double network requests occur in dev.

---

### Task 8C ✅ — `[9.2b]` Local Caddy reverse proxy for LAN access
**Files:**
- `~/.config/caddy/Caddyfile` (already in place):
  ```
  mc.local:443 {
    tls internal
    reverse_proxy 127.0.0.1:3101
  }
  ```
- `launch-ms.sh` — Caddy is started automatically if installed and not running; `APP_URL` is set to `https://mc.local` when Caddy is available, falling back to `http://localhost:$PORT` if not.

**One-time setup (run once per machine, requires sudo):**
```bash
brew install caddy
sudo caddy trust           # installs Caddy's local CA into the macOS keychain
sudo sh -c 'echo "127.0.0.1 mc.local" >> /etc/hosts'
# Add to .env:  NEXTAUTH_URL=https://mc.local
```
On LAN devices (phone, other Macs): add `<mac-mini-ip> mc.local` to their hosts file or local DNS resolver, then install the Caddy root cert (exported from macOS Keychain → transfer to device).

**Status: DONE (code).** Pending one-time `brew install caddy` + `sudo caddy trust` + hosts entry on the Mac mini. `launch-ms.sh` is self-contained — it falls back gracefully to `http://localhost:3101` until Caddy is installed.

---

### Task 8D ✅ — `[9.3a]` `SIGTERM` graceful shutdown
**File:** `instrumentation.ts`, `launch-ms.sh`.
- On `SIGTERM`: stop accepting new requests, wait for the file-write Mutex to drain (Task 3B/3C), close the SSE event-bus listeners, exit 0.
- Default PM2 `kill_timeout` is 1.6 s; bump to 10 s in `launch-ms.sh`. **Position matters**: PM2 flags must come *before* the `--` separator (everything after `--` is forwarded to the Next binary). Update the existing line from
  ```bash
  NODE_OPTIONS='--max-old-space-size=1024' pm2 start node_modules/next/dist/bin/next --name "mission-control" -- start -p $PORT
  ```
  to
  ```bash
  NODE_OPTIONS='--max-old-space-size=1024' pm2 start node_modules/next/dist/bin/next --name "mission-control" --kill-timeout 10000 -- start -p $PORT
  ```

**Dependencies:** Task 3 (so the watcher and event bus also clean up).
**Acceptance:** `pm2 restart mission-control` does not produce truncated `docs/todo.md` writes or dropped SSE clients (clients reconnect cleanly). `pm2 describe mission-control` shows `kill_timeout: 10000`.

---

### Task 8E ✅ — `[9.3b]` Restart guard / write-ahead protection
**Files:** `lib/restart-guard.ts`, `launch-ms.sh`, `.gitignore`.
- A flag file at `.restart-flag` (project root) set by `launch-ms.sh --restart` before kill. While present, `app/api/tasks/PATCH|POST` returns 503 "shutting down." (Project root, not `prisma/`, since `prisma/` is for schema and migrations only.)
- Cleared by `instrumentation.ts` on next clean boot.
- Add `.restart-flag` to `.gitignore`.

**Dependencies:** Task 8D (works in tandem; 8D drains, 8E rejects new writes).
**Acceptance:** A `./launch-ms.sh --restart` mid-edit produces a 503 from `PATCH /api/tasks` (visible in network tab and surfaced via SWR's error state in PlanningView — not via the stale-fallback toast from Task 2E, which is for cache freshness only). After the restart completes, retrying the mutation succeeds. `.restart-flag` exists during the kill window and is gone after a successful clean boot.

---

### Task 8F ✅ — Migrate `middleware.ts` → `proxy.ts`
**Files:** `proxy.ts` (new), `middleware.ts` (deleted).

Next.js 16 deprecated the `middleware` file convention in favour of `proxy`. The migration:
- Rename file `middleware.ts` → `proxy.ts`
- Rename export `function middleware` → `function proxy`
- `export const config` / `matcher` unchanged

**Status: DONE.** Boot log no longer shows the deprecation warning.

---

## 9. Deferred to MVP2

The following items were identified during MVP1 but are not blocking. They are tracked in `docs/mvp2_implementation.md` Phase 0:

- **Task 7A-ii** — drop `CryptoPrice` schema model and delete seed/ingest scripts (housekeeping after Pulsar stabilises).
- **Broken scrapers** — xAI (403), AMD RSS (404), Google AI RSS (404), ARM regex rot, Qualcomm JS-rendered page. All produce `[SCRAPER BROKEN]` errors surfaced by Task 2B; fix by switching to `google-news` strategy.

---

## 10. Cross-task interactions to watch

| Pair | Interaction |
|---|---|
| Phase 3 + Task 4A (SWR) | The SSE hook + `mutate()` is the *intended* combination. Don't ship SWR before the hook — you'll just refetch via SWR's polling and waste the bus. |
| Task 2A (durable cache) + Task 6C (in-flight dedup) | Both modify `lib/cache.ts`. Do 2A first, then 6C. |
| Task 5A (column promotion) + Task 5B (unified store) | 5A defines the *shape*; 5B re-exposes that shape under a per-key persistence policy. 5A must ship first. |
| Task 1A + Task 7A | No shared-secret concern in 7A — Pulsar's public REST endpoints are unauthenticated (Cloudflare Tunnel is the boundary). The MVP2 WebSocket relay (Task E4) uses `PULSAR_INTERNAL_TOKEN` which lives in Pulsar's auth model, not mission-control's. |
| Task 8B (Strict mode) + Task 4A (SWR) | Strict mode's double-invoke of effects exposes any non-idempotent fetch. SWR's effects are idempotent. Doing 4A first makes 8B nearly a no-op. |
| Task 1B (`requireSession`) + Task 1C (calendar) | Same helper. Land 1B's helper, then 1C uses it. |
| Task 0A + Task 1B | 0A converts `scripts/tests/*` to call lib functions directly so 1B's auth guard doesn't break them. **0A must ship first.** |
| Task 8D + Task 8E | 8D drains in-flight writes via Mutex; 8E rejects *new* writes via the flag file. Together they make `--restart` safe. Same touchpoints in `launch-ms.sh` and `instrumentation.ts`; ship 8D first, then 8E. |
| Task 7A-i + Task 5A | Both touch the Prisma schema (`CryptoPrice` removal in 7A-ii, `GlobalSetting` columns in 5A). Order: 5A ships in Phase 5, 7A-ii cleanup ships in Phase 7. No conflict. |

---

## 11. Suggested ordering

A pragmatic week-by-week shape if you want one (durations are rough):

1. **Week 1**: Phase 0 (Task 0A) + Phase 1 (Tasks 1A–1E). Day 1 is 0A so 1B doesn't break test scripts; the rest of Phase 1 follows. All tightly correlated.
2. **Week 2**: Phase 2 (2A, 2B, 2C, 2D, 2F). Defer 2E to Phase 4.
3. **Week 3**: Phase 3 (Tasks 3A–3F). Whole week; the source-of-truth flip is the heaviest single change.
4. **Week 4**: Phase 4 (Tasks 4A–4D). SWR migration is the long pole; AICompanion flag is a half-day.
5. **Week 5**: Phase 5 (Tasks 5A, 5B). Three-step schema migration first (5A), then store rewrite (5B).
6. **Week 6**: Phase 6 (Tasks 6A, 6B, 6C). Validation first, then tests, then dedup.
7. **Week 7**: Phase 7 (Task 7A-i) — gated on Pulsar having CoinGecko + Mempool sources running. 7A-ii cleanup runs the week after 7A-i soaks. Task 7B (WebSocket relay) is in MVP2.
8. **Week 8**: Phase 8 (Tasks 8A–8E). Mostly independent; can parallelize across days.

---

## 12. Resolved decisions

All pre-implementation questions are now answered and reflected in the tasks above:

| # | Question | Answer | Where applied |
|---|---|---|---|
| 1 | `scripts/tests/*` hitting protected routes | Convert to server-internal before Task 1B | Task 0A |
| 2 | Task 7B (WebSocket relay) — MVP1 or MVP2? | MVP2 | MVP2 Phase E, Task E4 |
| 3 | Toast placement | Bottom-left | Tasks 2E, 4D |
| 4 | Backup destination | Google Drive via `rclone` | Task 2F |
| 5 | `PULSAR_URL` convention | Confirmed: `localhost:3103` prod / `localhost:4103` dev | Task 7A §env var |
