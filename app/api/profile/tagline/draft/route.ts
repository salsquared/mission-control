// M7.9.5 — Tagline draft API route (story S7.14).
//
// POST /api/profile/tagline/draft
//
// Body: {} (no payload — server reads profile.tagline to decide mode).
// Returns: { tagline: string, mode: 'draft' | 'enhance' }
//
// Pipeline:
//   1. requireSession — owner check via session.user.id.
//   2. checkUserRateLimit('profile:tagline-draft', userId, 10 / 10 min).
//      Looser than bullet-tags-from-profile because tagline drafts are
//      cheaper per call (256 maxOutputTokens vs 1024), tighter than
//      resumes:gen because they're meant to be exploratory.
//   3. draftTagline({ userId }) — loads profile, builds compact summary,
//      dispatches mode based on whether current tagline is empty, calls
//      Gemini through chatJSON, post-filters output (trim, quotes, period).
//   4. Returns the cleaned proposal + the dispatched mode.
//
// The route does NOT persist. Client surfaces the proposal in a diff
// panel and persists on Accept via the existing /api/profile PATCH with
// `{ tagline: '...' }`. Discarding the proposal is a no-op.
//
// Error handling:
//   * AIError → 502 with { error, stage, aiStage } (mirrors bullet-assist).
//   * Other throws → 500 with the error message.

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { checkUserRateLimit } from "@/lib/api/user-rate-limit";
import { draftTagline } from "@/lib/profile/tagline-draft";
import { AIError } from "@/lib/ai/gemini";

export const runtime = "nodejs";
// Gemini call typically returns in ~2–4s. Bump from the default 10s ceiling
// to match the other LLM routes; a slow Gemini day shouldn't 504 us.
export const maxDuration = 60;

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function POST(_req: NextRequest) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    // 10 calls / 10 min per user. Tagline drafts are cheap (256 maxOutput
    // tokens) but the user might iterate to find one they like; the cap is
    // there to bound a runaway loop, not to gate normal use.
    const rl = checkUserRateLimit(
        "profile:tagline-draft",
        userId,
        Date.now(),
        { max: 10, windowMs: 10 * 60 * 1000 },
    );
    if (!rl.ok) {
        return NextResponse.json(
            {
                error: `Too many tagline draft calls — try again in ${rl.retryAfterSec}s`,
                stage: "rate-limit",
            },
            { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
    }

    try {
        const result = await draftTagline({ userId });
        return NextResponse.json(
            { tagline: result.tagline, mode: result.mode },
            { status: 200 },
        );
    } catch (e) {
        console.warn(`[tagline-draft] error:`, e);
        if (e instanceof AIError) {
            return NextResponse.json(
                { error: "llm-error", detail: e.message, stage: "call", aiStage: e.stage },
                { status: 502 },
            );
        }
        const detail = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: "tagline-draft-failed", detail, stage: "call" },
            { status: 500 },
        );
    }
}
