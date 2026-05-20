"use client";
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, Pause, Play, Plus, RefreshCw, Trash2, AlertCircle, Filter, ChevronDown, ChevronRight, ChevronLeft, Bell, BellOff, Layers, X } from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";
import { useAppStore } from "../providers/state";
import { AddWatchlistModal } from "../overlays/AddWatchlistModal";
import { Card } from "../ui/Card";
import type { WatchlistWire } from "@/lib/schemas/watchlists";

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

export function WatchlistsCard() {
    const queryClient = useQueryClient();
    const [adding, setAdding] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [page, setPage] = useState(0);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.watchlists,
        queryFn: () => api.watchlists.list(),
    });

    useServerEvents("Watchlist", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.watchlists });
    });

    const watchlists = data?.watchlists ?? [];

    // Pagination — mirrors the pattern in NewPostingsCard.tsx. safePage
    // clamps the live `page` against the current count so deleting the last
    // watchlist on page 3 doesn't strand the view on an empty page.
    const pageCount = Math.max(1, Math.ceil(watchlists.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageStart = safePage * PAGE_SIZE;
    const pageWatchlists = watchlists.slice(pageStart, pageStart + PAGE_SIZE);

    async function runNow(id: string) {
        setBusyId(id);
        try {
            // `api.watchlists.run` throws on non-2xx (the route returns 502 when
            // the fetcher errors), so reaching this point means success.
            const result = await api.watchlists.run(id);
            toastStore.push({
                message: `Run complete — ${result.newPostings} new, ${result.seenAgain} seen-again`,
                type: "info",
            });
            queryClient.invalidateQueries({ queryKey: queryKeys.watchlists });
            queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
            queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
        } catch (e) {
            toastStore.push({ message: `Run failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    async function togglePause(id: string, currentlyActive: boolean) {
        setBusyId(id);
        try {
            await api.watchlists.update(id, { active: !currentlyActive });
            queryClient.invalidateQueries({ queryKey: queryKeys.watchlists });
        } catch (e) {
            toastStore.push({ message: `Pause toggle failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    async function setNotificationMode(id: string, mode: "each" | "digest" | "silent") {
        setBusyId(id);
        try {
            await api.watchlists.update(id, { notificationMode: mode });
            queryClient.invalidateQueries({ queryKey: queryKeys.watchlists });
        } catch (e) {
            toastStore.push({ message: `Notification mode change failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    async function saveNegativeFilters(id: string, patterns: string[]) {
        setBusyId(id);
        try {
            await api.watchlists.update(id, { negativeFilters: patterns });
            toastStore.push({
                message: patterns.length === 0
                    ? "Filters cleared"
                    : `Saved ${patterns.length} filter${patterns.length === 1 ? "" : "s"}`,
                type: "info",
            });
            queryClient.invalidateQueries({ queryKey: queryKeys.watchlists });
            queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
        } catch (e) {
            toastStore.push({ message: `Filter save failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    async function remove(id: string, name: string) {
        if (!window.confirm(`Delete watchlist "${name}" and all its postings?`)) return;
        setBusyId(id);
        try {
            await api.watchlists.delete(id);
            toastStore.push({ message: `Deleted: ${name}`, type: "info" });
            queryClient.invalidateQueries({ queryKey: queryKeys.watchlists });
            queryClient.invalidateQueries({ queryKey: queryKeys.postings() });
        } catch (e) {
            toastStore.push({ message: `Delete failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyId(null);
        }
    }

    return (
        <Card
            title="Watchlists"
            icon={Eye}
            iconColorClass="text-cyan-300"
            action={
                <button
                    onClick={() => setAdding(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 text-xs font-semibold text-cyan-100 transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" />
                    Add watchlist
                </button>
            }
        >
            <GlobalNegativeFiltersEditor
                onSaved={() => queryClient.invalidateQueries({ queryKey: queryKeys.postings() })}
            />

            {isLoading ? (
                <div className="flex items-center justify-center py-6 text-white/40">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </div>
            ) : watchlists.length === 0 ? (
                <p className="text-xs text-white/40 italic">No watchlists yet. Add one above to start hunting on your behalf.</p>
            ) : (
                <ul className="space-y-2">
                    {pageWatchlists.map(w => (
                        <WatchlistRow
                            key={w.id}
                            w={w}
                            busy={busyId === w.id}
                            onRunNow={runNow}
                            onTogglePause={togglePause}
                            onRemove={remove}
                            onSetNotificationMode={setNotificationMode}
                            onSaveNegativeFilters={saveNegativeFilters}
                        />
                    ))}
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
                        {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, watchlists.length)} of {watchlists.length} · page {safePage + 1}/{pageCount}
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
                onCreated={() => queryClient.invalidateQueries({ queryKey: queryKeys.watchlists })}
                existingWatchlists={watchlists}
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
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white truncate">{w.name}</span>
                        <span className="text-[10px] uppercase tracking-wide text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                            {w.kind}
                        </span>
                        {!w.active && (
                            <span className="text-[10px] uppercase tracking-wide text-yellow-300/80 bg-yellow-500/10 px-1.5 py-0.5 rounded">
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
                <div className="flex items-center gap-1 shrink-0">
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
                One regex per line (case-insensitive). Postings whose title, snippet, or location
                matches any pattern are hidden. Max 20 patterns, 200 chars each.
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

// Cross-watchlist negative filters, stored on GlobalSetting.globalNegativeFilters
// and hydrated into the Zustand store by ThemeProvider on mount. Auto-saves on
// every add/remove (no Save button); shows each pattern as a chip with hover-X
// to remove.
function GlobalNegativeFiltersEditor({ onSaved }: { onSaved?: () => void }) {
    const filters = useAppStore(s => s.globalNegativeFilters);
    const [expanded, setExpanded] = useState(false);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);

    async function persist(next: string[]) {
        if (next.length > 20) {
            toastStore.push({ message: "Max 20 global filters", type: "error" });
            return;
        }
        setBusy(true);
        try {
            // Read the version at fire time — ThemeProvider may have bumped it
            // (theme change in a sibling component) since this card rendered.
            const expectedVersion = useAppStore.getState().version;
            const result = await api.settings.update(
                { globalNegativeFilters: next },
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
            useAppStore.setState({ globalNegativeFilters: next, version: result.version });
            onSaved?.();
        } catch (e) {
            toastStore.push({ message: `Global filter save failed: ${errMessage(e)}`, type: "error" });
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
        const existingLower = new Set(filters.map(f => f.toLowerCase()));
        const additions: string[] = [];
        for (const p of valid) {
            const lower = p.toLowerCase();
            if (!existingLower.has(lower)) {
                additions.push(p);
                existingLower.add(lower);
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
        <div className="mb-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2 shrink-0">
            <div className="flex items-center justify-between">
                <button
                    onClick={() => setExpanded(v => !v)}
                    className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80"
                >
                    {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    <Filter className="w-3 h-3" />
                    <span>Global negative filters</span>
                    {filters.length > 0 && (
                        <span className="text-[10px] text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                            {filters.length}
                        </span>
                    )}
                </button>
                {expanded && filters.length > 0 && (
                    <button
                        onClick={() => persist([])}
                        disabled={busy}
                        className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 disabled:opacity-30"
                    >
                        <X className="w-3 h-3" />
                        Clear all
                    </button>
                )}
            </div>
            {expanded && (
                <div className="mt-2 space-y-2">
                    <p className="text-[10px] text-white/40 leading-tight">
                        Applies to every watchlist below. Each entry is a case-insensitive regex matched against
                        the title, snippet, and location. Comma or Enter to add. Hover a tag and click × to remove.
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
            )}
        </div>
    );
}
