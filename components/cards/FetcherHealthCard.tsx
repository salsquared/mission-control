"use client";

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ArrowUp, ArrowDown, Search } from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";

const THIRTY_SECONDS_MS = 30 * 1000;

type SortKey = 'host' | 'ok' | 'error' | 'fallback' | 'broken' | 'health';
type SortDir = 'asc' | 'desc';

type HealthEntry = { ok: number; error: number; fallback: number; broken: number };
type WindowKey = '1h' | '6h' | '1d';
const WINDOWS: readonly WindowKey[] = ['1h', '6h', '1d'] as const;

// Web vs scheduler distinction (OQ4): 'all' = union, else scope to one process class.
type SourceKey = 'all' | 'web' | 'scheduler';
const SOURCES: readonly { key: SourceKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'web', label: 'Web' },
    { key: 'scheduler', label: 'Scheduler' },
] as const;

function healthPct(h: HealthEntry): number {
    const total = h.ok + h.error + h.fallback + h.broken;
    return total === 0 ? 100 : (h.ok / total) * 100;
}

function fmtSuccessPct(pct: number, hasData: boolean): string {
    if (!hasData) return '—';
    if (pct === 100) return '100%';
    if (pct > 99) return '>99%';
    return `${Math.round(pct)}%`;
}

function successPctColor(pct: number, hasData: boolean): string {
    if (!hasData) return 'text-white/30';
    if (pct >= 95) return 'text-emerald-400';
    if (pct >= 80) return 'text-amber-400';
    return 'text-red-400';
}

export const FetcherHealthCard: React.FC = () => {
    // Window selected for the per-host table (also which badge is highlighted).
    // Defaults to 1d so the table reflects the day, not a possibly-empty last
    // hour — the old hard-1h table was exactly what produced "no activity"
    // while the 1d badge read 100%.
    const [window, setWindow] = useState<WindowKey>('1d');
    // Source scope (All / Web / Scheduler) — see OQ4.
    const [sourceFilter, setSourceFilter] = useState<SourceKey>('all');

    // Reads a dedicated SQLite store now (not the PM2 log), so the response is
    // <1ms and near-live: 30s cache + refetch on focus, no hour-long staleness.
    const { data, isLoading } = useQuery({
        queryKey: queryKeys.fetcherHealth({ source: sourceFilter, window }),
        queryFn: () => api.system.fetcherHealth({
            source: sourceFilter === 'all' ? undefined : sourceFilter,
            window,
        }),
        staleTime: THIRTY_SECONDS_MS,
        refetchInterval: THIRTY_SECONDS_MS,
    });

    const [filter, setFilter] = useState('');
    // Default: surface broken hosts first — same as the prior fixed sort.
    const [sortKey, setSortKey] = useState<SortKey>('broken');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const onSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            // Numeric columns default desc (largest first); host defaults asc.
            setSortDir(key === 'host' ? 'asc' : 'desc');
        }
    };

    const entries = useMemo(() => {
        const health = data?.health ?? {};
        const q = filter.trim().toLowerCase();
        const filtered = Object.entries(health).filter(
            ([host]) => !q || host.toLowerCase().includes(q)
        );
        const cmp = (
            [ha, va]: [string, HealthEntry],
            [hb, vb]: [string, HealthEntry]
        ): number => {
            let diff: number;
            if (sortKey === 'host') {
                diff = ha.localeCompare(hb);
            } else {
                const av = sortKey === 'health' ? healthPct(va) : va[sortKey];
                const bv = sortKey === 'health' ? healthPct(vb) : vb[sortKey];
                diff = av - bv;
                // Stable tiebreaker by host so equal-count rows don't shuffle.
                if (diff === 0) diff = ha.localeCompare(hb);
            }
            return sortDir === 'asc' ? diff : -diff;
        };
        return filtered.sort(cmp);
    }, [data, filter, sortKey, sortDir]);

    const renderSortHeader = (
        label: string,
        sortKeyVal: SortKey,
        align: 'left' | 'right' = 'right',
        width?: string,
    ) => {
        const active = sortKey === sortKeyVal;
        const Arrow = sortDir === 'asc' ? ArrowUp : ArrowDown;
        return (
            <th className={`pb-2 font-normal ${align === 'left' ? 'text-left' : 'text-right'} ${width ?? ''}`}>
                <button
                    onClick={() => onSort(sortKeyVal)}
                    className={`inline-flex items-center gap-1 hover:text-white transition-colors ${active ? 'text-white' : 'text-white/40'} ${align === 'right' ? 'justify-end' : ''}`}
                >
                    {label}
                    {active && <Arrow className="w-3 h-3" />}
                </button>
            </th>
        );
    };

    const totals = data?.totals;

    return (
        <div className="flex flex-col h-[280px]">
            <div className="flex items-center justify-between gap-3 mb-2 shrink-0">
                <div className="flex items-center gap-2 text-amber-400 shrink-0">
                    <ShieldAlert className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm whitespace-nowrap">Fetcher Health</h3>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                    {/* Window badges — clickable, drive the per-host table window (OQ10). */}
                    <div className="flex items-center gap-1 text-xs font-mono">
                        {WINDOWS.map(w => {
                            const entry = totals?.[w];
                            const total = entry ? entry.ok + entry.error + entry.fallback + entry.broken : 0;
                            const pct = entry ? healthPct(entry) : 0;
                            const selected = w === window;
                            return (
                                <button
                                    key={w}
                                    onClick={() => setWindow(w)}
                                    title={entry ? `${entry.ok} ok / ${total} fetches — click to scope the table to ${w}` : 'no data'}
                                    className={`flex items-center gap-1 px-2 py-1 rounded-md border transition-colors ${selected ? 'bg-amber-500/15 border-amber-500/40' : 'bg-black/30 border-white/10 hover:border-white/25'}`}
                                >
                                    <span className={selected ? 'text-amber-200' : 'text-white/40'}>{w}</span>
                                    <span className={successPctColor(pct, total > 0)}>{fmtSuccessPct(pct, total > 0)}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="relative">
                        <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
                        <input
                            type="text"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder="Filter hosts…"
                            className="bg-black/30 border border-white/10 rounded-md text-xs font-mono pl-7 pr-2 py-1 w-40 focus:outline-none focus:border-amber-500/40 placeholder:text-white/30"
                        />
                    </div>
                </div>
            </div>
            {/* Source filter — web vs scheduler (OQ4). */}
            <div className="flex items-center gap-1 mb-3 shrink-0 text-xs font-mono">
                {SOURCES.map(s => {
                    const selected = s.key === sourceFilter;
                    return (
                        <button
                            key={s.key}
                            onClick={() => setSourceFilter(s.key)}
                            className={`px-2 py-0.5 rounded-md border transition-colors ${selected ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200' : 'bg-black/30 border-white/10 text-white/40 hover:border-white/25'}`}
                        >
                            {s.label}
                        </button>
                    );
                })}
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
                {Object.keys(data?.health ?? {}).length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-muted-foreground text-sm">
                            {isLoading
                                ? 'Loading fetcher health…'
                                : `No fetcher activity in the last ${window === '1d' ? 'day' : window}${sourceFilter !== 'all' ? ` (${sourceFilter})` : ''}`}
                        </p>
                    </div>
                ) : entries.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-muted-foreground text-sm">
                            No hosts match &ldquo;{filter}&rdquo;
                        </p>
                    </div>
                ) : (
                    <table className="w-full text-xs font-mono">
                        <thead>
                            <tr className="border-b border-white/10">
                                {renderSortHeader('Host', 'host', 'left')}
                                {renderSortHeader('OK', 'ok', 'right', 'w-14')}
                                {renderSortHeader('Error', 'error', 'right', 'w-16')}
                                {renderSortHeader('Fallback', 'fallback', 'right', 'w-20')}
                                {renderSortHeader('Broken', 'broken', 'right', 'w-16')}
                                {renderSortHeader('Health', 'health', 'right', 'w-16')}
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map(([host, h]) => {
                                const pct = Math.round(healthPct(h));
                                const pill = pct >= 95
                                    ? 'bg-emerald-500/20 text-emerald-400'
                                    : pct >= 70
                                        ? 'bg-amber-500/20 text-amber-400'
                                        : 'bg-red-500/20 text-red-400';
                                return (
                                    <tr key={host} className="border-b border-white/5 last:border-0">
                                        <td className="py-2 text-slate-300 truncate max-w-[160px]" title={host}>{host}</td>
                                        <td className="py-2 text-right text-emerald-400">{h.ok}</td>
                                        <td className="py-2 text-right text-red-400">{h.error}</td>
                                        <td className="py-2 text-right text-amber-400">{h.fallback}</td>
                                        <td className="py-2 text-right text-red-400">{h.broken}</td>
                                        <td className="py-2 text-right">
                                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${pill}`}>{pct}%</span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
};
