"use client";

import React, { useEffect, useState } from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Rocket, Satellite, ThermometerSun, Newspaper, Loader2 } from "lucide-react";

export const SpaceDashboard: React.FC = () => {
    const [news, setNews] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch("/api/space")
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setNews(data.slice(0, 4));
                }
                setLoading(false);
            })
            .catch(err => {
                console.error("Error fetching space news", err);
                setLoading(false);
            });
    }, []);

    const staticWidgets: WidgetItem[] = [
        {
            id: "space-1",
            colSpan: 2,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-2 text-cyan-400">
                        <Rocket className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Next Launch</h3>
                    </div>
                    <div className="flex-1 flex flex-col justify-center">
                        <div className="text-3xl font-mono text-white">T-Minus 04:20:00</div>
                        <div className="text-xs text-muted-foreground mt-1">Starship IFT-4 • Boca Chica</div>
                    </div>
                </div>
            ),
        },
        {
            id: "space-2",
            colSpan: 1,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-2 text-purple-400">
                        <Satellite className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Active Sats</h3>
                    </div>
                    <div className="text-2xl font-bold text-white">4,218</div>
                    <div className="text-xs text-muted-foreground">Starlink Constellation</div>
                </div>
            ),
        },
        {
            id: "space-3",
            colSpan: 1,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-2 text-yellow-400">
                        <ThermometerSun className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Solar Activity</h3>
                    </div>
                    <div className="text-xl font-bold text-white">Normal</div>
                    <div className="text-xs text-muted-foreground">X-Ray Flux: A4.2</div>
                </div>
            ),
        },
    ];

    const newsWidgets: WidgetItem[] = loading ? [
        {
            id: "loading-news",
            colSpan: 4,
            content: (
                <div className="flex items-center justify-center h-full w-full text-cyan-500 py-8">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : news.map((article, index) => ({
        id: `news-${article.id || index}`,
        colSpan: 2,
        content: (
            <div className="flex flex-col h-full justify-between group relative">
                <div>
                    <div className="flex items-center gap-2 mb-2 text-cyan-400">
                        <Newspaper className="w-4 h-4" />
                        <span className="text-xs uppercase tracking-wider font-bold">{article.news_site}</span>
                    </div>
                    <h3 className="text-white font-medium text-sm line-clamp-2 mb-2 group-hover:text-cyan-400 transition-colors">
                        {article.title}
                    </h3>
                </div>
                {article.image_url && (
                    <div className="w-full h-24 rounded-md overflow-hidden bg-black/50 mt-2">
                        <img src={article.image_url} alt={article.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                    </div>
                )}
                <a href={article.url} target="_blank" rel="noreferrer" className="absolute inset-0 z-10" />
            </div>
        )
    }));

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
            <WidgetGrid items={[...staticWidgets, ...newsWidgets]} />
        </div>
    );
};
