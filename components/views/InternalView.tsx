"use client";

import React, { useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Brain, MessageSquare, Shield, Activity, Settings, Database, Server } from "lucide-react";
import { Section } from "../Section";

export const InternalView: React.FC = () => {
    // Dummy state for settings toggles
    const [autoResearch, setAutoResearch] = useState(true);
    const [backgroundTasks, setBackgroundTasks] = useState(true);
    const [isDarkMode, setIsDarkMode] = useState(true);

    const toggleTheme = (checked: boolean) => {
        setIsDarkMode(checked);
        if (!checked) {
            document.documentElement.classList.add("light");
        } else {
            document.documentElement.classList.remove("light");
        }
    };

    const staticCards: CardItem[] = [
        {
            id: "internal-1",
            colSpan: 3,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-4 text-purple-400">
                        <Activity className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Agent System Telemetry</h3>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6 flex-1">
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5">
                            <span className="text-xs text-muted-foreground mb-1">CPU Load</span>
                            <span className="text-2xl font-mono text-white">42%</span>
                        </div>
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5">
                            <span className="text-xs text-muted-foreground mb-1">Memory Usage</span>
                            <span className="text-2xl font-mono text-white">14.2 GB</span>
                        </div>
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5">
                            <span className="text-xs text-muted-foreground mb-1">Active Tasks</span>
                            <span className="text-2xl font-mono text-white">12</span>
                        </div>
                        <div className="flex flex-col bg-black/20 p-4 rounded-xl border border-white/5">
                            <span className="text-xs text-muted-foreground mb-1">Agent Uptime</span>
                            <span className="text-2xl font-mono text-white">72h 14m</span>
                        </div>
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
                    <div className="flex-1 overflow-y-auto pr-2 space-y-3 font-mono text-xs">
                        <div className="flex flex-col gap-1 border-b border-white/5 pb-2">
                            <span className="text-cyan-500">[19:42:15] SYSTEM</span>
                            <span className="text-white/80">Completed background synchronization of rocket telemetry</span>
                        </div>
                        <div className="flex flex-col gap-1 border-b border-white/5 pb-2">
                            <span className="text-purple-500">[19:40:02] AGENT</span>
                            <span className="text-white/80">Compiled daily crypto market analysis report</span>
                        </div>
                        <div className="flex flex-col gap-1 border-b border-white/5 pb-2">
                            <span className="text-emerald-500">[19:35:50] NETWORK</span>
                            <span className="text-white/80">Re-established secure connection to external API</span>
                        </div>
                        <div className="flex flex-col gap-1 border-b border-white/5 pb-2">
                            <span className="text-cyan-500">[19:30:11] SYSTEM</span>
                            <span className="text-white/80">Cleaned up temporary workspace directories</span>
                        </div>
                        <div className="flex flex-col gap-1 pb-2">
                            <span className="text-purple-500">[19:15:00] AGENT</span>
                            <span className="text-white/80">Parsed inbound emails and categorized accordingly</span>
                        </div>
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
                                onChange={(e) => toggleTheme(!e.target.checked)}
                            />
                        </label>
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
