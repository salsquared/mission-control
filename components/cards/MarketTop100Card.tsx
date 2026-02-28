import React from "react";
import { TrendingUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface MarketTop100CardProps {
    top100: any[];
    loading: boolean;
    lastUpdated: number;
    LastUpdatedComponent: React.ComponentType<{ timestamp: number; intervalMins: number }>;
}

export const MarketTop100Card: React.FC<MarketTop100CardProps> = ({
    top100,
    loading,
    lastUpdated,
    LastUpdatedComponent,
}) => {
    return (
        <div className="flex flex-col h-[300px] sm:h-[400px]">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-indigo-400">
                    <TrendingUp className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Market Top 100</h3>
                </div>
                <LastUpdatedComponent timestamp={lastUpdated} intervalMins={5} />
            </div>
            <div className="flex items-center justify-between px-3 pb-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider border-b border-white/5 mr-2 mb-2">
                <div className="flex items-center gap-3 flex-1">
                    <span className="w-4 text-left">#</span>
                    <span className="ml-1 text-left">Project Name</span>
                </div>
                <div className="flex items-center gap-4 justify-end shrink-0">
                    <span className="hidden sm:block w-[60px] text-right">MCap</span>
                    <span className="min-w-[70px] text-right">Price</span>
                </div>
            </div>
            <div className="flex flex-col gap-2 text-xs flex-1 overflow-y-auto pr-2 custom-scrollbar">
                {loading && top100.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-indigo-500">
                        <Loader2 className="w-6 h-6 animate-spin" />
                    </div>
                ) : (
                    top100.map((coin: any) => (
                        <div
                            key={coin.id}
                            className="flex justify-between items-center p-2 bg-white/5 rounded-lg border border-white/5 shrink-0 hover:bg-white/10 transition-colors"
                        >
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="text-muted-foreground font-mono text-[10px] w-4 text-left">
                                    {coin.marketCapRank}
                                </div>
                                <img
                                    src={coin.image}
                                    alt={coin.name}
                                    className="w-6 h-6 rounded-full shrink-0"
                                />
                                <div className="flex flex-col min-w-0">
                                    <span className="text-white font-bold truncate max-w-[80px] sm:max-w-[120px]">
                                        {coin.name}
                                    </span>
                                    <span className="text-muted-foreground font-mono text-[10px] uppercase truncate">
                                        {coin.symbol}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-4 justify-end shrink-0">
                                <div className="text-[10px] text-muted-foreground font-mono hidden sm:block w-[60px] text-right">
                                    ${(coin.marketCap / 1e9).toFixed(2)}B
                                </div>
                                <div className="flex flex-col items-end min-w-[70px]">
                                    <div className="text-white font-mono text-sm">
                                        $
                                        {coin.currentPrice.toLocaleString(undefined, {
                                            minimumFractionDigits: coin.currentPrice < 1 ? 4 : 2,
                                            maximumFractionDigits: coin.currentPrice < 1 ? 4 : 2,
                                        })}
                                    </div>
                                    <div
                                        className={cn(
                                            "text-[10px] font-bold",
                                            coin.priceChange24h >= 0 ? "text-green-400" : "text-red-400"
                                        )}
                                    >
                                        {coin.priceChange24h >= 0 ? "+" : ""}
                                        {coin.priceChange24h?.toFixed(2)}%
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
