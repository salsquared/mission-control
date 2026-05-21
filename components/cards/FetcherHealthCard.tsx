"use client";

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ArrowUp, ArrowDown, Search } from "lucide-react";
import { api, queryKeys } from "@/lib/api-client";

const ONE_HOUR_MS = 60 * 60 * 1000;

type SortKey = 'host' | 'ok' | 'fallback' | 'broken' | 'health';
type SortDir = 'asc' | 'desc';

type HealthEntry = { ok: number; fallback: number; broken: number };

function healthPct(h: HealthEntry): number {
    const total = h.ok + h.fallback + h.broken;
    return total === 0 ? 100 : (h.ok / total) * 100;
}

export const FetcherHealthCard: React.FC = () => {
    // staleTime + gcTime both pinned to 1h so the cached map survives unmount
    // when the user switches dashes — the previous inline version recomputed
    // from the live SSE log buffer on each mount, which goes empty after a
    // burst of unrelated logs evicts the 50-deep ring buffer. Server-side
    // route is also wrapped in withCache(handler, 3600).
    const { data, isLoading } = useQuery({
        queryKey: queryKeys.fetcherHealth,
        queryFn: () => api.system.fetcherHealth(),
        staleTime: ONE_HOUR_MS,
        gcTime: ONE_HOUR_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
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

    return (
        <div className="flex flex-col h-[280px]">
            <div className="flex items-center justify-between gap-2 mb-3 shrink-0">
                <div className="flex items-center gap-2 text-amber-400">
                    <ShieldAlert className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Fetcher Health (Last Hour)</h3>
                </div>
                <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter hosts…"
                        className="bg-black/30 border border-white/10 rounded-md text-xs font-mono pl-7 pr-2 py-1 w-44 focus:outline-none focus:border-amber-500/40 placeholder:text-white/30"
                    />
                </div>
            </div>
            <div className="flex-1 overflow-y-auto pr-2">
                {Object.keys(data?.health ?? {}).length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-muted-foreground text-sm">
                            {isLoading ? 'Loading fetcher health…' : 'No fetcher activity in the last hour'}
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
                                {renderSortHeader('OK', 'ok', 'right', 'w-16')}
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
                                        <td className="py-2 text-slate-300 truncate max-w-[180px]" title={host}>{host}</td>
                                        <td className="py-2 text-right text-emerald-400">{h.ok}</td>
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
