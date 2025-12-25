"use client";

import React from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Brain, Cpu, MessageSquare } from "lucide-react";

const aiWidgets: WidgetItem[] = [
    {
        id: "ai-1",
        colSpan: 2,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-emerald-400">
                    <Brain className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Neural Status</h3>
                </div>
                <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                        <span className="text-xs text-muted-foreground">Load</span>
                        <span className="text-xl font-mono text-white">34%</span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-xs text-muted-foreground">Memory</span>
                        <span className="text-xl font-mono text-white">12.4GB</span>
                    </div>
                </div>
            </div>
        ),
    },
    {
        id: "ai-2",
        colSpan: 2,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-blue-400">
                    <MessageSquare className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Recent Interactions</h3>
                </div>
                <ul className="text-xs text-muted-foreground space-y-1">
                    <li>• Researched orbital mechanics</li>
                    <li>• Generated crypto report</li>
                    <li>• Analyzed system logs</li>
                </ul>
            </div>
        ),
    },
];

export const AIDashboard: React.FC = () => {
    return (
        <div className="w-full h-full">
            <WidgetGrid items={aiWidgets} />
        </div>
    );
};
