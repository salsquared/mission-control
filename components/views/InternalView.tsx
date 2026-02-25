"use client";

import React, { useEffect, useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Brain, MessageSquare, Shield, Activity, Settings, Database, Server, Palette, Cpu } from "lucide-react";
import { Section } from "../Section";
import { useThemeStore } from "@/components/providers/themeStore";
import { useSettingsStore } from "@/components/providers/settingsStore";

export const InternalView: React.FC = () => {
    const [sysMetrics, setSysMetrics] = useState<{ cpuUsagePercent: number; memoryUsageFormatted: string; uptimeFormatted: string; dbConnected: boolean } | null>(null);

    useEffect(() => {
        const fetchMetrics = async () => {
            try {
                const res = await fetch('/api/system');
                if (res.ok) {
                    const data = await res.json();
                    setSysMetrics(data);
                }
            } catch (error) {
                console.error("Failed to fetch system metrics", error);
            }
        };

        fetchMetrics();
        const interval = setInterval(fetchMetrics, 5000);
        return () => clearInterval(interval);
    }, []);

    // Persisted settings store
    const { autoResearch, setAutoResearch, backgroundTasks, setBackgroundTasks } = useSettingsStore();

    // Global Theme State
    const { isDarkMode, setIsDarkMode, viewHues, setViewHue } = useThemeStore();

    const colorPresets = [
        { name: "Purple", hue: 250, color: "bg-purple-500" },
        { name: "Pink", hue: 320, color: "bg-pink-500" },
        { name: "Rose", hue: 350, color: "bg-rose-500" },
        { name: "Amber", hue: 50, color: "bg-amber-500" },
        { name: "Emerald", hue: 150, color: "bg-emerald-500" },
        { name: "Cyan", hue: 190, color: "bg-cyan-500" },
        { name: "Blue", hue: 220, color: "bg-blue-500" },
    ];

    const views = [
        { id: "rocketry", name: "Launches & Telemetry" },
        { id: "crypto", name: "Market Analysis" },
        { id: "ai-news", name: "AI News" },
        { id: "ai-partner", name: "Internal Systems" },
    ];

    const toggleTheme = (checked: boolean) => {
        setIsDarkMode(!checked); // because the UI assumes toggle is "Light Mode On" when checked
    };

    const staticCards: CardItem[] = [
        {
            id: "system-telemetry",
            colSpan: 3,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-purple-400">
                        <Cpu className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">System Telemetry</h3>
                    </div>
                    <div className="flex flex-wrap md:flex-nowrap justify-between gap-4 md:gap-6 flex-1 w-full">
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">CPU Load</span>
                            <span className="text-2xl font-mono text-white">{sysMetrics ? `${sysMetrics.cpuUsagePercent}%` : '--'}</span>
                        </div>
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">Memory Usage</span>
                            <span className="text-2xl font-mono text-white">{sysMetrics ? sysMetrics.memoryUsageFormatted : '--'}</span>
                        </div>
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
                            <span className="text-xs text-muted-foreground mb-1">Server Uptime</span>
                            <span className="text-2xl font-mono text-white">{sysMetrics ? sysMetrics.uptimeFormatted : '--'}</span>
                        </div>
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5 w-fit shrink-0 whitespace-nowrap">
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
            colSpan: 2,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-cyan-400">
                        <Server className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Background Event Log</h3>
                    </div>
                    <div className="flex-1 flex items-center justify-center p-6 border border-dashed border-white/10 rounded-xl bg-black/20">
                        <p className="text-muted-foreground text-sm font-medium">Event logging currently offline</p>
                    </div>
                </div>
            ),
        },
        {
            id: "internal-3",
            colSpan: 2,
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
                                <span className="text-sm font-medium text-white">Background Execution</span>
                                <span className="text-xs text-muted-foreground">Let system jobs queue and run silently</span>
                            </div>
                            <input
                                type="checkbox"
                                className="toggle"
                                checked={backgroundTasks}
                                onChange={(e) => setBackgroundTasks(e.target.checked)}
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
            colSpan: 2,
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
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
            <Section title="System Diagnostics" description="Internal system vitals and status logs">
                <CardGrid items={staticCards} />
            </Section>
        </div>
    );
};
