"use client";
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, Pause, Play, Plus, RefreshCw, Trash2, AlertCircle, Filter, ChevronDown, ChevronRight } from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";
import { AddWatchlistModal } from "../overlays/AddWatchlistModal";

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

export function WatchlistsCard() {
    const queryClient = useQueryClient();
    const [adding, setAdding] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.watchlists,
        queryFn: () => api.watchlists.list(),
    });

    useServerEvents("Watchlist", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.watchlists });
    });

    const watchlists = data?.watchlists ?? [];

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
        <div className="rounded-2xl border border-cyan-400/20 bg-cyan-500/5 p-4">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <Eye className="w-4 h-4 text-cyan-300" />
                    <h3 className="text-sm font-semibold text-cyan-200">Watchlists</h3>
                </div>
                <button
                    onClick={() => setAdding(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 text-xs font-semibold text-cyan-100 transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" />
                    Add watchlist
                </button>
            </div>

            {isLoading ? (
                <div className="flex items-center justify-center py-6 text-white/40">
                    <Loader2 className="w-4 h-4 animate-spin" />
                </div>
            ) : watchlists.length === 0 ? (
                <p className="text-xs text-white/40 italic">No watchlists yet. Add one above to start hunting on your behalf.</p>
            ) : (
                <ul className="space-y-2">
                    {watchlists.map(w => {
                        const busy = busyId === w.id;
                        return (
                            <li key={w.id} className="rounded-lg bg-black/30 border border-white/10 px-3 py-2">
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
                                            <span>every {w.scheduleMinutes}m</span>
                                            {w.lastError && (
                                                <span className="flex items-center gap-1 text-red-300/80">
                                                    <AlertCircle className="w-3 h-3" />
                                                    <span className="truncate max-w-[40ch]">{w.lastError}</span>
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => runNow(w.id)}
                                            disabled={busy || !w.active}
                                            title="Run now"
                                            className="p-1.5 rounded text-white/50 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                                        >
                                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                        </button>
                                        <button
                                            onClick={() => togglePause(w.id, w.active)}
                                            disabled={busy}
                                            title={w.active ? "Pause" : "Resume"}
                                            className="p-1.5 rounded text-white/50 hover:text-white/90 hover:bg-white/10 disabled:opacity-30"
                                        >
                                            {w.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                                        </button>
                                        <button
                                            onClick={() => remove(w.id, w.name)}
                                            disabled={busy}
                                            title="Delete"
                                            className="p-1.5 rounded text-white/50 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                                <FiltersEditor
                                    initial={w.negativeFilters ?? []}
                                    busy={busy}
                                    onSave={patterns => saveNegativeFilters(w.id, patterns)}
                                />
                            </li>
                        );
                    })}
                </ul>
            )}

            <AddWatchlistModal
                open={adding}
                onClose={() => setAdding(false)}
                onCreated={() => queryClient.invalidateQueries({ queryKey: queryKeys.watchlists })}
            />
        </div>
    );
}

function FiltersEditor({
    initial,
    busy,
    onSave,
}: {
    initial: string[];
    busy: boolean;
    onSave: (patterns: string[]) => Promise<void>;
}) {
    const [expanded, setExpanded] = useState(false);
    const [text, setText] = useState(initial.join("\n"));
    // "Reset state on prop change" without useEffect — React's recommended
    // pattern for derived state. When `initial` shifts (another tab edited
    // the filters, or the parent refetched), snap local edits back to it.
    const [lastInitial, setLastInitial] = useState(initial);
    if (lastInitial !== initial) {
        setLastInitial(initial);
        setText(initial.join("\n"));
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
    const dirty = parsedPatterns.join("\n") !== initial.join("\n");

    return (
        <div className="mt-2 pt-2 border-t border-white/5">
            <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80"
            >
                {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <Filter className="w-3 h-3" />
                <span>Negative filters</span>
                {initial.length > 0 && (
                    <span className="text-[10px] text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                        {initial.length}
                    </span>
                )}
            </button>
            {expanded && (
                <div className="mt-2 space-y-1.5">
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
                                onClick={() => setText(initial.join("\n"))}
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
            )}
        </div>
    );
}
