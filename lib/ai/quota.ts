// Per-user daily Gemini credit counter (docs/multi-user-crew.html §2.9, OQ7a,
// task P2.5).
//
// WHAT THIS BOUNDS, AND WHAT IT DOES NOT.
//
// Every Gemini call in this app is billed to the OWNER's
// GOOGLE_GENERATIVE_AI_KEY and paced through ONE shared 12/min cross-tier
// bucket (`lib/ai/rate-limit.ts`). The load-bearing consumer of that bucket is
// `lib/email-parser.ts:parseApplicationEmail` — the owner's Gmail ingest
// classifier. The threat this module exists to bound is therefore NOT "crew
// spend money": it is a crew member holding down "regenerate resume" until the
// owner's applications stop being ingested from email (design risk R6).
//
// It bounds that by counting ROUTE INVOCATIONS per user per UTC day and
// refusing over the limit. Two imprecisions are deliberate and documented in
// the design's Risks — do not "fix" them:
//
//   1. IT COUNTS REQUESTS, NOT GEMINI CALLS. One POST /api/resumes can make
//      three (rewrite + tagline + posting-parse), so the true spend per credit
//      varies. Bounding the runaway loop is the goal; fair-sharing is not.
//      (Promote to OQ7b — a per-user bucket inside `acquireGeminiSlot()` — if
//      the complaint ever becomes "crew and owner contend" rather than "crew
//      ran away".)
//
//   2. IT IS A ROUTE-BOUNDARY CAP, SO THE SCHEDULER IS OUTSIDE IT — ON PURPOSE.
//      `scheduler/jobs/job-watcher.ts` calls `classifyEmploymentTypes` on every
//      automatic crawl of every watchlist, crew's included. That path never
//      passes through a route, so `consumeAiCredit` never sees it and a crew
//      member's SCHEDULED Gemini spend is uncapped in v1. This is a recorded
//      decision (2026-07-28, §2.9's callout + R6), not an oversight: what
//      bounds it is CREW_WATCHLIST_LIMIT × posting volume (OQ10a caps crew at 5
//      watchlists) — a real ceiling, just an indirect one — and unlike the
//      interactive path there is no runaway-loop shape available to a user,
//      because the crawl cadence is the scheduler's and not theirs. Extending
//      the credit check into the scheduler would mean threading a quota
//      decision into the job that must never stall and answering "what does a
//      scheduled job do when a user is over budget" (skip? defer? partially
//      classify?) for no v1 benefit. DO NOT wire this module into the
//      scheduler without reopening that question. The signal to watch is Gemini
//      usage rising with crew watchlist count rather than with crew activity.
//
// The owner is EXEMPT and never touches the table at all — no read, no write,
// no row. `used: 0 / limit: Infinity` on that path means "not metered", not
// "has made zero requests".

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
// Reuse the ONE date bucket (design + the AiUsage schema comment both say so
// explicitly): a locally-derived bucket drifts with server-local time and DST,
// which would either grant a second daily allowance or swallow one at the
// boundary. Never re-derive it here.
import { utcDateBucket } from '@/lib/notifications/dispatch';
import type { Role } from '@/lib/viewer';

/** Crew allowance when `CREW_AI_DAILY_LIMIT` is unset or unparseable. */
export const DEFAULT_CREW_AI_DAILY_LIMIT = 20;

/** Env var holding the per-crew-member daily allowance. Owner is exempt. */
const LIMIT_ENV = 'CREW_AI_DAILY_LIMIT';

/**
 * The result of a credit attempt.
 *
 * `used` is the count AFTER a granted increment (so the first call of the day
 * reports `used: 1`), and the current count on a refusal. Because the
 * increment is guarded by the same statement that performs it (see
 * `consumeAiCredit`), `used` never runs away past `limit` — a refused request
 * does NOT increment, so the UI can always say "you've used N of M today" with
 * N <= M.
 *
 * On the owner's exempt path `limit` is `Number.POSITIVE_INFINITY` and `used`
 * is 0; neither is ever serialized, because an exempt caller is always `ok`.
 */
export interface AiCreditResult {
    ok: boolean;
    used: number;
    limit: number;
}

/** Warn-once latch so a malformed env var doesn't flood the log ring buffer. */
let badLimitWarned = false;

/**
 * Read the crew allowance from the environment on every call (not at module
 * init) so a `pm2 restart --update-env` takes effect without a code change,
 * and so the hermetic smoke can drive several limits in one process.
 *
 * A non-integer / negative / NaN value falls back to the default with ONE
 * warn. `0` is a legitimate value meaning "crew get no interactive AI" and is
 * honoured — see the `limit <= 0` branch in `consumeAiCredit`, which must not
 * be reachable through the INSERT path (a bare upsert would hand a fresh user
 * one free call at limit 0, since the guard lives on the UPDATE branch).
 */
export function crewAiDailyLimit(): number {
    const raw = process.env[LIMIT_ENV];
    if (raw === undefined || raw.trim() === '') return DEFAULT_CREW_AI_DAILY_LIMIT;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        if (!badLimitWarned) {
            badLimitWarned = true;
            console.warn(
                `[AI-QUOTA] ${LIMIT_ENV}="${raw}" is not a non-negative integer — ` +
                `falling back to ${DEFAULT_CREW_AI_DAILY_LIMIT}/day per crew member.`,
            );
        }
        return DEFAULT_CREW_AI_DAILY_LIMIT;
    }
    return parsed;
}

/**
 * Spend one daily AI credit for `userId`.
 *
 * Call it at the TOP of an LLM-bearing route, after the cheap rejections
 * (auth, validation, ownership, the in-memory `checkUserRateLimit`) and before
 * any Gemini-touching work — it MUTATES, so anything that can still reject
 * after it would burn a credit for a request that never spent a token.
 *
 * ATOMICITY. Two simultaneous requests must not both pass at the boundary, so
 * this is deliberately NOT read-then-write (and deliberately not Prisma's
 * `upsert`, whose compound-unique path is not guaranteed to compile to a
 * single statement). It is ONE SQLite statement that both tests and applies
 * the limit:
 *
 *     INSERT INTO "AiUsage" (...) VALUES (..., 1)
 *     ON CONFLICT("userId","day") DO UPDATE
 *       SET "count" = "AiUsage"."count" + 1
 *       WHERE "AiUsage"."count" < <limit>
 *     RETURNING "count"
 *
 * SQLite serializes writers, so the two requests execute this statement one
 * after the other. The `WHERE` on the upsert clause is the boundary test: at
 * count = limit - 1 the first request updates to `limit` and RETURNING yields
 * a row (granted); the second finds `count < limit` false, skips the update,
 * and RETURNING yields NOTHING (refused). No row is ever incremented past the
 * limit, which is also why `used <= limit` always holds in the 429 body.
 *
 * FAILURE MODE: fail-OPEN, loudly. A DB error grants the credit rather than
 * denying AI to a paying-attention human because SQLite hiccuped. The quota is
 * a cost bound, not an authorization boundary — the security decision was
 * already made by the guard, and the runaway loop stays bounded by each
 * route's in-memory `checkUserRateLimit` (5–20 per 10 min) even with this
 * module fully broken.
 */
export async function consumeAiCredit(userId: string, role: Role): Promise<AiCreditResult> {
    // The owner is exempt: no read, no write, no row. Their spend is the thing
    // the crew cap exists to protect, so metering it would be backwards.
    if (role === 'owner') {
        return { ok: true, used: 0, limit: Number.POSITIVE_INFINITY };
    }

    const limit = crewAiDailyLimit();
    const day = utcDateBucket();

    // `CREW_AI_DAILY_LIMIT=0` — refuse without writing. This branch is NOT
    // redundant: the statement below guards only its UPDATE arm, so at limit 0
    // a user with no row yet would be handed one free call by the INSERT.
    if (limit <= 0) {
        return { ok: false, used: await readUsage(userId, day), limit };
    }

    try {
        // `id` has a Prisma-level `@default(cuid())`, which raw SQL bypasses —
        // supply one. Discarded on the conflict path; a UUID costs nothing.
        const granted = await prisma.$queryRaw<Array<{ count: number | bigint }>>`
            INSERT INTO "AiUsage" ("id", "userId", "day", "count")
            VALUES (${randomUUID()}, ${userId}, ${day}, 1)
            ON CONFLICT("userId", "day") DO UPDATE
              SET "count" = "AiUsage"."count" + 1
              WHERE "AiUsage"."count" < ${limit}
            RETURNING "count"
        `;

        if (granted.length > 0) {
            return { ok: true, used: Number(granted[0].count), limit };
        }

        // Zero rows returned ⇒ the upsert's WHERE rejected the increment ⇒ the
        // user is at (or, after a limit reduction, past) their allowance. Read
        // the count back for the message; this is informational only, so the
        // extra query is off the granted hot path and cannot race the decision.
        return { ok: false, used: await readUsage(userId, day), limit };
    } catch (err) {
        console.error(
            `[AI-QUOTA] credit accounting failed for user ${userId} on ${day} — ` +
            `GRANTING (fail-open; the per-route rate limiter still bounds the loop):`,
            err,
        );
        return { ok: true, used: 0, limit };
    }
}

/** Current count for a (user, day), or 0 when there is no row / the read fails. */
async function readUsage(userId: string, day: string): Promise<number> {
    try {
        const row = await prisma.aiUsage.findUnique({
            where: { userId_day: { userId, day } },
            select: { count: true },
        });
        return row?.count ?? 0;
    } catch {
        return 0;
    }
}

/**
 * THE 429 CONTRACT (task P3.6 renders this body — changing any field here is a
 * frontend-visible change).
 *
 *   HTTP 429
 *   Retry-After: <seconds until the next UTC midnight>
 *   {
 *     "error":  "Daily AI limit reached — you've used 20 of 20 today. Resets at 00:00 UTC.",
 *     "code":   "AI_QUOTA_EXCEEDED",
 *     "stage":  "ai-quota",
 *     "used":   20,
 *     "limit":  20
 *   }
 *
 * `code` is the field to branch on — `error` is prose and `stage` exists only
 * to match the `{ error, stage }` envelope the resume / profile routes already
 * return for every other failure, so the existing error handlers keep working
 * unchanged. `used <= limit` always holds (see `consumeAiCredit`), so
 * "N of M" never reads as nonsense.
 *
 * Built here rather than at each call site so all seven routes are guaranteed
 * byte-identical and P3.6 has exactly one shape to render.
 */
export function aiQuotaExceededResponse(result: AiCreditResult): NextResponse {
    return NextResponse.json(
        {
            error:
                `Daily AI limit reached — you've used ${result.used} of ${result.limit} today. ` +
                `Resets at 00:00 UTC.`,
            code: 'AI_QUOTA_EXCEEDED',
            stage: 'ai-quota',
            used: result.used,
            limit: result.limit,
        },
        { status: 429, headers: { 'Retry-After': String(secondsUntilUtcMidnight()) } },
    );
}

/** Seconds until the `utcDateBucket()` rolls over. Always >= 1. */
function secondsUntilUtcMidnight(now: Date = new Date()): number {
    const nextMidnight = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
    );
    return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000));
}
