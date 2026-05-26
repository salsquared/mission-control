"use client";
import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, Pause, Play, Plus, RefreshCw, Trash2, AlertCircle, Filter, ChevronRight, ChevronLeft, Bell, BellOff, Layers, X, Search, Briefcase, Pencil, Sparkles } from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";
import { useAppStore } from "../providers/state";
import { AddWatchlistModal } from "../overlays/AddWatchlistModal";
import { EditFindRolesModal } from "../overlays/EditFindRolesModal";
import { Card } from "../ui/Card";
import { FilterButton } from "../ui/FilterButton";
import type { WatchlistWire } from "@/lib/schemas/watchlists";
import { normalizeNegativeFilterForDedup } from "@/lib/postings/negative-filters";
import {
    groupWatchlists,
    groupTitle,
    rowItemMatchesSearch,
    type FindRolesGroup,
} from "@/lib/watchlists/find-roles-grouping";

// MB Phase 4. Per-track presentation. Crawl mechanism is identical between
// tracks (same fetcher fleet, same schedule loop) — only the surfaces differ.
const TRACK_PRESETS = {
    career: {
        title: "Watchlists",
        icon: Eye,
        iconColorClass: "text-cyan-300",
        addBtnClass: "bg-cyan-500/20 hover:bg-cyan-500/30 border-cyan-400/30 text-cyan-100",
        emptyText: "No watchlists yet. Add one above to start hunting on your behalf.",
    },
    side: {
        title: "Side Watchlists",
        icon: Briefcase,
        iconColorClass: "text-amber-300",
        addBtnClass: "bg-amber-500/20 hover:bg-amber-500/30 border-amber-400/30 text-amber-100",
        emptyText: "No side watchlists. Add a keyword search (e.g. \"warehouse Los Angeles\") to find gig listings.",
    },
} as const;
type TrackKey = keyof typeof TRACK_PRESETS;

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function fmtRelative(iso: string | null): string {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
    return `${Math.floor(ms / 86400_000)}d ago`;
}

/**
 * "next run in 3h 12m" — based on (lastRunAt + scheduleMinutes). Returns
 * "queued — runs shortly" when the watchlist has never run yet (post-create
 * auto-run is in flight, or the next scheduler tick will pick it up).
 * Returns "due now" if we're past the scheduled moment but the scheduler
 * hasn't caught up.
 */
function fmtNextRun(lastRunAtIso: string | null, scheduleMinutes: number): string {
    if (!lastRunAtIso) return "queued — runs shortly";
    const nextMs = new Date(lastRunAtIso).getTime() + scheduleMinutes * 60_000;
    const dt = nextMs - Date.now();
    if (dt <= 0) return "due now";
    if (dt < 60_000) return "next run in <1m";
    const totalMin = Math.floor(dt / 60_000);
    if (totalMin < 60) return `next run in ${totalMin}m`;
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    return minutes === 0
        ? `next run in ${hours}h`
        : `next run in ${hours}h ${minutes}m`;
}

function fmtSchedule(scheduleMinutes: number): string {
    if (scheduleMinutes < 60) return `every ${scheduleMinutes}m`;
    const hours = Math.floor(scheduleMinutes / 60);
    const minutes = scheduleMinutes % 60;
    return minutes === 0 ? `every ${hours}h` : `every ${hours}h ${minutes}m`;
}

const PAGE_SIZE = 12;

interface WatchlistsCardProps {
    /** MB Phase 4: defaults to "career" so existing call sites keep working. */
    track?: TrackKey;
}

export function WatchlistsCard({ track = "career" }: WatchlistsCardProps = {}) {
    const queryClient = useQueryClient();
    const preset = TRACK_PRESETS[track];
    const [adding, setAdding] = useState(false);
    // Set, not single string, because find-roles group actions fan out across
    // N member watchlists — every member should look busy while the batch is
    // in flight. Helpers below mark/unmark in bulk.
    const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
    const isBusy = (id: string) => busyIds.has(id);
    const beginBusy = (ids: string[]) => setBusyIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
    });
    const endBusy = (ids: string[]) => setBusyIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
    });
    const [editingGroup, setEditingGroup] = useState<FindRolesGroup | null>(null);
    const [page, setPage] = useState(0);
    const [search, setSearch] = useState("");
    // Global negative filters: dropdown open state lives here so the
    // trigger button in `action` controls it (parity with NewPostingsCard's
    // Filters dropdown). The chip editor itself is `GlobalNegativeFiltersEditor`
    // below, rendered conditionally on this flag. Both the career and side
    // cards edit the same shared list.
    const [filtersOpen, setFiltersOpen] = useState(false);
    const filterCount = useAppStore(s => s.negativeFilters?.length ?? 0);

    // MB Phase 4: per-track cache scoping. Career uses the original key
    // [queryKeys.watchlists] so existing useServerEvents listeners + manual
    // invalidations elsewhere in the app keep hitting it; side gets a
    // dedicated key. SSE invalidation below invalidates by predicate so a
    // single Watchlist event from the server refreshes both lists.
    const queryKey = track === "career" ? queryKeys.watchlists : [...queryKeys.watchlists, "side"] as const;

    const { data, isLoading } = useQuery({
        queryKey,
        queryFn: () => api.watchlists.list({ track }),
    });

    useServerEvents("Watchlist", () => {
        queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "watchlists",
        });
    });

    const watchlists = data?.watchlists ?? [];

    // Group linkedin + indeed watchlists with the same keywords/location/track
    // into a single "Find Roles search" row. Other kinds always render as
    // their own row. See lib/watchlists/find-roles-grouping.ts.
    const rowItems = useMemo(() => groupWatchlists(watchlists), [watchlists]);

    // Client-side name search. Filters by group title (for groups) or
    // watchlist name (for singles). Order of operations: group first, then
    // filter — so a group's title can match even when no single underlying
    // name does.
    const trimmedSearch = search.trim().toLowerCase();
    const filteredItems = useMemo(() => {
        if (!trimmedSearch) return rowItems;
        return rowItems.filter(item => rowItemMatchesSearch(item, trimmedSearch));
    }, [rowItems, trimmedSearch]);

    // Reset to page 0 when the search narrows the list so an in-progress query
    // doesn't land on an empty page. Render-time adjustment matches the
    // pattern in NewPostingsCard.tsx.
    const [lastSearch, setLastSearch] = useState(trimmedSearch);
    if (lastSearch !== trimmedSearch) {
        setLastSearch(trimmedSearch);
        setPage(0);
    }

    // Pagination — over GROUP/ROW items (each group counts as 1 row regardless
    // of how many underlying watchlists it owns). safePage clamps the live
    // `page` against the current count.
    const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageStart = safePage * PAGE_SIZE;
    const pageItems = filteredItems.slice(pageStart, pageStart + PAGE_SIZE);

    // MB Phase 4: predicate-based invalidation. A watchlist mutation in
    // either track is interesting to both lists (e.g. you might rename a
    // career row), and postings keys vary by filter so we can't enumerate
    // them — predicate match by prefix covers both bases.
    const invalidateWatchlists = () =>
        queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "watchlists",
        });
    const invalidatePostings = () =>
        queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "postings",
        });

    async function runNow(id: string) {
        beginBusy([id]);
        try {
            // `api.watchlists.run` throws on non-2xx (the route returns 502 when
            // the fetcher errors), so reaching this point means success.
            const result = await api.watchlists.run(id);
            toastStore.push({
                message: `Run complete — ${result.newPostings} new, ${result.seenAgain} seen-again`,
                type: "info",
            });
            invalidateWatchlists();
            invalidatePostings();
            queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
        } catch (e) {
            toastStore.push({ message: `Run failed: ${errMessage(e)}`, type: "error" });
        } finally {
            endBusy([id]);
        }
    }

    async function togglePause(id: string, currentlyActive: boolean) {
        beginBusy([id]);
        try {
            await api.watchlists.update(id, { active: !currentlyActive });
            invalidateWatchlists();
        } catch (e) {
            toastStore.push({ message: `Pause toggle failed: ${errMessage(e)}`, type: "error" });
        } finally {
            endBusy([id]);
        }
    }

    async function setNotificationMode(id: string, mode: "each" | "digest" | "silent") {
        beginBusy([id]);
        try {
            await api.watchlists.update(id, { notificationMode: mode });
            invalidateWatchlists();
        } catch (e) {
            toastStore.push({ message: `Notification mode change failed: ${errMessage(e)}`, type: "error" });
        } finally {
            endBusy([id]);
        }
    }

    async function saveNegativeFilters(id: string, patterns: string[]) {
        beginBusy([id]);
        try {
            await api.watchlists.update(id, { negativeFilters: patterns });
            toastStore.push({
                message: patterns.length === 0
                    ? "Filters cleared"
                    : `Saved ${patterns.length} filter${patterns.length === 1 ? "" : "s"}`,
                type: "info",
            });
            invalidateWatchlists();
            invalidatePostings();
        } catch (e) {
            toastStore.push({ message: `Filter save failed: ${errMessage(e)}`, type: "error" });
        } finally {
            endBusy([id]);
        }
    }

    async function remove(id: string, name: string) {
        if (!window.confirm(`Delete watchlist "${name}" and all its postings?`)) return;
        beginBusy([id]);
        try {
            await api.watchlists.delete(id);
            toastStore.push({ message: `Deleted: ${name}`, type: "info" });
            invalidateWatchlists();
            invalidatePostings();
        } catch (e) {
            toastStore.push({ message: `Delete failed: ${errMessage(e)}`, type: "error" });
        } finally {
            endBusy([id]);
        }
    }

    // ─── Group fan-out actions ───
    // Every action below operates on the full member set. We mark all members
    // busy up front, settle all the ops, then clear busy in `finally`.
    async function runGroup(group: FindRolesGroup) {
        const ids = group.members.map(m => m.id);
        beginBusy(ids);
        try {
            const results = await Promise.allSettled(group.members.map(m => api.watchlists.run(m.id)));
            let totalNew = 0;
            let totalSeen = 0;
            const failures: string[] = [];
            results.forEach((r, i) => {
                if (r.status === "fulfilled") {
                    totalNew += r.value.newPostings;
                    totalSeen += r.value.seenAgain;
                } else {
                    failures.push(group.members[i].kind);
                }
            });
            if (failures.length === 0) {
                toastStore.push({
                    message: `Run complete — ${totalNew} new, ${totalSeen} seen-again across ${group.members.length} source${group.members.length === 1 ? "" : "s"}`,
                    type: "info",
                });
            } else {
                toastStore.push({
                    message: `${results.length - failures.length}/${results.length} sources ran; ${failures.join(", ")} failed`,
                    type: "error",
                });
            }
            invalidateWatchlists();
            invalidatePostings();
            queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
        } finally {
            endBusy(ids);
        }
    }

    async function pauseGroup(group: FindRolesGroup, nextActive: boolean) {
        const ids = group.members.map(m => m.id);
        beginBusy(ids);
        try {
            await Promise.allSettled(group.members.map(m =>
                api.watchlists.update(m.id, { active: nextActive }),
            ));
            invalidateWatchlists();
        } finally {
            endBusy(ids);
        }
    }

    async function removeGroup(group: FindRolesGroup) {
        const title = groupTitle(group);
        const n = group.members.length;
        const sourceLabels = group.members.map(m => (m.kind === "linkedin" ? "LinkedIn" : "Indeed")).join(" + ");
        if (!window.confirm(`Delete the "${title}" Find Roles search? Removes ${n} source watchlist${n === 1 ? "" : "s"} (${sourceLabels}) and all their postings.`)) {
            return;
        }
        const ids = group.members.map(m => m.id);
        beginBusy(ids);
        try {
            const results = await Promise.allSettled(group.members.map(m => api.watchlists.delete(m.id)));
            const failures = results.filter(r => r.status === "rejected").length;
            if (failures === 0) {
                toastStore.push({ message: `Deleted: ${title}`, type: "info" });
            } else {
                toastStore.push({
                    message: `Partial delete: ${results.length - failures}/${results.length} succeeded`,
                    type: "error",
                });
            }
            invalidateWatchlists();
            invalidatePostings();
        } finally {
            endBusy(ids);
        }
    }

    return (
        <Card
            title={preset.title}
            icon={preset.icon}
            iconColorClass={preset.iconColorClass}
            action={
                <div className="flex items-center gap-2">
                    <FilterButton
                        active={filtersOpen}
                        count={filterCount}
                        onClick={() => setFiltersOpen(o => !o)}
                    />
                    <button
                        onClick={() => setAdding(true)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${preset.addBtnClass}`}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Add watchlist
                    </button>
                </div>
            }
        >
            {filtersOpen && (
                <GlobalNegativeFiltersEditor
                    onSaved={() => invalidatePostings()}
                />
            )}

            {watchlists.length > 0 && (
                <div className="mb-2 relative shrink-0">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search watchlists by name…"
                        className="w-full pl-7 pr-7 py-1.5 rounded bg-black/30 border border-white/10 text-[12px] text-white placeholder-white/30 focus:outline-none focus:border-cyan-400/40"
                    />
                    {search && (
                        <button
                            onClick={() => setSearch("")}
                            title="Clear search"
                            aria-label="Clear search"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-white/40 hover:text-white/80"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-6 text-white/40">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </div>
            ) : watchlists.length === 0 ? (
                <p className="text-xs text-white/40 italic">{preset.emptyText}</p>
            ) : filteredItems.length === 0 ? (
                <p className="text-xs text-white/40 italic">
                    No watchlists match &quot;{search}&quot;.{" "}
                    <button onClick={() => setSearch("")} className="underline text-cyan-300/80 hover:text-cyan-200">Clear</button>
                </p>
            ) : (
                <ul className="space-y-2">
                    {pageItems.map(item =>
                        item.kind === "group" ? (
                            <FindRolesGroupRow
                                key={item.groupKey}
                                group={item}
                                anyBusy={item.members.some(m => isBusy(m.id))}
                                onEdit={() => setEditingGroup(item)}
                                onRun={() => runGroup(item)}
                                onPauseToggle={(nextActive) => pauseGroup(item, nextActive)}
                                onRemove={() => removeGroup(item)}
                            />
                        ) : (
                            <WatchlistRow
                                key={item.watchlist.id}
                                w={item.watchlist}
                                busy={isBusy(item.watchlist.id)}
                                onRunNow={runNow}
                                onTogglePause={togglePause}
                                onRemove={remove}
                                onSetNotificationMode={setNotificationMode}
                                onSaveNegativeFilters={saveNegativeFilters}
                            />
                        ),
                    )}
                </ul>
            )}

            {!isLoading && pageCount > 1 && (
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
                        {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredItems.length)} of {filteredItems.length} · page {safePage + 1}/{pageCount}
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

            <AddWatchlistModal
                open={adding}
                onClose={() => setAdding(false)}
                onCreated={() => invalidateWatchlists()}
                existingWatchlists={watchlists}
                defaultTrack={track}
            />
            <EditFindRolesModal
                open={editingGroup !== null}
                group={editingGroup}
                onClose={() => setEditingGroup(null)}
                onSaved={() => {
                    invalidateWatchlists();
                    invalidatePostings();
                }}
            />
        </Card>
    );
}

function NotificationModeToggle({
    mode,
    busy,
    onChange,
}: {
    mode: "each" | "digest" | "silent";
    busy: boolean;
    onChange: (m: "each" | "digest" | "silent") => void;
}) {
    const options: Array<{ value: "each" | "digest" | "silent"; label: string; Icon: typeof Bell; title: string }> = [
        { value: "each", label: "each", Icon: Bell, title: "Notify per new posting" },
        { value: "digest", label: "digest", Icon: Layers, title: "Roll up new postings into one daily summary" },
        { value: "silent", label: "silent", Icon: BellOff, title: "No notifications — postings still appear in the feed" },
    ];
    return (
        <div className="flex items-center rounded border border-white/10 bg-black/30 overflow-hidden mr-1">
            {options.map(({ value, Icon, title }) => {
                const active = mode === value;
                return (
                    <button
                        key={value}
                        onClick={() => !active && onChange(value)}
                        disabled={busy || active}
                        title={title}
                        aria-pressed={active}
                        className={[
                            "p-1 transition-colors",
                            active
                                ? "bg-cyan-500/20 text-cyan-200"
                                : "text-white/40 hover:text-white/80 hover:bg-white/5 disabled:opacity-30",
                        ].join(" ")}
                    >
                        <Icon className="w-3 h-3" />
                    </button>
                );
            })}
        </div>
    );
}

// Source-chip palette. Per-source colors so the user can scan the row and tell
// at a glance which sources are wired up for this search.
const SOURCE_CHIP_CLASS: Record<"linkedin" | "indeed", string> = {
    linkedin: "bg-blue-500/15 text-blue-100 border border-blue-400/40",
    indeed: "bg-emerald-500/15 text-emerald-100 border border-emerald-400/40",
};
const SOURCE_LABEL: Record<"linkedin" | "indeed", string> = {
    linkedin: "LinkedIn",
    indeed: "Indeed",
};

function FindRolesGroupRow({
    group,
    anyBusy,
    onEdit,
    onRun,
    onPauseToggle,
    onRemove,
}: {
    group: FindRolesGroup;
    anyBusy: boolean;
    onEdit: () => void;
    onRun: () => void;
    onPauseToggle: (nextActive: boolean) => void;
    onRemove: () => void;
}) {
    // Aggregate state across members. lastRunAt: most recent (so the row shows
    // the freshest run). nextRun: based on anchor's schedule (members share the
    // same schedule after the Edit modal's flatten). active: true only when ALL
    // members are active.
    const allActive = group.members.every(m => m.active);
    const anyActive = group.members.some(m => m.active);
    const mostRecentRun = group.members.reduce<string | null>((latest, m) => {
        if (!m.lastRunAt) return latest;
        if (!latest) return m.lastRunAt;
        return m.lastRunAt > latest ? m.lastRunAt : latest;
    }, null);
    const anchor = group.members[0];
    const anchorScheduleMinutes = anchor?.scheduleMinutes ?? 240;
    const mixedSchedules = group.members.some(m => m.scheduleMinutes !== anchorScheduleMinutes);
    // Surface the LATEST error so a transient 403/Cloudflare on one source
    // doesn't get hidden behind a healthy sibling.
    const latestError = group.members
        .map(m => m.lastError)
        .filter((e): e is string => !!e)
        .at(-1) ?? null;

    return (
        <li className="rounded-lg bg-black/30 border border-white/10 px-3 py-2">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <Sparkles className="w-3.5 h-3.5 text-cyan-300/70 shrink-0" aria-hidden />
                        <span className="text-sm font-semibold text-white truncate">{groupTitle(group)}</span>
                        {!allActive && (
                            <span className="text-[10px] uppercase tracking-wide text-yellow-300/80 bg-yellow-500/10 px-1.5 py-0.5 rounded shrink-0">
                                {anyActive ? "partial" : "paused"}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        <span className="text-[10px] uppercase tracking-wide text-white/40">Sources:</span>
                        {group.members.map(m => {
                            const k = m.kind as "linkedin" | "indeed";
                            return (
                                <span
                                    key={m.id}
                                    title={!m.active ? `${SOURCE_LABEL[k]} (paused)` : SOURCE_LABEL[k]}
                                    className={[
                                        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold transition-opacity",
                                        SOURCE_CHIP_CLASS[k],
                                        m.active ? "" : "opacity-50",
                                    ].join(" ")}
                                >
                                    {SOURCE_LABEL[k]}
                                </span>
                            );
                        })}
                    </div>
                    <div className="text-[11px] text-white/40 mt-1 flex items-center gap-3 flex-wrap">
                        <span>last run {fmtRelative(mostRecentRun)}</span>
                        <span title={mixedSchedules ? `Mixed cadences across sources — anchor is ${fmtSchedule(anchorScheduleMinutes)}` : fmtSchedule(anchorScheduleMinutes)}>
                            {fmtNextRun(mostRecentRun, anchorScheduleMinutes)}{mixedSchedules ? " · mixed" : ""}
                        </span>
                        {latestError && (
                            <span className="flex items-center gap-1 text-red-300/80">
                                <AlertCircle className="w-3 h-3" />
                                <span className="truncate max-w-[40ch]">{latestError}</span>
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={onEdit}
                        disabled={anyBusy}
                        title="Edit search (role, location, sources, cadence)"
                        className="p-1.5 rounded text-white/50 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={onRun}
                        disabled={anyBusy || !anyActive}
                        title={anyActive ? "Run now (all sources)" : "All sources paused"}
                        className="p-1.5 rounded text-white/50 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        {anyBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    </button>
                    <button
                        onClick={() => onPauseToggle(!allActive)}
                        disabled={anyBusy}
                        title={allActive ? "Pause all sources" : "Resume all sources"}
                        className="p-1.5 rounded text-white/50 hover:text-white/90 hover:bg-white/10 disabled:opacity-30"
                    >
                        {allActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    </button>
                    <button
                        onClick={onRemove}
                        disabled={anyBusy}
                        title="Delete search (all sources)"
                        className="p-1.5 rounded text-white/50 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </li>
    );
}

function WatchlistRow({
    w,
    busy,
    onRunNow,
    onTogglePause,
    onRemove,
    onSetNotificationMode,
    onSaveNegativeFilters,
}: {
    w: WatchlistWire;
    busy: boolean;
    onRunNow: (id: string) => void;
    onTogglePause: (id: string, currentlyActive: boolean) => void;
    onRemove: (id: string, name: string) => void;
    onSetNotificationMode: (id: string, mode: "each" | "digest" | "silent") => void;
    onSaveNegativeFilters: (id: string, patterns: string[]) => Promise<void>;
}) {
    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const filterCount = w.negativeFilters?.length ?? 0;
    return (
        <li className="rounded-lg bg-black/30 border border-white/10 px-3 py-2">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white truncate">{w.name}</span>
                        {!w.active && (
                            <span className="text-[10px] uppercase tracking-wide text-yellow-300/80 bg-yellow-500/10 px-1.5 py-0.5 rounded shrink-0">
                                paused
                            </span>
                        )}
                    </div>
                    <div className="text-[11px] text-white/40 mt-0.5 flex items-center gap-3 flex-wrap">
                        <span>last run {fmtRelative(w.lastRunAt)}</span>
                        <span title={fmtSchedule(w.scheduleMinutes)}>
                            {fmtNextRun(w.lastRunAt, w.scheduleMinutes)}
                        </span>
                        {w.lastError && (
                            <span className="flex items-center gap-1 text-red-300/80">
                                <AlertCircle className="w-3 h-3" />
                                <span className="truncate max-w-[40ch]">{w.lastError}</span>
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-[10px] uppercase tracking-wide text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                        {w.kind}
                    </span>
                    <div className="flex items-center gap-1">
                        <NotificationModeToggle
                            mode={(w.notificationMode as "each" | "digest" | "silent") ?? "each"}
                            busy={busy}
                            onChange={m => onSetNotificationMode(w.id, m)}
                        />
                        <button
                            onClick={() => setFiltersExpanded(v => !v)}
                            disabled={busy}
                            title={`Negative filters${filterCount > 0 ? ` (${filterCount})` : ""}`}
                            aria-pressed={filtersExpanded}
                            className={[
                                "p-1.5 rounded flex items-center gap-0.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                                filtersExpanded
                                    ? "bg-cyan-500/20 text-cyan-200"
                                    : filterCount > 0
                                        ? "text-cyan-300/80 hover:text-cyan-200 hover:bg-cyan-500/10"
                                        : "text-white/50 hover:text-white/90 hover:bg-white/10",
                            ].join(" ")}
                        >
                            <Filter className="w-3.5 h-3.5" />
                            {filterCount > 0 && (
                                <span className="text-[10px] font-semibold tabular-nums">{filterCount}</span>
                            )}
                        </button>
                        <button
                            onClick={() => onRunNow(w.id)}
                            disabled={busy || !w.active}
                            title="Run now"
                            className="p-1.5 rounded text-white/50 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        </button>
                        <button
                            onClick={() => onTogglePause(w.id, w.active)}
                            disabled={busy}
                            title={w.active ? "Pause" : "Resume"}
                            className="p-1.5 rounded text-white/50 hover:text-white/90 hover:bg-white/10 disabled:opacity-30"
                        >
                            {w.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        </button>
                        <button
                            onClick={() => onRemove(w.id, w.name)}
                            disabled={busy}
                            title="Delete"
                            className="p-1.5 rounded text-white/50 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            </div>
            <FiltersEditor
                expanded={filtersExpanded}
                initial={w.negativeFilters ?? []}
                busy={busy}
                onSave={patterns => onSaveNegativeFilters(w.id, patterns)}
            />
        </li>
    );
}

function FiltersEditor({
    expanded,
    initial,
    busy,
    onSave,
}: {
    expanded: boolean;
    initial: string[];
    busy: boolean;
    onSave: (patterns: string[]) => Promise<void>;
}) {
    const initialJoined = initial.join("\n");
    const [text, setText] = useState(initialJoined);
    // Reset on prop change — but compare by serialized content, NOT array
    // reference, because the parent rebuilds the `initial` array on every
    // refetch (`w.negativeFilters ?? []` produces a fresh ref). Comparing by
    // reference would discard the user's in-progress edit on any background
    // refetch (SSE invalidation, sibling row's busy flag changing, etc.).
    const [lastInitialJoined, setLastInitialJoined] = useState(initialJoined);
    if (lastInitialJoined !== initialJoined) {
        setLastInitialJoined(initialJoined);
        setText(initialJoined);
    }

    function parse(raw: string): { patterns: string[]; invalid: string[] } {
        const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        const invalid: string[] = [];
        for (const l of lines) {
            try { new RegExp(l); } catch { invalid.push(l); }
        }
        return { patterns: lines, invalid };
    }

    const { patterns: parsedPatterns, invalid } = parse(text);
    const dirty = parsedPatterns.join("\n") !== initialJoined;

    // Hooks above must run unconditionally — return null AFTER they've run so
    // collapsing the editor preserves any in-progress text on the next expand.
    if (!expanded) return null;

    return (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-1.5">
            <p className="text-[10px] text-white/40 leading-tight">
                One pattern per line (case-insensitive). Plain keywords match whole words only —
                &ldquo;armed&rdquo; won&rsquo;t hit &ldquo;unarmed&rdquo;. Use regex metacharacters
                (e.g. <code className="text-white/60">.*</code>) for substring or pattern matches.
                Max 20 patterns, 200 chars each.
            </p>
            <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={"intern\nsenior\nNew York"}
                rows={Math.max(3, Math.min(8, parsedPatterns.length + 1))}
                className="w-full text-[11px] font-mono bg-black/40 border border-white/10 rounded px-2 py-1.5 text-white/90 focus:outline-none focus:border-cyan-400/40"
            />
            {invalid.length > 0 && (
                <p className="text-[10px] text-red-300/80">
                    Invalid regex: {invalid.slice(0, 3).join(", ")}{invalid.length > 3 ? "…" : ""}
                </p>
            )}
            <div className="flex items-center gap-2">
                <button
                    onClick={() => onSave(parsedPatterns)}
                    disabled={busy || !dirty || invalid.length > 0 || parsedPatterns.length > 20}
                    className="text-[11px] px-2 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 text-cyan-100 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    Save
                </button>
                {dirty && (
                    <button
                        onClick={() => setText(initialJoined)}
                        disabled={busy}
                        className="text-[11px] px-2 py-1 rounded text-white/50 hover:text-white/80 disabled:opacity-30"
                    >
                        Reset
                    </button>
                )}
                {parsedPatterns.length > 20 && (
                    <span className="text-[10px] text-red-300/80">Too many patterns (max 20)</span>
                )}
            </div>
        </div>
    );
}

// Global negative filters, stored on GlobalSetting.globalNegativeFilters
// (legacy column name) as a flat JSON array and hydrated into the Zustand
// store by ThemeProvider on mount. Auto-saves on every add/remove (no Save
// button); shows each pattern as a chip with hover-X to remove. Open/close
// is controlled by the parent — this component is only rendered when the
// Filters button in WatchlistsCard's action slot is toggled on, matching
// NewPostingsCard's filter-panel pattern. One shared list across every
// watchlist regardless of track — so blocking "anduril" hides it on both
// career and side cards.
function GlobalNegativeFiltersEditor({ onSaved }: { onSaved?: () => void }) {
    const filters = useAppStore(s => s.negativeFilters ?? []);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);

    async function persist(next: string[]) {
        if (next.length > 40) {
            toastStore.push({ message: "Max 40 filters", type: "error" });
            return;
        }
        setBusy(true);
        try {
            // Read the version at fire time — ThemeProvider may have bumped it
            // (theme change in a sibling component) since this card rendered.
            const expectedVersion = useAppStore.getState().version;
            const result = await api.settings.update(
                { negativeFilters: next },
                expectedVersion,
            );
            if (!result.ok) {
                const fresh = await api.settings.get();
                if (fresh.data) useAppStore.setState(fresh.data);
                toastStore.push({
                    message: "Settings updated elsewhere — reloaded. Try again.",
                    type: "warning",
                });
                return;
            }
            useAppStore.setState({ negativeFilters: next, version: result.version });
            onSaved?.();
        } catch (e) {
            toastStore.push({ message: `Filter save failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusy(false);
        }
    }

    function commitInput() {
        const trimmed = input.trim();
        if (!trimmed) return;
        const parts = trimmed.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 0) {
            setInput("");
            return;
        }
        // Reject patterns that are too long or invalid as regex. Surface
        // both kinds in one toast so the user doesn't have to retry blindly.
        const valid: string[] = [];
        const tooLong: string[] = [];
        const invalid: string[] = [];
        for (const p of parts) {
            if (p.length > 200) { tooLong.push(p); continue; }
            try { new RegExp(p); valid.push(p); }
            catch { invalid.push(p); }
        }
        if (tooLong.length > 0) {
            toastStore.push({ message: `Too long (max 200 chars): ${tooLong.slice(0, 3).map(s => s.slice(0, 30) + "…").join(", ")}`, type: "error" });
        }
        if (invalid.length > 0) {
            toastStore.push({ message: `Invalid regex: ${invalid.slice(0, 3).join(", ")}`, type: "error" });
        }
        const existingNormalized = new Set(filters.map(normalizeNegativeFilterForDedup));
        const additions: string[] = [];
        for (const p of valid) {
            const norm = normalizeNegativeFilterForDedup(p);
            if (!existingNormalized.has(norm)) {
                additions.push(p);
                existingNormalized.add(norm);
            }
        }
        setInput("");
        if (additions.length === 0) return;
        persist([...filters, ...additions]);
    }

    function removeFilter(kw: string) {
        if (busy) return;
        persist(filters.filter(f => f !== kw));
    }

    return (
        <div className="mb-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2 flex flex-col gap-2 shrink-0">
            <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-white/40">
                    Negative filters
                </span>
                {filters.length > 0 && (
                    <button
                        onClick={() => persist([])}
                        disabled={busy}
                        className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 disabled:opacity-30"
                    >
                        <X className="w-3 h-3" />
                        Clear
                    </button>
                )}
            </div>
            <p className="text-[10px] text-white/40 leading-tight">
                Applies to every watchlist on both career and side cards. Plain keywords match whole words
                only (case-insensitive) — &ldquo;armed&rdquo; won&rsquo;t hit &ldquo;unarmed&rdquo;.
                Include regex metacharacters (e.g. <code className="text-white/60">.*</code>) for substring or
                pattern matches. Comma or Enter to add; hover a tag and click × to remove.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
                {filters.map(kw => (
                    <span
                        key={kw}
                        className="group inline-flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full text-[10px] font-semibold font-mono bg-rose-500/15 text-rose-100 border border-rose-400/30"
                    >
                        <span>{kw}</span>
                        <button
                            onClick={() => removeFilter(kw)}
                            disabled={busy}
                            title={`Remove "${kw}"`}
                            aria-label={`Remove ${kw}`}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-rose-100/70 hover:text-rose-50 transition-opacity disabled:opacity-30"
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
                            commitInput();
                        } else if (e.key === "Backspace" && input === "" && filters.length > 0 && !busy) {
                            e.preventDefault();
                            removeFilter(filters[filters.length - 1]);
                        }
                    }}
                    onBlur={commitInput}
                    placeholder={filters.length === 0 ? "e.g. senior, staff, manager" : "add another…"}
                    disabled={busy}
                    className="flex-1 min-w-[8rem] px-2 py-1 rounded bg-black/40 border border-white/10 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-rose-400/40 disabled:opacity-50"
                />
                {busy && <Loader2 className="w-3 h-3 animate-spin text-white/40" />}
            </div>
        </div>
    );
}
