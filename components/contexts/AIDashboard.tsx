"use client";

import React, { useEffect, useState } from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Brain, MessageSquare, Terminal, Loader2 } from "lucide-react";

export const AIDashboard: React.FC = () => {
    const [news, setNews] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch("/api/ai")
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setNews(data.slice(0, 4));
                }
                setLoading(false);
            })
            .catch(err => {
                console.error("Error fetching AI news", err);
                setLoading(false);
            });
    }, []);

    const staticWidgets: WidgetItem[] = [
        {
            id: "ai-1",
            colSpan: 2,
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-2 text-emerald-400">
                        <Brain className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Neural Status</h3>
                    </div>
                    <div className="flex flex-1 items-center gap-6">
                        <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground mb-1">Load</span>
                            <span className="text-3xl font-mono text-white">34%</span>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground mb-1">Memory</span>
                            <span className="text-3xl font-mono text-white">12.4GB</span>
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
                    <ul className="text-sm text-muted-foreground flex flex-col justify-center flex-1 space-y-2">
                        <li className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-blue-500/50" /> Researched orbital mechanics</li>
                        <li className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-blue-500/50" /> Generated crypto report</li>
                        <li className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-blue-500/50" /> Analyzed system logs</li>
                    </ul>
                </div>
            ),
        },
    ];

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
                    <Terminal className="w-4 h-4" />
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
            <WidgetGrid items={[...staticWidgets, ...newsWidgets]} />
        </div>
    );
};
