"use client";

import React, { useEffect, useState } from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Bitcoin, TrendingUp, Wallet, Flame, Loader2 } from "lucide-react";

export const FinanceDashboard: React.FC = () => {
    const [trending, setTrending] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch("/api/finance")
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setTrending(data.slice(0, 6));
                }
                setLoading(false);
            })
            .catch(err => {
                console.error("Error fetching finance data", err);
                setLoading(false);
            });
    }, []);

    const staticWidgets: WidgetItem[] = [
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

    const trendingWidgets: WidgetItem[] = loading ? [
        {
            id: "loading-finance",
            colSpan: 4,
            content: (
                <div className="flex items-center justify-center py-8 text-orange-500">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : trending.map((coin, index) => ({
        id: `coin-${coin.id || index}`,
        colSpan: 1,
        content: (
            <div className="flex flex-col h-full justify-between items-center text-center">
                <div className="flex items-center gap-1 mb-2 text-orange-400/80">
                    <Flame className="w-3 h-3" />
                    <span className="text-[10px] uppercase tracking-wider font-bold">Trending</span>
                </div>
                {coin.thumb && (
                    <img src={coin.thumb} alt={coin.name} className="w-10 h-10 rounded-full mb-2 mx-auto" />
                )}
                <h3 className="text-white font-medium text-sm truncate w-full">
                    {coin.name}
                </h3>
                <span className="text-xs text-muted-foreground uppercase">{coin.symbol}</span>
                <div className="mt-2 text-[10px] text-muted-foreground">Rank #{coin.marketCapRank}</div>
            </div>
        )
    }));

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
            <WidgetGrid items={[...staticWidgets, ...trendingWidgets]} />
        </div>
    );
};
