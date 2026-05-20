# Dev server performance profile

**Snapshot taken 2026-05-19 against `mission-control-dev` (PM2, port 4101).**

Measured baseline (idle browser tab on Space dash, dev server up ~13 min, no active user interaction):

| Metric | Value | Source |
| --- | --- | --- |
| Dev process RSS | **1.13 GB / 2 GB max-old-space-size** | `/api/system` |
| Reported CPU % | 100 (saturated) | `/api/system` |
| `.next-dev/dev` build cache | 195 MB on disk (138 MB in `cache/`) | `du -sh` |
| Dependencies | 50 deps + 17 devDeps; Next 16.1.1, React 19.2.3 | `package.json` |

**Important: `pm2 list` / `pm2 jlist` see only the npm wrapper, not the actual worker.** The PM2-managed entry is `npm run dev`, which forks `next dev`, which forks the `next-server` worker. Only the worker holds the HTTP state — EventSources, React tree, query cache, etc. The wrapper sits idle at ~54 MB regardless of how loaded the worker is. So **don't trust `pm2 list` to gauge dev-server load**: it'll say "50 MB" while the worker is at "1 GB". Use `/api/system` (in-process, reads the worker) or `scripts/perf-monitor.ts` (which walks the process tree to the worker — corrected 2026-05-20).

For context, the **prod** PM2 process is sitting at ~50 MB in its npm wrapper; its worker has not been measured separately but the same wrapper-vs-worker caveat applies.

---

## Top causes, ranked by impact

### 1. `console.info('[DATABASE] ...')` on every Prisma query, fanned out to every SSE log subscriber

**Where**: `lib/prisma.ts:23` logs every operation via `console.info`. The patched console in `lib/logger.ts:97` then:
1. Pushes onto the global ring buffer (and `shift()`s if over 50).
2. Writes a JSON line to stdout (PM2 captures it).
3. **Calls every entry in `__LOG_LISTENERS`** — one per `/api/system/logs` SSE connection.

**Why it hurts dev specifically**: when the user is on the Internal Systems dash (or it's open in another tab), the SSE listener serialises + encodes the payload and the browser then runs `InternalView.tsx:122-130`:
- `setSysLogs([...prev, log])` — full array copy, up to 500 entries
- `computeHealth(nextLogs)` — `InternalView.tsx:76-96` walks every log, runs three regexes per entry, builds a fresh `HealthMap` object on **every push**
- The entire `staticCards` JSX array (lines 178-565) is rebuilt inline because it lives in the component body, not memoised.

So one HTTP request that triggers 5 Prisma queries → 5 stdout writes + 5 SSE pushes + 5 client re-renders walking 500 logs each.

**Fix candidates** (cheapest first):
- Gate `console.info('[DATABASE] ...')` on `process.env.NODE_ENV === 'production' || process.env.DEBUG_PRISMA === '1'`. Dev shouldn't be logging every query when it's flowing into a live UI feed. Estimated win: large — kills the dominant log volume.
- Drop the regex-driven `formatLogMessage` from the live SSE path; render plain text in the live tail, only colourise when "Load older" is clicked. Or pre-compile the regexes once at module scope (currently `new RegExp` literal inside a hot path).
- Memoise `staticCards` with `useMemo` keyed on the inputs that actually change (sysMetrics, sysLogs, fetcherHealth) — right now `views.map`, `colorPresets`, JSX for telemetry boxes are all rebuilt every push.

### 2. `useServerEvents` opens a fresh `EventSource` per call — and Strict Mode opens each one twice

**Where**: `hooks/useServerEvents.ts:9` — no connection sharing. Every component that subscribes spins its own `/api/events` EventSource. Mount sites:
- `CacheInvalidationListener` (always mounted via QueryProvider)
- `NotificationBell` (always mounted via Dashboard)
- `useServerEvents` calls per active view: ApplicationsView (2), ProfileView (1), PlanningView (2), WatchlistsCard (1), NewPostingsCard (1), FinanceView (1), SavedPapersOverlay (1 when open)

Two browser tabs on the Applications dash = **8 long-lived SSE responses** pinned in the dev process. Each holds its own `ReadableStream`, encoder, abort listener, and 30-second heartbeat interval (`app/api/events/route.ts:27`).

**Compounded by**: `next.config.ts:13` has `reactStrictMode: true`, while `CLAUDE.md:163` claims it's `false`. Strict Mode in React 19 dev double-invokes effects, so every `useServerEvents` opens → closes → opens again on mount. The drift is recent (last touch of `next.config.ts` was the webpack-fallback fix; CLAUDE.md hasn't caught up).

**Fix candidates**:
- Move EventSource ownership up one layer: have `QueryProvider` (or a sibling `ServerEventsProvider`) own a **single** `/api/events` connection and dispatch to subscribers via a context-bound `Map<ModelName, Set<callback>>`. The hook becomes a registration call, not a connection opener. Big win in dev (8 → 1 connection) and a smaller, real win in prod.
- Decide on Strict Mode and reconcile the docs. If you want the double-mount safety net, keep it on and own the cost. If not, set `false` and delete the line in CLAUDE.md. Either way, stop the drift.

### 3. `CacheInvalidationListener` does a sledgehammer `invalidateQueries()` on every cache event

**Where**: `components/providers/CacheInvalidationListener.tsx:18`.

Any server-side `invalidateCacheKey('/api/foo')` broadcasts `'Cache'` → every client calls `queryClient.invalidateQueries()` (no filter) → **every** active TanStack query refetches. With `refetchOnWindowFocus: true` (QueryProvider:19) on top of this, alt-tabbing back to the browser triggers another full refetch.

**Fix**: include the invalidated cache key/prefix in the SSE payload and pass a `predicate` to `invalidateQueries` that only refetches queries whose `queryKey[0]` matches the prefix. The doc-comment in CacheInvalidationListener.tsx already calls this out ("The mapping is heavy-handed…") — it's a known trade-off but worth revisiting now that the query graph has grown.

### 4. Internal Systems telemetry polls every 5 s, always

**Where**: `components/views/InternalView.tsx:68` — `refetchInterval: 5000` with no `enabled` gate.

This fires `/api/system` every 5 s even when the dash isn't visible (the carousel renders one dash at a time, but mounting state of the Internal view persists across slide changes via React tree — actually it does NOT, Dashboard only renders the current view by index). Confirm by reading line 202 of `Dashboard.tsx`: `orderedDashes[currentIndex]?.component` — only the active dash mounts. So this is fine when the user is elsewhere.

But the `/api/system` handler **runs a Prisma `pingDatabase()`** on every tick (`app/api/system/route.ts:80`), which itself emits a `[DATABASE]` log line → which fans back out through SSE → see issue 1. **The telemetry poll is feeding its own log stream.**

**Fix**: cache `pingDatabase()` for 15-30 s in-process; or skip the DB ping unless a query parameter requests it. The "Database Status" pill doesn't need 5 s freshness.

### 5. Per-card setInterval timers

**Where**: each runs unconditionally once mounted:
- `NewsCyclingCard.tsx:28` — interval (verify duration)
- `NextLaunchCard.tsx:46` — **1 Hz** countdown timer, re-renders the whole card every second
- `ResearchPaperCard.tsx:36` — paper cycling
- `FinanceView.tsx:17` — 30 s clock tick for relative timestamps
- `ApplicationsView.tsx:92` — 5-minute Gcal sync trigger

The 1 Hz NextLaunch timer is the only one worth flagging on its own — render the seconds-precision off a `requestAnimationFrame` derived clock or a single global tick context so multiple "T-minus" displays share one source. Otherwise each card is its own tick + state set.

### 6. Build-side noise (dev only, not the dominant issue)

- `.next-dev/dev/cache` is 138 MB of webpack persistent cache. That's not "leaking" — it's how Next keeps HMR fast — but if you suspect a corrupt cache after dependency changes, deleting it gets you a fresh baseline. Don't reach for this routinely.
- `next.config.ts:14` correctly isolates `distDir: '.next-dev'` so dev and prod builds don't clobber each other; keep this.
- Heavy server-only deps (`googleapis`, `puppeteer-core`, `html-to-docx`, `mammoth`, `pdf-parse`, `jose`) are already in `serverExternalPackages` — they don't get webpack-bundled.

---

## Recommended order to ship

Each item below is a self-contained change; don't bundle them — measure RSS + CPU after each.

1. **Silence `[DATABASE]` query logs in dev** unless `DEBUG_PRISMA=1`. One-line gate in `lib/prisma.ts:23`. Expected: largest single drop in dev CPU + heap pressure, no UI change beyond the live log tail being quieter.
2. **Reconcile Strict Mode.** Flip `next.config.ts:13` to `false` to match CLAUDE.md, OR update CLAUDE.md and own the doubled effects. I'd recommend `false` for now — saves 2× SSE opens on every page navigate and matches existing component assumptions.
3. **Share one `/api/events` EventSource** across all `useServerEvents` callers. Provider + ref-counted subscription Map. Touches one hook + one provider; consumers don't change.
4. **Memoise `InternalView`'s `staticCards`** with `useMemo`, and move `computeHealth` to an effect-driven recompute (e.g. only every 5 s, not per log push). Keep the live tail responsive but stop walking 500 entries per Prisma query.
5. **Scope `CacheInvalidationListener` invalidations** to a prefix from the SSE payload — stop blanket-refetching every query.
6. **In-process cache `pingDatabase()`** in `/api/system` for ~15 s. Eliminates the self-feeding telemetry loop.

## Out-of-scope but worth knowing

- The 2 GB `--max-old-space-size` is intentional (CLAUDE.md flags it); lowering it without fixing #1–#3 will just OOM. Once those land, you can re-test at 1 GB.
- Webpack vs Turbopack: dev script uses `--webpack` explicitly. If you ever want to A/B test, Turbopack would likely cut the `.next-dev/cache` footprint, but every Next 16 / Tailwind 4 / Prisma combo needs a re-verification before flipping.
- `instrumentation.ts` starts a Pulsar WS relay on every Node boot; benign cost but worth flagging — `pulsar` PM2 process is offline today (`/api/system` reports `pulsarOnline: false`) and the relay sits in a reconnect loop. Not the dominant cost, but noise in the logs.
