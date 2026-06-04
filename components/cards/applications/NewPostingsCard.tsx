"use client";
import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ChevronDown, ExternalLink, EyeOff, Loader2, MapPin, Newspaper, BriefcaseBusiness, X, Search, AlertTriangle } from "lucide-react";
import { api, queryKeys, type PostingsListFilter } from "@/lib/api-client";
import { findDuplicateBoardGroups } from "@/lib/watchlists/duplicate-boards";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";
import { useAppStore, type PostingEmploymentType, type PostingFilters } from "@/components/providers/state";
import { Card } from "../../ui/Card";
import { FilterButton } from "../../ui/FilterButton";

// Story S5.9 — format parsed comp as "$120k–$150k / yr" style chip text.
// Returns null when no comp was parsed for this row so the caller can skip
// rendering the chip entirely.
function formatComp(p: {
    compensationMin: number | null;
    compensationMax: number | null;
    compensationCurrency: string | null;
    compensationCadence: string | null;
}): string | null {
    if (p.compensationMin === null || p.compensationMax === null) return null;
    const fmt = (n: number): string => {
        if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
        if (n >= 10_000) return `$${Math.round(n / 1_000)}k`;
        return `$${n.toLocaleString()}`;
    };
    const cadence = p.compensationCadence;
    // Default to year when cadence is null but value is plausibly annual —
    // mirrors the parser's plausibility bounds.
    const effectiveCadence = cadence ?? (p.compensationMin >= 20_000 ? 'year' : null);
    const cadenceSuffix = effectiveCadence === 'hour' ? '/hr'
        : effectiveCadence === 'day' ? '/day'
            : effectiveCadence === 'week' ? '/wk'
                : effectiveCadence === 'month' ? '/mo'
                    : effectiveCadence === 'year' ? '/yr'
                        : '';
    const value = p.compensationMin === p.compensationMax
        ? fmt(p.compensationMin)
        : `${fmt(p.compensationMin)}–${fmt(p.compensationMax)}`;
    return `${value}${cadenceSuffix}`;
}

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

const LIMIT = 200; // server caps at MAX_LIMIT=200 (app/api/postings/route.ts)
const PAGE_SIZE = 10;

const EMPLOYMENT_TYPE_CHIPS: ReadonlyArray<{ id: PostingEmploymentType; label: string }> = [
    { id: "full-time",   label: "Full-time" },
    { id: "internship",  label: "Internship" },
    { id: "contract",    label: "Contract" },
    { id: "part-time",   label: "Part-time" },
    { id: "temporary",   label: "Temporary" },
] as const;

// MB Phase 4. Per-track presentation. Title + icon are FIXED across tracks
// ("Postings" / newspaper) — only the COLOR diverges, so the track switch
// recolors the card instead of relabeling it.
const TRACK_PRESETS = {
    career: {
        title: "Postings",
        icon: Newspaper,
        iconColorClass: "text-cyan-300",
        // Top-right count subtitle, tinted to the track (see the `action` slot).
        subtitleClass: "text-cyan-300/80",
        subtitleMutedClass: "text-cyan-300/50",
    },
    side: {
        title: "Postings",
        icon: Newspaper,
        iconColorClass: "text-amber-300",
        subtitleClass: "text-amber-300/80",
        subtitleMutedClass: "text-amber-300/50",
    },
} as const;
type TrackKey = keyof typeof TRACK_PRESETS;

interface NewPostingsCardProps {
    /** MB Phase 4: defaults to "career" so existing call sites keep working. */
    track?: TrackKey;
}

export function NewPostingsCard({ track = "career" }: NewPostingsCardProps = {}) {
    const queryClient = useQueryClient();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [page, setPage] = useState(0);
    // The "Other matches" section (postings from LinkedIn keyword searches
    // whose employer isn't on the user's watchlist) defaults collapsed —
    // it's a long-tail discovery surface, not the main feed.
    const [offListOpen, setOffListOpen] = useState(false);
    // Client-side substring search over posting titles. The chip-based
    // company/type/location filters are server-side (query key + refetch);
    // title search is local because users iterate it quickly and the result
    // set is already bounded by LIMIT=200.
    const [titleSearch, setTitleSearch] = useState("");
    // MB Phase 4: per-track filter slice. Each card instance reads only its own
    // track's filters so toggling chips on the career card doesn't mirror onto
    // the side card (or vice versa). Setter takes `track` as the first arg.
    const postingFilters: PostingFilters = useAppStore(s => s.postingFilters[track])
        ?? { employmentTypes: [], remoteOnly: false, locations: [], includeUnspecified: false, companies: [], excludedCompanies: [] };
    const setPostingFiltersRaw = useAppStore(s => s.setPostingFilters);
    const setPostingFilters = useMemo(
        () => (next: PostingFilters) => setPostingFiltersRaw(track, next),
        [setPostingFiltersRaw, track],
    );

    // Build the server-side filter payload from the user's chip selections.
    // The query key includes this shape so React Query partitions the cache
    // per filter combination + refetches automatically on toggle.
    // MB Phase 4: track is part of the filter so each track's cache is
    // partitioned separately and the right postings feed renders per card.
    const listFilter: PostingsListFilter = useMemo(() => ({
        status: "new",
        limit: LIMIT,
        employmentType: postingFilters.employmentTypes,
        includeUnspecified: postingFilters.includeUnspecified,
        companies: postingFilters.companies,
        excludeCompanies: postingFilters.excludedCompanies,
        remoteOnly: postingFilters.remoteOnly,
        locations: postingFilters.locations,
        track,
    }), [postingFilters, track]);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.postings(listFilter),
        queryFn: () => api.postings.list(listFilter),
    });

    // Watchlists power the company-chip list — directory-bound, the user has
    // explicitly opted into watching these companies. LinkedIn watchlists are
    // generic keyword searches (often spanning many employers, e.g. "Intern")
    // so they're excluded; their resulting postings used to contribute extra
    // employer chips here, but with server-side filtering the postings array
    // reflects the current filter set, so deriving chips from it would shrink
    // the chip list as soon as you filtered. Trade-off accepted: LinkedIn
    // users filter by location / type, not employer.
    // MB Phase 4: scope chip-source watchlists to the current track so the
    // career card's company chips don't suggest side employers (and vice
    // versa). Career stays on the original key for cache-sharing with the
    // career WatchlistsCard; side gets a dedicated key matching the side
    // WatchlistsCard's scoping.
    const watchlistsKey = track === "career" ? queryKeys.watchlists : [...queryKeys.watchlists, "side"] as const;
    const { data: watchlistsData } = useQuery({
        queryKey: watchlistsKey,
        queryFn: () => api.watchlists.list({ track }),
    });

    useServerEvents("Posting", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
    });

    // Memoize so the partition useMemo below doesn't recompute on every
    // render — `data?.postings ?? []` returns a fresh `[]` ref each time
    // when data is undefined.
    const postings = useMemo(() => data?.postings ?? [], [data?.postings]);

    // Cross-device "hide this watchlist's postings" toggle (synced via
    // /api/settings), set by the eye button on each WatchlistsCard row. Drop
    // postings whose parent watchlist is
    // hidden before any partition/pagination so counts + paging reflect what's
    // actually shown. (Cross-watchlist dedup in /api/postings keeps the
    // freshest row per job, so a job that lives on both a hidden and a visible
    // watchlist is hidden only when its surviving row belongs to the hidden
    // one — acceptable for a discovery-feed convenience.)
    const hiddenWatchlistIds = useAppStore(s => s.hiddenWatchlistIds);
    const visiblePostings = useMemo(() => {
        if (hiddenWatchlistIds.length === 0) return postings;
        const hidden = new Set(hiddenWatchlistIds);
        return postings.filter(p => !hidden.has(p.watchlistId));
    }, [postings, hiddenWatchlistIds]);

    const companyOptions = useMemo(() => {
        const byKey = new Map<string, string>(); // lowercased → display
        for (const w of watchlistsData?.watchlists ?? []) {
            // Aggregator kinds carry a placeholder `companyName` on the
            // watchlist itself — the real per-card company is set on each
            // posting. Skip these so the filter dropdown doesn't list
            // "LinkedIn search" / "Indeed search" as faux companies.
            if (w.kind === "linkedin" || w.kind === "indeed") continue;
            const clean = (w.config.companyName ?? "").trim();
            if (!clean) continue;
            const key = clean.toLowerCase();
            if (!byKey.has(key)) byKey.set(key, clean);
        }
        return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
    }, [watchlistsData]);

    // Duplicate-board tripwire. We deliberately do NOT merge company badges (a
    // collapsed duplicate would hide the failure — the exact reason the
    // "Apex / Apex Space" bug went unnoticed). Instead we FLAG when two
    // watchlists target the same job board (same kind + slug) so a dedup
    // failure stays visible. The POST route now blocks creating a colliding
    // board, but a pre-existing dup / hand-edited row / directory flip could
    // still surface one — this is the in-app signal for that.
    const duplicateBoards = useMemo(
        () => findDuplicateBoardGroups((watchlistsData?.watchlists ?? []).map(w => w.config)),
        [watchlistsData],
    );

    // Auto-prune stale company selections (e.g. a watchlist was deleted while
    // its name was selected, or the suffix-cleanup migration retitled rows).
    // Render-time adjustment to match the page-reset pattern below. Only
    // fires when there's drift, and only once watchlists have loaded — an
    // empty companyOptions during initial load would wipe valid selections.
    if (postingFilters.companies.length > 0 && companyOptions.length > 0) {
        const validLower = new Set(companyOptions.map(c => c.toLowerCase()));
        const pruned = postingFilters.companies.filter(c => validLower.has(c.toLowerCase()));
        if (pruned.length !== postingFilters.companies.length) {
            setPostingFilters({ ...postingFilters, companies: pruned });
        }
    }

    const activeFilterCount =
        (postingFilters.employmentTypes.length > 0 ? 1 : 0) +
        (postingFilters.remoteOnly ? 1 : 0) +
        (postingFilters.locations.length > 0 ? 1 : 0) +
        (postingFilters.companies.length > 0 ? 1 : 0) +
        (postingFilters.excludedCompanies.length > 0 ? 1 : 0);

    // Partition into on-watchlist (matches a non-LinkedIn watchlist's
    // companyName) vs off-watchlist (everything else — typically employers
    // that surfaced from a LinkedIn keyword watchlist like "Intern" or
    // "software engineer"). Guarded by watchlists-loaded so we don't briefly
    // dump everything into "Other matches" on initial render before the
    // watchlists query resolves.
    //
    // When the user has NO company-based watchlists (typical for the side
    // track where everything is keyword-driven), the partition is meaningless
    // — every posting would land in "Other matches" while the main list shows
    // an "all matches are off-watchlist" hint. Short-circuit and treat all
    // postings as the main list in that case, so the keyword-only feed reads
    // cleanly without a forced "Other matches" detour.
    const watchlistsLoaded = watchlistsData !== undefined;
    const hasCompanyWatchlists = companyOptions.length > 0;
    const watchlistCompaniesLower = useMemo(
        () => new Set(companyOptions.map(c => c.toLowerCase())),
        [companyOptions],
    );
    const trimmedTitleSearch = titleSearch.trim().toLowerCase();
    const { onList, offList } = useMemo(() => {
        if (!watchlistsLoaded) return { onList: visiblePostings, offList: [] as typeof visiblePostings };
        if (!hasCompanyWatchlists) {
            // Keyword-only feed: skip partitioning entirely.
            const main = trimmedTitleSearch
                ? visiblePostings.filter(p => p.title.toLowerCase().includes(trimmedTitleSearch))
                : visiblePostings;
            return { onList: main, offList: [] as typeof visiblePostings };
        }
        const on: typeof visiblePostings = [];
        const off: typeof visiblePostings = [];
        for (const p of visiblePostings) {
            if (trimmedTitleSearch && !p.title.toLowerCase().includes(trimmedTitleSearch)) continue;
            if (watchlistCompaniesLower.has(p.company.toLowerCase())) on.push(p);
            else off.push(p);
        }
        return { onList: on, offList: off };
    }, [visiblePostings, watchlistCompaniesLower, watchlistsLoaded, hasCompanyWatchlists, trimmedTitleSearch]);

    // Bounce back to page 1 when filters change — toggling a chip on page 3 of
    // unfiltered results shouldn't land on an empty page 3 of the filtered slice.
    // Render-time adjustment (vs useEffect) matches the FiltersEditor pattern in
    // WatchlistsCard.tsx; postingFilters is a stable zustand ref so the compare
    // only flips when the filter actually changes.
    const [lastFilters, setLastFilters] = useState(postingFilters);
    const [lastSearch, setLastSearch] = useState(trimmedTitleSearch);
    if (lastFilters !== postingFilters || lastSearch !== trimmedTitleSearch) {
        setLastFilters(postingFilters);
        setLastSearch(trimmedTitleSearch);
        setPage(0);
    }

    // Pagination operates on the main (on-watchlist) list. Off-watchlist
    // matches surface separately below and aren't paginated — they're
    // typically a long tail of <20 items.
    const pageCount = Math.max(1, Math.ceil(onList.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageStart = safePage * PAGE_SIZE;
    const pagePostings = onList.slice(pageStart, pageStart + PAGE_SIZE);

    function toggleType(t: PostingEmploymentType) {
        const next = postingFilters.employmentTypes.includes(t)
            ? postingFilters.employmentTypes.filter(x => x !== t)
            : [...postingFilters.employmentTypes, t];
        setPostingFilters({ ...postingFilters, employmentTypes: next });
    }
    function toggleCompany(c: string) {
        const next = postingFilters.companies.includes(c)
            ? postingFilters.companies.filter(x => x !== c)
            : [...postingFilters.companies, c];
        setPostingFilters({ ...postingFilters, companies: next });
    }
    function resetFilters() {
        setPostingFilters({ employmentTypes: [], remoteOnly: false, locations: [], includeUnspecified: false, companies: [], excludedCompanies: [] });
    }

    async function trackAsApplication(id: string, title: string) {
        setBusyId(id);
        try {
            const result = await api.postings.trackAsApplication(id);
            const msg = result.created
                ? `Tracked "${title}" as a new application`
                : `Already tracked — opened existing application`;
            toastStore.push({ message: msg, type: "info" });
            queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
            queryClient.invalidateQueries({ queryKey: queryKeys.applications });
        } catch (e) {
            toastStore.push({ message: `Track failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    async function hide(id: string) {
        setBusyId(id);
        try {
            await api.postings.update(id, { status: "hidden" });
            queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
        } catch (e) {
            toastStore.push({ message: `Hide failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    const preset = TRACK_PRESETS[track];

    return (
        <Card
            title={preset.title}
            icon={preset.icon}
            iconColorClass={preset.iconColorClass}
            action={
                <div className="flex items-center gap-2">
                    <FilterButton
                        active={filtersOpen}
                        count={activeFilterCount}
                        onClick={() => setFiltersOpen(o => !o)}
                    />
                    <span className={`text-[11px] ${preset.subtitleClass} tabular-nums`}>
                        {onList.length}{postings.length === LIMIT ? "+" : ""} {activeFilterCount > 0 || trimmedTitleSearch ? "matching" : "new"}
                        {offList.length > 0 && (
                            <span className={`ml-1 ${preset.subtitleMutedClass}`}>· {offList.length} other</span>
                        )}
                    </span>
                </div>
            }
        >
            <div className="mb-3 relative shrink-0">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
                <input
                    type="text"
                    value={titleSearch}
                    onChange={e => setTitleSearch(e.target.value)}
                    placeholder="Search by job title…"
                    className="w-full pl-7 pr-7 py-1.5 rounded bg-black/30 border border-white/10 text-[12px] text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                />
                {titleSearch && (
                    <button
                        onClick={() => setTitleSearch("")}
                        title="Clear search"
                        aria-label="Clear search"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-white/40 hover:text-white/80"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {duplicateBoards.length > 0 && (
                <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-200/90 shrink-0">
                    <div className="flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                        <div>
                            <span className="font-semibold">
                                Possible duplicate watchlist{duplicateBoards.length > 1 ? "s" : ""}
                            </span>
                            {" — "}
                            {duplicateBoards.map((d, i) => (
                                <span key={d.key}>
                                    {i > 0 && "; "}
                                    {d.names.length > 1
                                        ? `“${d.names.join("” + “")}” point at the same board`
                                        : `“${d.names[0] ?? d.key}” has ${d.count} watchlists for one board`}
                                </span>
                            ))}
                            {". Badges aren’t merged — review in Watchlists."}
                        </div>
                    </div>
                </div>
            )}

            {filtersOpen && (
                <div className="mb-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2 flex flex-col gap-2 shrink-0">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-white/40">Employment type</span>
                        {activeFilterCount > 0 && (
                            <button
                                onClick={resetFilters}
                                className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80"
                            >
                                <X className="w-3 h-3" />
                                Clear
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {EMPLOYMENT_TYPE_CHIPS.map(({ id, label }) => {
                            const active = postingFilters.employmentTypes.includes(id);
                            return (
                                <button
                                    key={id}
                                    onClick={() => toggleType(id)}
                                    className={[
                                        "px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide font-semibold transition-colors",
                                        active
                                            ? "bg-cyan-500/30 text-cyan-100 border border-cyan-400/40"
                                            : "bg-black/40 text-white/40 border border-white/10 hover:text-white/70",
                                    ].join(" ")}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                    {companyOptions.length > 0 && (
                        <>
                            <div className="flex items-center justify-between pt-1">
                                <span className="text-[10px] uppercase tracking-wide text-white/40">Company</span>
                                {postingFilters.companies.length > 0 && (
                                    <button
                                        onClick={() => setPostingFilters({ ...postingFilters, companies: [] })}
                                        className="text-[10px] text-white/40 hover:text-white/80"
                                    >
                                        All
                                    </button>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {companyOptions.map(c => {
                                    const active = postingFilters.companies.includes(c);
                                    return (
                                        <button
                                            key={c}
                                            onClick={() => toggleCompany(c)}
                                            className={[
                                                "px-2 py-0.5 rounded-full text-[10px] font-semibold transition-colors",
                                                active
                                                    ? "bg-cyan-500/30 text-cyan-100 border border-cyan-400/40"
                                                    : "bg-black/40 text-white/40 border border-white/10 hover:text-white/70",
                                            ].join(" ")}
                                        >
                                            {c}
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                    <div className="flex items-center gap-3 flex-wrap pt-1">
                        <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={postingFilters.remoteOnly}
                                onChange={(e) => setPostingFilters({ ...postingFilters, remoteOnly: e.target.checked })}
                                className="accent-cyan-400"
                            />
                            Remote only
                        </label>
                        {postingFilters.employmentTypes.length > 0 && (
                            <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer" title="Postings where we couldn't classify the type are excluded.">
                                <input
                                    type="checkbox"
                                    checked={postingFilters.includeUnspecified}
                                    onChange={(e) => setPostingFilters({ ...postingFilters, includeUnspecified: e.target.checked })}
                                    className="accent-cyan-400"
                                />
                                Include unclassified
                            </label>
                        )}
                    </div>
                    <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] uppercase tracking-wide text-white/40">Location</span>
                        {postingFilters.locations.length > 0 && (
                            <button
                                onClick={() => setPostingFilters({ ...postingFilters, locations: [] })}
                                className="text-[10px] text-white/40 hover:text-white/80"
                            >
                                All
                            </button>
                        )}
                    </div>
                    <ChipTextEditor
                        values={postingFilters.locations}
                        onChange={(next) => setPostingFilters({ ...postingFilters, locations: next })}
                        theme="cyan"
                        placeholder="e.g. New York, Remote, United Kingdom"
                    />
                    <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] uppercase tracking-wide text-white/40">Excluded companies</span>
                        {postingFilters.excludedCompanies.length > 0 && (
                            <button
                                onClick={() => setPostingFilters({ ...postingFilters, excludedCompanies: [] })}
                                className="text-[10px] text-white/40 hover:text-white/80"
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <ChipTextEditor
                        values={postingFilters.excludedCompanies}
                        onChange={(next) => setPostingFilters({ ...postingFilters, excludedCompanies: next })}
                        theme="rose"
                        placeholder="e.g. Lockheed, Northrop — substring match, case-insensitive"
                    />
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-6 text-white/40">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </div>
            ) : onList.length === 0 && offList.length === 0 ? (
                postings.length > 0 && visiblePostings.length === 0 ? (
                    <p className="text-xs text-white/40 italic">
                        All matching postings are from hidden watchlists. Click a watchlist&apos;s eye in{" "}
                        Watchlists to show them again.
                    </p>
                ) : activeFilterCount > 0 || trimmedTitleSearch ? (
                    <p className="text-xs text-white/40 italic">
                        No new postings match your {trimmedTitleSearch && activeFilterCount > 0 ? "search and filters" : trimmedTitleSearch ? "search" : "filters"}.{" "}
                        <button
                            onClick={() => { setTitleSearch(""); resetFilters(); }}
                            className="underline text-cyan-300/80 hover:text-cyan-200"
                        >
                            Clear
                        </button>
                    </p>
                ) : (
                    <p className="text-xs text-white/40 italic">No new postings. Run a watchlist or wait for the scheduler tick.</p>
                )
            ) : onList.length === 0 ? (
                // All matches are off-watchlist — show a hint instead of an
                // empty main list so the user understands the "Other matches"
                // section below is where the action is.
                <p className="text-xs text-white/40 italic">
                    No matches from your watchlisted companies. See &quot;Other matches&quot; below.
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {pagePostings.map(p => (
                        <PostingRow
                            key={p.id}
                            p={p}
                            busy={busyId === p.id}
                            onTrack={trackAsApplication}
                            onHide={hide}
                        />
                    ))}
                </ul>
            )}

            {!isLoading && pageCount > 1 && onList.length > 0 && (
                <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between shrink-0">
                    <button
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={safePage === 0}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/60 hover:text-white/90 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        <ChevronLeft className="w-3.5 h-3.5" />
                        Prev
                    </button>
                    <span className="text-[11px] text-white/40 tabular-nums">
                        {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, onList.length)} of {onList.length} · page {safePage + 1}/{pageCount}
                    </span>
                    <button
                        onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                        disabled={safePage >= pageCount - 1}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/60 hover:text-white/90 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        Next
                        <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {!isLoading && offList.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/5">
                    <button
                        onClick={() => setOffListOpen(o => !o)}
                        aria-pressed={offListOpen}
                        className="flex items-center gap-1.5 text-[11px] text-white/60 hover:text-white/90"
                    >
                        {offListOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        <span className="font-semibold">Other matches</span>
                        <span className="text-white/40 tabular-nums">({offList.length})</span>
                    </button>
                    <p className="text-[10px] text-white/30 mt-1 leading-tight">
                        Companies not on your watchlist — surfaced by LinkedIn keyword searches.
                        Track interesting ones as applications or add them via &quot;Add watchlist&quot;.
                    </p>
                    {offListOpen && (
                        <ul className="space-y-1.5 mt-2">
                            {offList.map(p => (
                                <PostingRow
                                    key={p.id}
                                    p={p}
                                    busy={busyId === p.id}
                                    onTrack={trackAsApplication}
                                    onHide={hide}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </Card>
    );
}

type Posting = NonNullable<Awaited<ReturnType<typeof api.postings.list>>["postings"]>[number];

function PostingRow({
    p,
    busy,
    onTrack,
    onHide,
}: {
    p: Posting;
    busy: boolean;
    onTrack: (id: string, title: string) => void;
    onHide: (id: string) => void;
}) {
    return (
        <li className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 hover:border-white/20 transition-colors">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-[11px] uppercase tracking-wide text-cyan-300/80">{p.company}</span>
                        <a
                            href={p.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-white/40 hover:text-white/80"
                            title="Open source"
                        >
                            <ExternalLink className="w-3 h-3" />
                        </a>
                    </div>
                    <div className="text-sm text-white/90 truncate mt-0.5">{p.title}</div>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                        {p.location && (
                            <div className="text-[11px] text-white/40 flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {p.location}
                            </div>
                        )}
                        {p.employmentType && (
                            <span className="text-[10px] uppercase tracking-wide text-white/50 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded">
                                {p.employmentType.replace("-", " ")}
                            </span>
                        )}
                        {formatComp(p) && (
                            <span className="text-[10px] uppercase tracking-wide text-emerald-200/90 bg-emerald-500/10 border border-emerald-400/30 px-1.5 py-0.5 rounded">
                                {formatComp(p)}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={() => onTrack(p.id, p.title)}
                        disabled={busy}
                        title="Create an application from this posting"
                        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 disabled:opacity-40"
                    >
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <BriefcaseBusiness className="w-3 h-3" />}
                        Track as App
                    </button>
                    <button
                        onClick={() => onHide(p.id)}
                        disabled={busy}
                        title="Hide this posting"
                        className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 disabled:opacity-40"
                    >
                        <EyeOff className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </li>
    );
}

const MAX_CHIPS = 20;
const MAX_CHIP_LEN = 80;

const CHIP_THEMES = {
    cyan: {
        chip: "bg-cyan-500/20 text-cyan-100 border-cyan-400/40",
        chipX: "text-cyan-100/70 hover:text-cyan-50",
        inputFocus: "focus:border-cyan-400/40",
    },
    rose: {
        chip: "bg-rose-500/20 text-rose-100 border-rose-400/40 line-through decoration-rose-200/40",
        chipX: "text-rose-100/70 hover:text-rose-50",
        inputFocus: "focus:border-rose-400/40",
    },
} as const;

/**
 * Chip-based string filter — comma/Enter commits, Backspace on empty input
 * pops the last chip, blur commits any unsubmitted text. No regex; values
 * are literal substrings matched server-side. Theme controls semantics:
 * `cyan` for inclusive filters, `rose` (with strikethrough) for exclusion.
 */
function ChipTextEditor({
    values,
    onChange,
    theme,
    placeholder,
}: {
    values: readonly string[];
    onChange: (next: string[]) => void;
    theme: keyof typeof CHIP_THEMES;
    placeholder: string;
}) {
    const [input, setInput] = useState("");
    const t = CHIP_THEMES[theme];

    function commit() {
        const trimmed = input.trim();
        if (!trimmed) return;
        const parts = trimmed.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 0) {
            setInput("");
            return;
        }
        const existingLower = new Set(values.map(v => v.toLowerCase()));
        const additions: string[] = [];
        for (const p of parts) {
            if (p.length > MAX_CHIP_LEN) continue;
            const lower = p.toLowerCase();
            if (existingLower.has(lower)) continue;
            existingLower.add(lower);
            additions.push(p);
        }
        setInput("");
        if (additions.length === 0) return;
        const next = [...values, ...additions].slice(0, MAX_CHIPS);
        onChange(next);
    }

    function remove(chip: string) {
        onChange(values.filter(v => v !== chip));
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {values.map(v => (
                <span
                    key={v}
                    className={`group inline-flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${t.chip}`}
                >
                    <span>{v}</span>
                    <button
                        onClick={() => remove(v)}
                        title={`Remove "${v}"`}
                        aria-label={`Remove ${v}`}
                        className={`opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ${t.chipX}`}
                    >
                        <X className="w-2.5 h-2.5" />
                    </button>
                </span>
            ))}
            <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                    if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        commit();
                    } else if (e.key === "Backspace" && input === "" && values.length > 0) {
                        e.preventDefault();
                        remove(values[values.length - 1]);
                    }
                }}
                onBlur={commit}
                placeholder={values.length === 0 ? placeholder : "add another…"}
                disabled={values.length >= MAX_CHIPS}
                className={`flex-1 min-w-[8rem] px-2 py-1 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none disabled:opacity-50 ${t.inputFocus}`}
            />
        </div>
    );
}
