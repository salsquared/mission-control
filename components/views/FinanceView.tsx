"use client";

import React, { useEffect, useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Bitcoin, TrendingUp, Wallet, Flame, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AssetPriceCard } from "../cards/AssetPriceCard";
import { MarketTop100Card } from "../cards/MarketTop100Card";
import { Section } from "../Section";

const LastUpdated: React.FC<{ timestamp: number; intervalMins: number }> = ({ timestamp, intervalMins }) => {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(interval);
    }, []);

    if (!timestamp) return null;
    const diff = Math.floor((now - timestamp) / 60000);
    const agoText = diff === 0 ? "just now" : diff === 1 ? "1m ago" : `${diff}m ago`;
    return (
        <div className="text-[9px] text-muted-foreground/60 tracking-widest uppercase flex items-center gap-1">
            {intervalMins}m <span className="text-white/10">|</span> {agoText}
        </div>
    );
};

export const FinanceView: React.FC = () => {

    const [top100, setTop100] = useState<any[]>([]);

    const [prices, setPrices] = useState<any>({
        bitcoin: { usd: 0, usd_24h_change: 0 },
        ethereum: { usd: 0 },
        solana: { usd: 0 }
    });

    const [fees, setFees] = useState<any>({});
    const [lastUpdated, setLastUpdated] = useState<number>(0);

    const [historyData, setHistoryData] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [range, setRange] = useState("1"); // days: '1', '7', '30'

    const formatXAxisDate = (tickItem: number) => {
        const d = new Date(tickItem);

        if (range === "1") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

        const getOrdinalNum = (n: number) => {
            const s = ["th", "st", "nd", "rd"];
            const v = n % 100;
            return n + (s[(v - 20) % 10] || s[v] || s[0]);
        };

        const monthStr = d.toLocaleDateString([], { month: "short" });

        if (range === "7" || range === "30") {
            return `${monthStr} ${getOrdinalNum(d.getDate())}`;
        }

        const shortYear = d.getFullYear().toString().slice(-2);
        return `${monthStr} '${shortYear}`;
    };

    const CustomTooltip = ({ active, payload, label }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-black/80 border border-white/10 p-2 rounded text-xs font-mono">
                    <p className="text-muted-foreground mb-1">{new Date(label).toLocaleString()}</p>
                    <p className="text-orange-400 font-bold">${payload[0].value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                </div>
            );
        }
        return null;
    };

    const fetchFinance = async () => {
        try {
            const res = await fetch("/api/finance");
            const data = await res.json();
            if (data?.top100) setTop100(data.top100);
            if (data?.prices) {
                setPrices(data.prices);
                // initial history load if returned from finance
                if (data.prices.bitcoin?.history && historyData.length === 0) {
                    setHistoryData(data.prices.bitcoin.history);
                }
            }
            if (data?.fees) {
                setFees(data.fees);
            }
            if (data?.timestamp) {
                setLastUpdated(data.timestamp);
            }
        } catch (err) {
            console.error("Error fetching finance data", err);
        } finally {
            setLoading(false);
        }
    };

    const fetchHistory = async (days: string) => {
        try {
            const res = await fetch(`/api/finance/history?range=${days}&coin=bitcoin`, { cache: 'no-store' });
            const data = await res.json();
            if (data?.history) {
                setHistoryData(data.history);
            }
        } catch (err) {
            console.error("Error fetching history", err);
        }
    };

    useEffect(() => {
        fetchFinance();
        const interval = setInterval(() => {
            fetchFinance();
        }, 300000); // 5 min polling
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        fetchHistory(range);
        const interval = setInterval(() => {
            fetchHistory(range);
        }, 300000); // 5 min polling
        return () => clearInterval(interval);
    }, [range]);

    const staticCards: CardItem[] = [
        {
            id: "fin-1",
            colSpan: 2,
            rowSpan: 2,
            content: (
                <AssetPriceCard
                    title="Bitcoin"
                    icon={<Bitcoin className="w-6 h-6" />}
                    price={prices.bitcoin?.usd ?? null}
                    priceChange24h={prices.bitcoin?.usd_24h_change ?? null}
                    lastUpdated={lastUpdated}
                    loading={loading}
                    historyData={historyData}
                    range={range}
                    onRangeChange={setRange}
                    LastUpdatedComponent={LastUpdated}
                    formatXAxisDate={formatXAxisDate}
                    CustomTooltip={CustomTooltip}
                />
            ),
        },
        {
            id: "fin-2",
            colSpan: 1,
            rowSpan: 2, // Take up more vertical space for the list
            content: (
                <MarketTop100Card
                    top100={top100}
                    loading={loading}
                    lastUpdated={lastUpdated}
                    LastUpdatedComponent={LastUpdated}
                />
            ),
        },
        {
            id: "fin-3",
            colSpan: 1,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-green-400">
                            <Wallet className="w-5 h-5" />
                            <h3 className="font-bold tracking-wider uppercase text-sm">Gas</h3>
                        </div>
                        <LastUpdated timestamp={lastUpdated} intervalMins={5} />
                    </div>
                    <div className="flex items-center justify-center flex-1 w-full h-full bg-black/20 rounded-lg border border-white/5 py-8 min-h-[120px]">
                        <div className="text-center">
                            <div className="text-3xl font-mono text-white mb-1">{loading || !fees?.fastestFee ? "..." : `${fees.fastestFee} sat/vB`}</div>
                            <div className="text-xs text-muted-foreground font-bold uppercase tracking-wider">{loading || !fees?.fastestFee ? "..." : "High Priority"}</div>
                        </div>
                    </div>
                </div>
            ),
        },
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
            <Section title="Market Overview" description="Real-time cryptocurrency statistics">
                <CardGrid items={staticCards} />
            </Section>
        </div>
    );
};
