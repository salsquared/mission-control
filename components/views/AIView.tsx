"use client";

import React, { useEffect, useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";

export const AIView: React.FC = () => {
    const [hackerNews, setHackerNews] = useState<any[]>([]);
    const [anthropicNews, setAnthropicNews] = useState<any[]>([]);
    const [openaiNews, setOpenaiNews] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchAll = async () => {
            try {
                const [hnRes, anthropicRes, openaiRes] = await Promise.all([
                    fetch("/api/ai").catch(() => null),
                    fetch("/api/company-news?company=anthropic").catch(() => null),
                    fetch("/api/company-news?company=openai").catch(() => null)
                ]);

                if (hnRes && hnRes.ok) {
                    const data = await hnRes.json();
                    if (Array.isArray(data)) setHackerNews(data);
                }
                if (anthropicRes && anthropicRes.ok) {
                    const data = await anthropicRes.json();
                    if (Array.isArray(data)) setAnthropicNews(data);
                }
                if (openaiRes && openaiRes.ok) {
                    const data = await openaiRes.json();
                    if (Array.isArray(data)) setOpenaiNews(data);
                }
            } catch (err) {
                console.error("Error fetching AI news", err);
            } finally {
                setLoading(false);
            }
        };

        fetchAll();
    }, []);

    const newsCards: CardItem[] = loading ? [
        {
            id: "loading-news",
            colSpan: 3,
            content: (
                <div className="flex items-center justify-center py-8 text-emerald-500">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : [
        {
            id: "ai-news-hn",
            colSpan: 1,
            content: <NewsCyclingCard source="Hacker News" articles={hackerNews} />
        },
        {
            id: "ai-news-openai",
            colSpan: 1,
            content: <NewsCyclingCard source="OpenAI" articles={openaiNews} />
        },
        {
            id: "ai-news-anthropic",
            colSpan: 1,
            content: <NewsCyclingCard source="Anthropic" articles={anthropicNews} />
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
            <Section title="AI Chronicles" description="Latest autonomous developments">
                <CardGrid items={newsCards} />
            </Section>
        </div>
    );
};
