"use client";

import React, { useEffect, useState } from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Terminal, Loader2, Newspaper } from "lucide-react";

export const AINewsDashboard: React.FC = () => {
    const [news, setNews] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch("/api/ai")
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setNews(data); // Displaying all fetched news
                }
                setLoading(false);
            })
            .catch(err => {
                console.error("Error fetching AI news", err);
                setLoading(false);
            });
    }, []);

    const newsWidgets: WidgetItem[] = loading ? [
        {
            id: "loading-news",
            colSpan: 4,
            content: (
                <div className="flex items-center justify-center py-8 text-emerald-500">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : news.map((article, index) => ({
        id: `ai-news-${article.id || index}`,
        colSpan: 2,
        content: (
            <div className="flex flex-col h-full justify-start group relative">
                <div className="flex items-center gap-2 mb-3 text-emerald-400/80">
                    <Newspaper className="w-4 h-4" />
                    <span className="text-xs uppercase tracking-wider font-bold">{article.source}</span>
                </div>
                <h3 className="text-white font-medium text-sm leading-relaxed mb-2 group-hover:text-emerald-300 transition-colors">
                    {article.title}
                </h3>
                <div className="mt-auto text-xs text-muted-foreground flex items-center justify-between">
                    <span>{article.author ? `by ${article.author}` : 'Hacker News'}</span>
                    <span>{new Date(article.publishedAt).toLocaleDateString()}</span>
                </div>
                <a href={article.url} target="_blank" rel="noreferrer" className="absolute inset-0 z-10" />
            </div>
        )
    }));

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
            <WidgetGrid items={newsWidgets} />
        </div>
    );
};
