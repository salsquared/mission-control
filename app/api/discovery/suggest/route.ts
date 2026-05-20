import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { cachedValue } from "@/lib/cache";
import { COMPANY_DIRECTORY, DIRECTORY_TAGS, type DirectoryTag } from "@/lib/company-directory";
import { suggestCompanies, type SuggestResult } from "@/lib/discovery/suggest";
import { listBlacklist } from "@/lib/repositories/blacklist";

// 6h is long enough that idle browsing doesn't burn quota, short enough that
// a paid-tier user gets fresh suggestions within a workday. The exclude hash
// changes whenever the user adds a watchlist OR clicks "More" (which extends
// additionalExclude client-side), so stale data is self-limiting in practice.
const CACHE_TTL_SECONDS = 6 * 60 * 60;
// Bump if the request → response shape changes — old entries become poison.
const CACHE_VERSION = "v1";

export const runtime = "nodejs";

const RequestSchema = z.object({
    topic: z.string().min(1).max(64),
    /** Names the UI has already shown the user this session — pass back on
     * "Refresh suggestions" so Gemini keeps digging instead of looping. */
    additionalExclude: z.array(z.string()).optional().default([]),
});

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function isDirectoryTag(s: string): s is DirectoryTag {
    return (DIRECTORY_TAGS as readonly string[]).includes(s);
}

// Pull `companyName` out of a watchlist's stored config JSON. The column is
// loosely-typed text — return null on any parse trouble so a single bad row
// doesn't block the whole suggest call.
function extractCompanyName(configJson: string): string | null {
    try {
        const parsed = JSON.parse(configJson) as { companyName?: unknown };
        return typeof parsed.companyName === "string" ? parsed.companyName : null;
    } catch {
        return null;
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) {
        return NextResponse.json({ error: "Session missing userId" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: `Invalid request: ${parsed.error.issues.map(i => i.message).join("; ")}` },
            { status: 400 },
        );
    }
    const { topic, additionalExclude } = parsed.data;

    // Build the exclude list — three sources, deduped case-insensitively:
    //   1. COMPANY_DIRECTORY entries whose tag matches the topic (if topic is
    //      a known tag). Catches the "already in the picker" case before
    //      Gemini wastes a slot on them.
    //   2. The user's existing watchlists' companyName fields. Catches
    //      ad-hoc watchlists the user added via Advanced mode.
    //   3. Caller-supplied (UI accumulates prior suggestions across clicks).
    const fromDirectory = isDirectoryTag(topic.toLowerCase())
        ? COMPANY_DIRECTORY
            .filter(e => e.tags.includes(topic.toLowerCase() as DirectoryTag))
            .map(e => e.name)
        : [];
    const watchlistRows = await prisma.watchlist.findMany({
        where: { userId },
        select: { config: true },
    });
    const fromWatchlists = watchlistRows
        .map(w => extractCompanyName(w.config))
        .filter((n): n is string => Boolean(n));
    // User-curated blacklist — companies the user explicitly opted out of.
    // Feeding these to Gemini's exclude list (rather than just filtering on
    // the way back) stops the model from burning candidate slots on names
    // we'd discard anyway.
    const blacklistRows = await listBlacklist(userId);
    const fromBlacklist = blacklistRows.map(b => b.name);
    const exclude = Array.from(new Set([
        ...fromDirectory,
        ...fromWatchlists,
        ...fromBlacklist,
        ...additionalExclude,
    ]));

    // Cache key. Topic is normalized so "Space" and "space" share an entry.
    // Exclude is sorted + hashed so the key is stable regardless of input
    // ordering and short regardless of exclude length.
    const excludeHash = createHash("sha1")
        .update([...exclude].sort().join("\n").toLowerCase())
        .digest("hex")
        .slice(0, 12);
    const cacheKey = `discovery:suggest:${CACHE_VERSION}:${userId}:${topic.toLowerCase()}:${excludeHash}`;

    try {
        const result = await cachedValue<SuggestResult>(
            cacheKey,
            CACHE_TTL_SECONDS,
            () => suggestCompanies({ topic, exclude }),
        );
        return NextResponse.json(result);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[discovery/suggest] failed for topic="${topic}":`, msg);

        // Categorize Gemini quota errors so the UI can show a useful message
        // instead of a wall of JSON. Free tier is 20 requests/day per project
        // per model — easy to burn when the job-watcher classifier is also
        // running. Extract the retry-after window from Gemini's payload when
        // available so we can tell the user when to come back.
        if (/RESOURCE_EXHAUSTED|quota|\b429\b/i.test(msg)) {
            const retryMatch = /retry in (\d+(?:\.\d+)?)s/i.exec(msg);
            const retryHint = retryMatch
                ? ` Try again in ~${Math.ceil(Number(retryMatch[1]))}s.`
                : " Try again tomorrow, upgrade your Gemini billing, or pause the job-watcher.";
            return NextResponse.json({
                error: `Gemini daily quota exhausted (free tier: 20 requests/day).${retryHint}`,
                code: "QUOTA_EXHAUSTED",
            }, { status: 429 });
        }
        return NextResponse.json({ error: `Suggest failed: ${msg}` }, { status: 502 });
    }
}
