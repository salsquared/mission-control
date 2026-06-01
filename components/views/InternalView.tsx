"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { api, queryKeys } from "@/lib/api-client";
import { Activity, Settings, Server, Palette, Cpu, User, LogOut, LogIn, RefreshCw } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { useSession, signIn, signOut } from "next-auth/react";
import { useThemeStore } from "@/components/providers/themeStore";
import { useSettingsStore } from "@/components/providers/settingsStore";
import { FetcherHealthCard } from "../cards/FetcherHealthCard";

// Soft cap on the in-memory log buffer. The SSE stream pushes one entry per
// server-side console.* call, so under load this fills quickly. Lowered from
// 500 — we display the most recent ~100 anyway.
const LOG_BUFFER_CAP = 200;
const LOG_DISPLAY_CAP = 100;

const formatLogMessage = (message: string) => {
    const regex = /\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|[2345]\d{2})\b/g;
    if (!regex.test(message)) return message;

    const parts = message.split(regex);
    return parts.map((part, index) => {
        if (part === 'GET') return <span key={index} className="text-emerald-400 font-bold">GET</span>;
        if (part === 'POST') return <span key={index} className="text-blue-400 font-bold">POST</span>;
        if (part === 'PUT') return <span key={index} className="text-amber-400 font-bold">PUT</span>;
        if (part === 'DELETE') return <span key={index} className="text-red-400 font-bold">DELETE</span>;
        if (part === 'PATCH') return <span key={index} className="text-purple-400 font-bold">PATCH</span>;
        if (part === 'OPTIONS') return <span key={index} className="text-gray-400 font-bold">OPTIONS</span>;
        if (part === 'HEAD') return <span key={index} className="text-gray-400 font-bold">HEAD</span>;

        if (/^[2345]\d{2}$/.test(part)) {
            const code = parseInt(part, 10);
            if (code >= 200 && code < 300) return <span key={index} className="text-emerald-400 font-bold">{part}</span>;
            if (code >= 300 && code < 400) return <span key={index} className="text-cyan-400 font-bold">{part}</span>;
            if (code >= 400 && code < 500) return <span key={index} className="text-amber-400 font-bold">{part}</span>;
            if (code >= 500) return <span key={index} className="text-red-400 font-bold">{part}</span>;
        }

        return part;
    });
};

export const InternalView: React.FC = () => {
    const { data: session } = useSession();
    const { data: sysMetrics } = useQuery({
        queryKey: queryKeys.system,
        queryFn: () => api.system.get(),
        refetchInterval: 5000,
    });
    const [sysLogs, setSysLogs] = useState<{ id: string; timestamp: string; level: string; message: string; source?: string; tier?: string; }[]>([]);
    const [historicalLogs, setHistoricalLogs] = useState<{ ts: string; level: string; msg: string; source?: string; tier?: string }[]>([]);
    const [loadingOlder, setLoadingOlder] = useState(false);
    // Log-viewer source filter (All / Web / Scheduler). Scheduler rows arrive
    // source-tagged via data/logs.db; web rows are tagged 'web' (older rows that
    // predate the field default to 'web'). See docs/scheduler-structured-logs.html.
    const [logSourceFilter, setLogSourceFilter] = useState<'all' | 'web' | 'scheduler'>('all');

    const loadOlderLogs = useCallback(async () => {
        setLoadingOlder(true);
        try {
            const res = await fetch('/api/system/logs/historical');
            if (!res.ok) throw new Error(`/api/system/logs/historical returned ${res.status}`);
            const data = await res.json();
            setHistoricalLogs(data.logs || []);
        } catch (e) {
            console.error('Failed to load historical logs', e);
        } finally {
            setLoadingOlder(false);
        }
    }, []);

    const matchLogSource = useCallback(
        (src?: string) => logSourceFilter === 'all' || (src ?? 'web') === logSourceFilter,
        [logSourceFilter],
    );
    const visibleSysLogs = useMemo(() => sysLogs.filter(l => matchLogSource(l.source)), [sysLogs, matchLogSource]);
    const visibleHistoricalLogs = useMemo(() => historicalLogs.filter(l => matchLogSource(l.source)), [historicalLogs, matchLogSource]);

    useEffect(() => {
        let es: EventSource | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let backoff = 3_000;
        let cancelled = false;

        const connect = () => {
            if (cancelled) return;
            es = new EventSource('/api/system/logs');

            es.onopen = () => { backoff = 3_000; };

            es.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'initial') {
                        const initial = (data.logs || []).slice(-LOG_BUFFER_CAP);
                        setSysLogs(initial);
                    } else if (data.type === 'new') {
                        setSysLogs((prevLogs) => {
                            const nextLogs = prevLogs.length >= LOG_BUFFER_CAP
                                ? [...prevLogs.slice(prevLogs.length - LOG_BUFFER_CAP + 1), data.log]
                                : [...prevLogs, data.log];
                            return nextLogs;
                        });
                    }
                } catch (err) {
                    console.error("Failed to parse log message", err);
                }
            };

            // EventSource auto-reconnects on a 2xx-then-drop (readyState CONNECTING);
            // stay quiet in that case. On a non-2xx response (401 during a
            // session-cookie blip in dev, 5xx during HMR rebuild) the browser
            // gives up at readyState CLOSED — schedule a manual reconnect with
            // backoff so the live tail self-heals instead of dying until reload.
            es.onerror = () => {
                if (es?.readyState !== EventSource.CLOSED) return;
                es.close();
                if (cancelled) return;
                retryTimer = setTimeout(connect, backoff);
                backoff = Math.min(backoff * 2, 30_000);
            };
        };

        connect();

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            es?.close();
        };
    }, []);

    // Persisted settings store
    const { autoResearch, setAutoResearch, aiCompanionEnabled, setAiCompanionEnabled } = useSettingsStore();

    // Global Theme State
    const { isDarkMode, setIsDarkMode, viewHues, setViewHue, dashOrder, dashTitles, defaultDashTitles } = useThemeStore();

    const colorPresets = [
        { name: "Purple", hue: 250, color: "bg-purple-500" },
        { name: "Pink", hue: 320, color: "bg-pink-500" },
        { name: "Red", hue: 0, color: "bg-red-500" },
        { name: "Orange", hue: 30, color: "bg-orange-500" },
        { name: "Yellow", hue: 60, color: "bg-yellow-500" },
        { name: "Emerald", hue: 150, color: "bg-emerald-500" },
        { name: "Cyan", hue: 190, color: "bg-cyan-500" },
        { name: "Blue", hue: 220, color: "bg-blue-500" },
    ];

    const views = useMemo(() => {
        const currentOrder = Array.from(new Set([...dashOrder, ...Object.keys(defaultDashTitles)]));
        return currentOrder.map(id => {
            const fallbackName = id.charAt(0).toUpperCase() + id.slice(1);
            return {
                id,
                name: dashTitles[id] || defaultDashTitles[id] || fallbackName,
            };
        });
    }, [dashOrder, dashTitles, defaultDashTitles]);

    const toggleTheme = useCallback((checked: boolean) => {
        setIsDarkMode(!checked); // because the UI assumes toggle is "Light Mode On" when checked
    }, [setIsDarkMode]);

    // Memo'd to stop the entire 8-card JSX tree from being rebuilt every time
    // sysLogs changes (i.e. every SSE log push). Each input is intentionally
    // narrow; the heavy log card depends on sysLogs but the other 7 don't.
    const staticCards: CardItem[] = useMemo(() => [
        {
            id: "system-telemetry",
            colSpan: 3,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-purple-400">
                        <Cpu className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">System Telemetry</h3>
                    </div>
                    <div className="flex justify-between gap-0 md:gap-8 flex-1 w-full overflow-x-auto custom-scrollbar">
                        <div className="flex flex-col items-center text-center bg-black/20 py-4 px-8 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">CPU Load</span>
                            <span className="text-2xl font-mono text-white">{sysMetrics ? `${sysMetrics.cpuUsagePercent}%` : '--'}</span>
                        </div>
                        <div className="flex flex-col items-center text-center bg-black/20 py-4 px-8 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">Memory Usage</span>
                            <span className="text-2xl font-mono text-white">{sysMetrics ? sysMetrics.memoryUsageFormatted.split(' / ')[0] : '--'}</span>
                        </div>
                        <div className="flex flex-col items-center text-center bg-black/20 py-4 px-8 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">Allocated RAM</span>
                            <span className="text-2xl font-mono text-white">{sysMetrics?.maxAllocatedRamGB ? `${sysMetrics.maxAllocatedRamGB} GB` : '--'}</span>
                        </div>
                        <div className="flex flex-col items-center text-center bg-black/20 py-4 px-8 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">Server Uptime</span>
                            <span className="text-2xl font-mono text-white">{sysMetrics ? sysMetrics.uptimeFormatted : '--'}</span>
                        </div>
                        <div className="flex flex-col items-center text-center bg-black/20 py-4 px-8 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">Database Status</span>
                            <div className="flex items-center gap-2 mt-1">
                                {sysMetrics ? (
                                    <>
                                        <div className={`w-3 h-3 rounded-full shrink-0 ${sysMetrics.dbConnected ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]'}`} />
                                        <span className={`text-sm font-medium ${sysMetrics.dbConnected ? 'text-emerald-400' : 'text-red-400'}`}>
                                            {sysMetrics.dbConnected ? 'Connected' : 'Disconnected'}
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-2xl font-mono text-white">--</span>
                                )}
                            </div>
                        </div>
                        <div className="flex flex-col items-center text-center bg-black/20 py-4 px-8 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">Pulsar Status</span>
                            <div className="flex items-center gap-2 mt-1">
                                {sysMetrics ? (
                                    <>
                                        <div className={`w-3 h-3 rounded-full shrink-0 ${sysMetrics.pulsarOnline ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]'}`} />
                                        <span className={`text-sm font-medium ${sysMetrics.pulsarOnline ? 'text-emerald-400' : 'text-amber-400'}`}>
                                            {sysMetrics.pulsarOnline ? 'Online' : 'Offline'}
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-2xl font-mono text-white">--</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            ),
        },
        {
            id: "internal-1",
            colSpan: 3,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-purple-400">
                        <Activity className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Agent System Telemetry</h3>
                    </div>
                    <div className="flex-1 flex items-center justify-center p-6 border border-dashed border-white/10 rounded-xl bg-black/20">
                        <p className="text-muted-foreground text-sm font-medium">Agent framework currently offline</p>
                    </div>
                </div>
            ),
        },
        {
            id: "internal-2",
            colSpan: 3,
            content: (
                <div className="flex flex-col h-[400px]">
                    <div className="flex items-center justify-between gap-2 mb-4 shrink-0">
                        <div className="flex items-center gap-2 text-cyan-400">
                            <Server className="w-5 h-5" />
                            <h3 className="font-bold tracking-wider uppercase text-sm">Background Event Log</h3>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1">
                                {(['all', 'web', 'scheduler'] as const).map((opt) => (
                                    <button
                                        key={opt}
                                        onClick={() => setLogSourceFilter(opt)}
                                        className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border transition-colors ${
                                            logSourceFilter === opt
                                                ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                                                : 'border-white/10 text-slate-400 hover:text-slate-200'
                                        }`}
                                    >
                                        {opt}
                                    </button>
                                ))}
                            </div>
                            <button
                                onClick={loadOlderLogs}
                                disabled={loadingOlder}
                                className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 border border-white/10 rounded-lg disabled:opacity-50 transition-colors"
                            >
                                {loadingOlder ? 'Loading…' : 'Load older'}
                            </button>
                        </div>
                    </div>
                    <div className="flex-1 flex flex-col p-4 border border-dashed border-white/10 rounded-xl bg-black/40 overflow-hidden relative">
                        {visibleSysLogs.length === 0 && visibleHistoricalLogs.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center">
                                <p className="text-muted-foreground text-sm font-medium">
                                    {logSourceFilter === 'all'
                                        ? 'Event logging currently offline or no logs yet'
                                        : `No ${logSourceFilter} logs yet`}
                                </p>
                            </div>
                        ) : (
                            <div className="flex flex-col-reverse overflow-y-auto custom-scrollbar gap-1.5 font-mono text-xs w-full h-full pr-2 select-text cursor-text">
                                {visibleSysLogs.slice(-LOG_DISPLAY_CAP).reverse().map((log) => (
                                    <div key={log.id} className="flex gap-3 w-full border-b border-white/5 pb-1.5 first:border-0 first:pb-0">
                                        <div className="flex gap-2 shrink-0">
                                            <span className="text-white/40">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                                            <span className={`w-[60px] text-center ${log.level === 'error' ? 'text-red-400 font-bold' : log.level === 'warn' ? 'text-amber-400 font-bold' : 'text-cyan-400'}`}>[{log.level.toUpperCase()}]</span>
                                            <span className={`px-1 rounded text-[10px] ${log.source === 'scheduler' ? 'bg-purple-500/20 text-purple-300' : 'bg-yellow-500/20 text-yellow-300'}`}>{log.source === 'scheduler' ? 'SCH' : 'WEB'}</span>
                                        </div>
                                        <span className={`break-words whitespace-pre-wrap ${log.level === 'error' ? 'text-red-300' : 'text-white'}`}>{formatLogMessage(log.message)}</span>
                                    </div>
                                ))}
                                {visibleHistoricalLogs.length > 0 && (
                                    <>
                                        <div className="text-center text-xs text-white/20 py-1 border-b border-white/5">— older logs —</div>
                                        {[...visibleHistoricalLogs].reverse().map((log, i) => (
                                            <div key={`h-${i}`} className="flex gap-3 w-full border-b border-white/5 pb-1.5 opacity-60">
                                                <div className="flex gap-2 shrink-0">
                                                    <span className="text-white/40">[{new Date(log.ts).toLocaleTimeString()}]</span>
                                                    <span className={`w-[60px] text-center ${log.level === 'error' ? 'text-red-400 font-bold' : log.level === 'warn' ? 'text-amber-400 font-bold' : 'text-cyan-400'}`}>[{log.level.toUpperCase()}]</span>
                                                    <span className={`px-1 rounded text-[10px] ${log.source === 'scheduler' ? 'bg-purple-500/20 text-purple-300' : 'bg-yellow-500/20 text-yellow-300'}`}>{log.source === 'scheduler' ? 'SCH' : 'WEB'}</span>
                                                </div>
                                                <span className={`break-words whitespace-pre-wrap ${log.level === 'error' ? 'text-red-300' : 'text-white'}`}>{formatLogMessage(log.msg)}</span>
                                            </div>
                                        ))}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            ),
        },
        {
            id: "cache-analytics",
            colSpan: 3,
            content: (
                <div className="flex flex-col min-h-[280px] max-h-[480px] md:h-[280px] md:max-h-none">
                    <div className="flex items-center gap-2 mb-4 text-emerald-400 shrink-0">
                        <Activity className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Cache Telemetry</h3>
                    </div>
                    <div className="flex flex-col md:flex-row gap-4 h-full min-h-0">
                        <div className="flex flex-col gap-4 w-full md:w-1/3 shrink-0">
                            <div className="flex flex-col bg-black/20 py-4 px-6 rounded-xl border border-white/5 w-full">
                                <span className="text-xs text-muted-foreground mb-1">Cache Hit Rate</span>
                                <span className="text-2xl font-mono text-white">
                                    {sysMetrics?.cache && (sysMetrics.cache.hits + sysMetrics.cache.misses > 0)
                                        ? `${Math.round((sysMetrics.cache.hits / (sysMetrics.cache.hits + sysMetrics.cache.misses)) * 100)}%`
                                        : '--'}
                                </span>
                            </div>
                            <div className="flex gap-4">
                                <div className="flex flex-col bg-black/20 py-3 px-4 rounded-xl border border-white/5 w-full">
                                    <span className="text-xs text-muted-foreground mb-1">Hits</span>
                                    <span className="text-xl font-mono text-emerald-400">{sysMetrics?.cache?.hits || 0}</span>
                                </div>
                                <div className="flex flex-col bg-black/20 py-3 px-4 rounded-xl border border-white/5 w-full">
                                    <span className="text-xs text-muted-foreground mb-1">Misses</span>
                                    <span className="text-xl font-mono text-amber-400">{sysMetrics?.cache?.misses || 0}</span>
                                </div>
                            </div>
                        </div>
                        <div className="flex-1 flex flex-col p-4 border border-dashed border-white/10 rounded-xl bg-black/40 overflow-hidden relative min-h-[180px] md:min-h-0">
                            {sysMetrics?.cache?.activeEntries && sysMetrics.cache.activeEntries.length > 0 ? (
                                <div className="flex flex-col overflow-y-auto custom-scrollbar gap-2 font-mono text-xs w-full h-full pr-2">
                                    {[...sysMetrics.cache.activeEntries].sort((a, b) => a.remainingTtl - b.remainingTtl).map((entry, idx) => (
                                        <div key={idx} className="flex justify-between items-center w-full border-b border-white/5 pb-1.5 last:border-0 last:pb-0 shrink-0 group">
                                            <span className="text-cyan-400 truncate flex-1 pr-4" title={entry.key}>{entry.key}</span>
                                            <button
                                                onClick={() => api.system.invalidateCache({ key: entry.key }).catch(console.error)}
                                                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/10 text-slate-400 hover:text-emerald-400 mr-2"
                                                title="Invalidate this cache entry"
                                            >
                                                <RefreshCw className="w-3 h-3" />
                                            </button>
                                            <span className={`w-20 text-right ${entry.remainingTtl < 60 ? 'text-red-400 font-bold' : 'text-emerald-400'}`}>
                                                {entry.remainingTtl}s TTL
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex-1 flex items-center justify-center">
                                    <p className="text-muted-foreground text-sm font-medium">Cache is completely empty</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ),
        },
        {
            id: "fetcher-health",
            colSpan: 3,
            content: <FetcherHealthCard />,
        },
        {
            id: "internal-3",
            colSpan: 1,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-emerald-400">
                        <Settings className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Agent Settings</h3>
                    </div>
                    <div className="flex-1 flex flex-col gap-4">
                        <label className="flex items-center justify-between p-3 rounded-xl bg-black/20 border border-white/5 cursor-pointer hover:bg-white/5 transition-colors">
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-white">Autonomous Research</span>
                                <span className="text-xs text-muted-foreground">Allow agent to research missing data context</span>
                            </div>
                            <input
                                type="checkbox"
                                className="toggle"
                                checked={autoResearch}
                                onChange={(e) => setAutoResearch(e.target.checked)}
                            />
                        </label>

                        <label className="flex items-center justify-between p-3 rounded-xl bg-black/20 border border-white/5 cursor-pointer hover:bg-white/5 transition-colors">
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-white">AI Companion <span className="text-amber-400 text-xs font-bold ml-1">PREVIEW</span></span>
                                <span className="text-xs text-muted-foreground">Enable the AI Companion overlay (not yet connected)</span>
                            </div>
                            <input
                                type="checkbox"
                                className="toggle"
                                checked={aiCompanionEnabled}
                                onChange={(e) => setAiCompanionEnabled(e.target.checked)}
                            />
                        </label>

                        <button className="mt-auto px-4 py-2 border border-red-500/50 bg-red-500/10 text-red-400 text-sm rounded-xl font-medium hover:bg-red-500/20 transition-colors w-full">
                            Emergency Stop Agent
                        </button>
                    </div>
                </div>
            ),
        },
        {
            id: "internal-4",
            colSpan: 1,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-blue-400">
                        <Settings className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Application Settings</h3>
                    </div>
                    <div className="flex-1 flex flex-col gap-4">
                        <label className="flex items-center justify-between p-3 rounded-xl bg-black/20 border border-white/5 cursor-pointer hover:bg-white/5 transition-colors">
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-white">Light Mode</span>
                                <span className="text-xs text-muted-foreground">Toggle application light mode</span>
                            </div>
                            <input
                                type="checkbox"
                                className="toggle"
                                checked={!isDarkMode}
                                onChange={(e) => toggleTheme(e.target.checked)}
                            />
                        </label>

                        <div className="flex flex-col gap-4 p-3 rounded-xl bg-black/20 border border-white/5">
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-white flex items-center gap-2">View Colors <Palette className="w-4 h-4 text-primary" /></span>
                                <span className="text-xs text-muted-foreground pb-2">Assign colors to specific views</span>
                            </div>

                            <div className="flex flex-col gap-3">
                                {views.map(view => (
                                    <div key={view.id} className="flex items-center justify-between">
                                        <span className="text-xs text-white/80 w-1/3 truncate">{view.name}</span>
                                        <div className="flex gap-1">
                                            {colorPresets.map(preset => (
                                                <button
                                                    key={preset.name}
                                                    onClick={() => setViewHue(view.id, preset.hue)}
                                                    className={`w-5 h-5 rounded-full ${preset.color} transition-all duration-300 ${viewHues[view.id] === preset.hue ? 'ring-2 ring-white scale-110' : 'opacity-50 hover:opacity-100 hover:scale-110'}`}
                                                    title={preset.name}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            ),
        },
        {
            id: "internal-5",
            colSpan: 1,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-purple-400">
                        <User className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Account Status</h3>
                    </div>
                    <div className="flex-1 flex flex-col gap-4">
                        {session ? (
                            <div className="flex flex-col gap-4 p-4 rounded-xl bg-black/20 border border-white/5">
                                <div className="flex items-center gap-3">
                                    {session.user?.image ? (
                                        <img src={session.user.image} alt="Avatar" className="w-10 h-10 rounded-full border border-slate-700/50" />
                                    ) : (
                                        <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700/50">
                                            <User className="w-5 h-5 text-slate-400" />
                                        </div>
                                    )}
                                    <div className="flex flex-col truncate">
                                        <span className="text-sm font-semibold text-slate-200 truncate">{session.user?.name || "Connected User"}</span>
                                        <span className="text-xs text-slate-500 truncate">{session.user?.email}</span>
                                    </div>
                                </div>
                                <button 
                                    onClick={() => signOut()}
                                    className="flex items-center justify-center gap-2 mt-auto px-4 py-2 border border-slate-700 bg-slate-800 text-sm rounded-xl font-medium hover:bg-slate-700 transition-colors w-full"
                                >
                                    <LogOut className="w-4 h-4" />
                                    Sign Out
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full gap-4 p-4 rounded-xl bg-black/20 border border-white/5 text-center">
                                <span className="text-sm text-slate-400">You are currently disconnected. Sign in via Google Workspace to enable integrations.</span>
                                <button 
                                    onClick={() => signIn("google")}
                                    className="flex items-center justify-center gap-2 mt-auto px-4 py-2 border border-blue-600 bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white text-sm rounded-xl font-medium transition-colors w-full"
                                >
                                    <LogIn className="w-4 h-4" />
                                    Sign In with Google
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            ),
        },
    ], [
        sysMetrics, visibleSysLogs, visibleHistoricalLogs, logSourceFilter, loadingOlder,
        session, isDarkMode, viewHues, views, autoResearch, aiCompanionEnabled,
        loadOlderLogs, setViewHue, toggleTheme, setAutoResearch, setAiCompanionEnabled,
    ]);

    return (
        <Scrollbar className="w-full h-full pb-8">
            <Section title="System Diagnostics" description="Internal system vitals and status logs">
                <CardGrid items={staticCards} />
            </Section>
        </Scrollbar>
    );
};
