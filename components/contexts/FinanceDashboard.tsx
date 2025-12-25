"use client";

import React from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Bitcoin, TrendingUp, Wallet } from "lucide-react";

const financeWidgets: WidgetItem[] = [
    {
        id: "fin-1",
        colSpan: 1,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-orange-400">
                    <Bitcoin className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Bitcoin</h3>
                </div>
                <div className="text-2xl font-mono text-white">$94,320</div>
                <div className="text-xs text-green-400">+4.2% (24h)</div>
            </div>
        ),
    },
    {
        id: "fin-2",
        colSpan: 2,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-indigo-400">
                    <TrendingUp className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Market Overview</h3>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 bg-white/5 rounded">
                        <span className="text-muted-foreground">ETH</span>
                        <div className="text-white font-mono">$4,850</div>
                    </div>
                    <div className="p-2 bg-white/5 rounded">
                        <span className="text-muted-foreground">SOL</span>
                        <div className="text-white font-mono">$285</div>
                    </div>
                </div>
            </div>
        ),
    },
    {
        id: "fin-3",
        colSpan: 1,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-green-400">
                    <Wallet className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Gas</h3>
                </div>
                <div className="text-xl font-mono text-white">12 Gwei</div>
                <div className="text-xs text-muted-foreground">Low Congestion</div>
            </div>
        ),
    },
];

export const FinanceDashboard: React.FC = () => {
    return (
        <div className="w-full h-full">
            <WidgetGrid items={financeWidgets} />
        </div>
    );
};
