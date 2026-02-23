"use client";

import React, { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { GraphWidget } from "./GraphWidget";

export interface AssetPriceCardProps {
    title: string;
    icon?: ReactNode;
    price: number | null;
    priceChange24h: number | null;
    lastUpdated: number;
    loading?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    historyData: any[];
    range: string;
    onRangeChange: (range: string) => void;
    LastUpdatedComponent: React.ComponentType<{ timestamp: number; intervalMins: number }>;
    colorClass?: string;
    graphColor?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formatXAxisDate?: (tickItem: any) => string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    formatYAxisPrice?: (val: any) => string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CustomTooltip?: React.FC<any>;
}

export const AssetPriceCard: React.FC<AssetPriceCardProps> = ({
    title,
    icon,
    price,
    priceChange24h,
    lastUpdated,
    loading,
    historyData,
    range,
    onRangeChange,
    LastUpdatedComponent,
    colorClass = "text-orange-400",
    graphColor = "#f97316",
    formatXAxisDate,
    formatYAxisPrice,
    CustomTooltip
}) => {
    return (
        <div className="flex flex-col h-[300px] sm:h-[400px]">
            <div className="flex items-center justify-between mb-4">
                <div className={cn("flex items-center gap-2", colorClass)}>
                    {icon}
                    <h3 className="font-bold tracking-wider uppercase text-lg">{title}</h3>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <LastUpdatedComponent timestamp={lastUpdated} intervalMins={5} />
                </div>
            </div>

            <div className="flex items-baseline gap-4 mb-2">
                <div className="text-4xl font-mono text-white">
                    {loading && (price === null || price === undefined) ? "..." : `$${price?.toLocaleString()}`}
                </div>
                <div className={cn("text-sm font-bold", (priceChange24h ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
                    {loading && (priceChange24h === null || priceChange24h === undefined) ? "..." : `${(priceChange24h ?? 0) >= 0 ? "+" : ""}${priceChange24h?.toFixed(2)}% (24h)`}
                </div>
            </div>

            <GraphWidget
                data={historyData}
                loading={loading}
                xKey="time"
                yKey="price"
                xFormatter={formatXAxisDate}
                yFormatter={formatYAxisPrice}
                CustomTooltip={CustomTooltip}
                color={graphColor}
            />

            <div className="flex gap-2 border border-white/5 rounded-md p-1 bg-black/20 w-max mx-auto mt-4">
                {[
                    { v: "1", l: "1D" },
                    { v: "7", l: "1W" },
                    { v: "30", l: "1M" },
                    { v: "180", l: "6M" },
                    { v: "365", l: "1Y" },
                    { v: "1825", l: "5Y" },
                    { v: "max", l: "MAX" }
                ].map((r) => (
                    <button
                        key={r.v}
                        onClick={() => onRangeChange(r.v)}
                        className={cn(
                            "px-3 py-1 text-xs font-bold rounded bg-transparent transition-colors",
                            range === r.v ? "bg-orange-500 text-white" : "text-muted-foreground hover:text-white"
                        )}
                    >
                        {r.l}
                    </button>
                ))}
            </div>
        </div>
    );
};
