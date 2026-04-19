"use client";

import React, { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { GraphWidget } from "../widgets/GraphWidget";
import { Card } from "../ui/Card";

export interface AssetPriceCardProps {
    title: string;
    icon?: ReactNode;
    price: number | null;
    priceChange24h: number | null;
    lastUpdated: number;
    loading?: boolean;
     
    historyData: any[];
    range: string;
    onRangeChange: (range: string) => void;
    LastUpdatedComponent: React.ComponentType<{ timestamp: number; intervalMins: number }>;
    colorClass?: string;
    graphColor?: string;
     
    formatXAxisDate?: (tickItem: any) => string;
     
    formatYAxisPrice?: (val: any) => string;
     
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
    formatYAxisPrice = (val: any) => {
        if (typeof val !== 'number') return val;
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            notation: 'compact',
            maximumSignificantDigits: 3
        }).format(val);
    },
    CustomTooltip
}) => {
    return (
        <Card
            title={title}
            icon={icon}
            iconColorClass={colorClass}
            loading={loading}
            wrapperClassName="h-[300px] sm:h-[400px]"
            action={<LastUpdatedComponent timestamp={lastUpdated} intervalMins={5} />}
        >
            <div className="flex items-center gap-4 mb-2">
                <div className="text-4xl font-mono font-bold text-white">
                    {price === null || price === undefined ? "—" : `$${price?.toLocaleString()}`}
                </div>
                <div className={cn("text-sm font-bold", (priceChange24h ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
                    {priceChange24h === null || priceChange24h === undefined ? "—" : `${(priceChange24h ?? 0) >= 0 ? "+" : ""}${priceChange24h?.toFixed(2)}% (24h)`}
                </div>
            </div>

            <GraphWidget
                data={historyData}
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
        </Card>
    );
};
