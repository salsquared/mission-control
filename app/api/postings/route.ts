import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { JobPostingStatusSchema, EMPLOYMENT_TYPE_VALUES, WatchlistTrackSchema } from "@/lib/schemas/watchlists";
import { compileNegativeFilters, compileNegativeFiltersFromArray, matchesNegativeFilters } from "@/lib/postings/negative-filters";
import { expandLocationFilters } from "@/lib/postings/location-expansion";
import { postingDedupKey } from "@/lib/postings/dedup-key";
import { findGlobalSetting, parseGlobalSetting } from "@/lib/repositories/settings";

export const runtime = "nodejs";

// Same set the client filter regex used to express "is this a remote role?".
// Kept here as plain substrings so we can push the OR clause to SQLite via
// Prisma — SQLite's LIKE is ASCII-case-insensitive by default, so no `mode`
// option is needed.
const REMOTE_LOCATION_NEEDLES = ["remote", "anywhere", "work from home", "wfh"] as const;

const EMPLOYMENT_TYPE_SET = new Set<string>(EMPLOYMENT_TYPE_VALUES);

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function serialize(p: {
    id: string; watchlistId: string; externalId: string; company: string;
    title: string; location: string | null; postedAt: Date | null; snippet: string | null;
    sourceUrl: string; employmentType: string | null;
    compensationMin: number | null; compensationMax: number | null;
    compensationCurrency: string | null; compensationCadence: string | null;
    status: string;
    firstSeenAt: Date; lastSeenAt: Date; removedAt: Date | null;
}) {
    return {
        id: p.id,
        watchlistId: p.watchlistId,
        externalId: p.externalId,
        company: p.company,
        title: p.title,
        location: p.location,
        postedAt: p.postedAt?.toISOString() ?? null,
        snippet: p.snippet,
        sourceUrl: p.sourceUrl,
        employmentType: p.employmentType,
        compensationMin: p.compensationMin,
        compensationMax: p.compensationMax,
        compensationCurrency: p.compensationCurrency,
        compensationCadence: p.compensationCadence,
        status: p.status,
        firstSeenAt: p.firstSeenAt.toISOString(),
        lastSeenAt: p.lastSeenAt.toISOString(),
        removedAt: p.removedAt?.toISOString() ?? null,
    };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const watchlistId = url.searchParams.get("watchlistId");
    const includeFiltered = url.searchParams.get("includeFiltered") === "true";
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LIMIT) : DEFAULT_LIMIT;

    // Filter params — all CSV / boolean / substring. Pushed server-side
    // because the client used to truncate the response to MAX_LIMIT before
    // its filter pass ran, and rows past that cutoff became unreachable as
    // the corpus grew (see NewPostingsCard for the prior client logic).
    const employmentTypesRaw = url.searchParams.get("employmentType");
    const employmentTypes = employmentTypesRaw
        ? employmentTypesRaw.split(",").map(s => s.trim()).filter(s => EMPLOYMENT_TYPE_SET.has(s))
        : [];
    const includeUnspecified = url.searchParams.get("includeUnspecified") === "true";
    const companiesRaw = url.searchParams.get("companies");
    const companies = companiesRaw
        ? companiesRaw.split(",").map(s => s.trim()).filter(Boolean)
        : [];
    const excludeCompaniesRaw = url.searchParams.get("excludeCompanies");
    const excludeCompanies = excludeCompaniesRaw
        ? excludeCompaniesRaw.split(",").map(s => s.trim()).filter(Boolean)
        : [];
    const remoteOnly = url.searchParams.get("remoteOnly") === "true";
    const locationsRaw = url.searchParams.get("locations");
    const locations = locationsRaw
        ? locationsRaw.split(",").map(s => s.trim()).filter(Boolean)
        : [];

    // MB Phase 4: optional ?track=career|side filter joins through to the
    // parent watchlist. Unrecognized values fall through to "all" rather than
    // 400 (matches the lenient ?status= handling below — we silently ignore
    // unknown values there too).
    const trackParam = url.searchParams.get("track");
    const trackFilter = trackParam ? WatchlistTrackSchema.safeParse(trackParam) : null;
    const watchlistMatch: { userId: string; track?: string } = { userId };
    if (trackFilter?.success) watchlistMatch.track = trackFilter.data;

    // Each clause is independently AND-combined. Doing it as an array keeps
    // the per-filter OR groups (employmentType ∪ null, remoteOnly's keyword
    // list) from colliding with each other.
    const conditions: Record<string, unknown>[] = [{ watchlist: watchlistMatch }];
    if (statusParam) {
        const s = JobPostingStatusSchema.safeParse(statusParam);
        if (!s.success) return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
        conditions.push({ status: s.data });
    }
    if (watchlistId) {
        // ownership of the watchlist is enforced transitively by the user join above
        conditions.push({ watchlistId });
    }
    if (employmentTypes.length > 0) {
        conditions.push(
            includeUnspecified
                ? { OR: [{ employmentType: { in: employmentTypes } }, { employmentType: null }] }
                : { employmentType: { in: employmentTypes } },
        );
    }
    if (companies.length > 0) {
        conditions.push({ company: { in: companies } });
    }
    if (excludeCompanies.length > 0) {
        // Substring exclusion (case-insensitive — SQLite LIKE is ASCII-CI by
        // default) so "lockheed" catches "Lockheed Martin" without the user
        // having to type the exact display string. Each chip becomes a NOT
        // LIKE — AND'd together so excluding multiple companies subtracts each.
        conditions.push({
            AND: excludeCompanies.map(n => ({ NOT: { company: { contains: n } } })),
        });
    }
    if (remoteOnly) {
        conditions.push({
            OR: REMOTE_LOCATION_NEEDLES.map(n => ({ location: { contains: n } })),
        });
    }
    if (locations.length > 0) {
        // Each chip expands through lib/postings/location-expansion.ts —
        // "Los Angeles" becomes the metro city list, "United States" becomes
        // ", AL"/", AK"/... state-code suffixes, etc. Unknown chips fall
        // through to literal substring match.
        const needles = expandLocationFilters(locations);
        conditions.push({
            OR: needles.map(n => ({ location: { contains: n } })),
        });
    }

    const where = { AND: conditions };

    try {
        // Pull a bit extra so negative-filter culling doesn't routinely starve
        // the page. Capped at MAX_LIMIT * 2 to keep this bounded.
        const fetchTake = includeFiltered
            ? limit
            : Math.min(MAX_LIMIT * 2, limit * 2);
        const [rows, globalSettingRow] = await Promise.all([
            prisma.jobPosting.findMany({
                where,
                orderBy: { lastSeenAt: "desc" },
                take: fetchTake,
                include: { watchlist: { select: { negativeFilters: true } } },
            }),
            includeFiltered ? Promise.resolve(null) : findGlobalSetting(),
        ]);

        const globalRegexes = compileNegativeFiltersFromArray(
            globalSettingRow ? parseGlobalSetting(globalSettingRow).negativeFilters : [],
        );

        const filtered = includeFiltered
            ? rows
            : rows.filter(r => {
                if (globalRegexes.length > 0 && matchesNegativeFilters(r, globalRegexes)) return false;
                const perWatchlist = compileNegativeFilters(r.watchlist.negativeFilters);
                return !matchesNegativeFilters(r, perWatchlist);
            });

        // Cross-watchlist dedup. JobPosting's unique key is per-watchlist
        // (@@unique([watchlistId, externalId])), so N overlapping watchlists
        // each store their own row for the SAME underlying job. Subsets stack:
        // a side-track "security officer — Downey, CA" ⊂ "— Los Angeles" ⊂
        // "— California" all match one LA job → three rows. The scheduler can't
        // dedup these: its existence check is scoped to one watchlist. Collapse
        // here — a Set keep-first, so it's N-way, not pairwise — and the feed
        // shows each job once. We key on postingDedupKey (normalizedCompany +
        // normalizedRole), NOT externalId: externalId folds sourceUrl into the
        // hash, so the same job reposted under a new URL would slip through as
        // a fresh row. The normalized key is resistant to URL/title drift while
        // staying narrow enough not to merge genuine multi-role postings. Rows
        // arrive lastSeenAt-desc, so the first occurrence is the freshest; keep
        // it.
        const deduped: typeof filtered = [];
        const seenKeys = new Set<string>();
        for (const r of filtered) {
            const key = postingDedupKey(r.company, r.title);
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            deduped.push(r);
        }

        return NextResponse.json({
            postings: deduped.slice(0, limit).map(serialize),
        }, { status: 200 });
    } catch (e) {
        console.error("[postings GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
