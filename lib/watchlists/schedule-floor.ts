/**
 * Per-crew FLOOR under `Watchlist.scheduleMinutes` — the minimum gap between
 * two automatic crawls of one crew-owned watchlist.
 *
 * WHY IT EXISTS (security fast-follow, 2026-07-29). `scheduler/jobs/job-watcher.ts`
 * honours the stored cadence literally:
 *
 *     .filter(c => !c.lastRunAt || now - c.lastRunAt.getTime() >= c.scheduleMinutes * 60_000)
 *
 * and `lib/schemas/watchlists.ts` only asked for `z.number().int().positive()`.
 * So a crew member could POST `scheduleMinutes: 1` and turn each of their
 * `CREW_WATCHLIST_LIMIT` (default 5) watchlists into a once-a-minute crawler:
 * ~7,200 crawls/day instead of ~30 at the 4h default. That is a ~240x lift on
 * three things they do not own — the OWNER's Gemini key (the scheduler's
 * `classifyEmploymentTypes` runs per newly-ingested posting and sits
 * deliberately OUTSIDE the per-user AI credit cap, `lib/ai/quota.ts`), the
 * shared `acquireGeminiSlot()` line the owner's Gmail ingest classifier queues
 * in, and this box's single residential IP pointed at Greenhouse / Lever /
 * LinkedIn. `lib/ai/quota.ts` justified leaving the scheduler unmetered with
 * "the crawl cadence is the scheduler's and not theirs" — this module is what
 * makes that sentence true.
 *
 * WHY A ROUTE-LEVEL CHECK AND NOT A SCHEMA-LEVEL `.min()`. A Zod schema has no
 * idea who is posting, and the OWNER legitimately runs a fast cadence (dropping
 * a watchlist to a few minutes is how a fetcher gets debugged). A `.min()` on
 * `WatchlistPostSchema` / `WatchlistPatchSchema` would bind them too. The cap it
 * pairs with — `CREW_WATCHLIST_LIMIT` in `app/api/watchlists/route.ts` — is
 * already an `if (!isOwner)` route-level rule for exactly this reason, so the
 * floor follows that shape rather than inventing a second one.
 *
 * WHY IT REJECTS INSTEAD OF SILENTLY CLAMPING. Both UI entry points
 * (`ScheduleField` in `AddWatchlistModal.tsx`, the stepper in
 * `EditFindRolesModal.tsx`) are hour-granular with `MIN_HOURS = 1`, so a crew
 * member driving the app CANNOT produce a sub-floor value at the default floor
 * of 60 — a request that trips this is hand-crafted, and a hand-crafted request
 * deserves to be told the rule rather than quietly given something it did not
 * ask for. Same 400-that-names-the-limit shape as `limitReachedResponse`.
 *
 * The two bounds compose: crew scheduled crawl volume is at most
 * `CREW_WATCHLIST_LIMIT × (1440 / floor)` per day — 5 × 24 = 120 at the
 * defaults, versus 5 × 6 = 30 at the 4h default cadence people actually use.
 */

import { NextResponse } from "next/server";
import { clampInt } from "@/lib/rate-limit/process-bucket";
import type { Role } from "@/lib/viewer";

/** Env var holding the crew floor, in minutes. The owner is exempt. */
export const CREW_MIN_SCHEDULE_MINUTES_ENV = "CREW_MIN_SCHEDULE_MINUTES";

/**
 * Floor when the env var is unset or unparseable: 60 minutes.
 *
 * Chosen to equal the fastest cadence the UI itself offers (`MIN_HOURS = 1` in
 * both cadence steppers), so the floor is invisible to every legitimate crew
 * flow and bites only a hand-rolled request. Raising it further is a product
 * decision; lowering it below 60 re-opens the ceiling this module bounds.
 */
export const DEFAULT_CREW_MIN_SCHEDULE_MINUTES = 60;

/** Hard bounds on the env-configured floor. */
const MIN_FLOOR = 1;      // 1 = "effectively no floor"; the schema still demands a positive int
const MAX_FLOOR = 1440;   // a full day — beyond this a watchlist stops being a watchlist

/**
 * Read the floor from the environment on EVERY call, not at module init —
 * same rationale as `lib/ai/quota.ts:crewAiDailyLimit()`: a
 * `pm2 restart … --update-env` takes effect without a code change, and the
 * hermetic smoke can drive several floors in one process. (The neighbouring
 * `CREW_WATCHLIST_LIMIT` is a module-level read; that one predates this and is
 * not worth churning inside a security fix.)
 *
 * `clampInt` returns the default for unset / blank / NaN input, so a typo'd
 * value degrades to the safe 60 rather than to "no floor". `0` clamps up to 1.
 */
export function crewMinScheduleMinutes(): number {
    return clampInt(
        process.env[CREW_MIN_SCHEDULE_MINUTES_ENV],
        DEFAULT_CREW_MIN_SCHEDULE_MINUTES,
        MIN_FLOOR,
        MAX_FLOOR,
    );
}

/**
 * The rejection. 400, not 403 — mirroring `limitReachedResponse` in
 * `app/api/watchlists/route.ts`: the caller is permitted on this route and the
 * request is well-formed; this particular VALUE cannot be satisfied. The body
 * names the floor both machine-readably (`minScheduleMinutes`, `requested`,
 * `reason`) and inside the human `error` string, because
 * `lib/api-client.ts:jsonFetch` surfaces exactly `err.error` to the toast.
 */
function floorResponse(requested: number, floor: number): NextResponse {
    return NextResponse.json(
        {
            error:
                `Crawl cadence too fast — a watchlist can run at most once every ${floor} ` +
                `minutes (you asked for every ${requested}). Pick ${floor} minutes or more.`,
            reason: "schedule-floor",
            minScheduleMinutes: floor,
            requested,
        },
        { status: 400 },
    );
}

/**
 * One log line per minute per process. A sub-floor request is only reachable by
 * a hand-crafted caller, which is precisely the caller that could loop — and an
 * unthrottled warn would let it flush the 500-deep log ring buffer
 * (`lib/logger.ts`), losing the context an operator needs. Same reasoning as
 * `lib/access-jwt.ts:warnThrottled`.
 */
const WARN_WINDOW_MS = 60_000;
let lastWarnedAt = 0;

/**
 * Enforce the floor for one request.
 *
 * Returns `null` when the request may proceed — the owner (exempt), or a body
 * that does not set the cadence at all (a PATCH changing only `name`), or a
 * value at/above the floor — and the 400 response otherwise. Call it right
 * after schema validation: it touches no database, so it is the cheapest
 * rejection on the route.
 *
 * @param role   the viewer's role, straight off the guard's synthesized session.
 * @param requested the submitted `scheduleMinutes`, or undefined when absent.
 */
export function scheduleFloorRejection(role: Role, requested: number | undefined): NextResponse | null {
    // The owner owns the box, the IP and the API key — metering their cadence
    // would be backwards, and they already rely on fast cadences to debug
    // fetchers. Same exemption shape as CREW_WATCHLIST_LIMIT.
    if (role === "owner") return null;
    if (requested === undefined) return null;

    const floor = crewMinScheduleMinutes();
    if (requested >= floor) return null;

    const now = Date.now();
    if (now - lastWarnedAt >= WARN_WINDOW_MS) {
        lastWarnedAt = now;
        console.warn(
            `[watchlists] crew cadence below the floor — requested every ${requested}m, ` +
            `floor is ${floor}m (${CREW_MIN_SCHEDULE_MINUTES_ENV}). Rejecting with 400. ` +
            `The UI cannot produce this value, so it came from a hand-built request.`,
        );
    }
    return floorResponse(requested, floor);
}

/** Test seam — drop the warn latch so one smoke's fixture can't mute the next. */
export function __resetScheduleFloorWarnLatch(): void {
    lastWarnedAt = 0;
}
