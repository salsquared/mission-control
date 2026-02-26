"use client";

import React, { useEffect, useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";

export const AIView: React.FC = () => {
    const [hackerNews, setHackerNews] = useState<any[]>([]);
    const [anthropicNews, setAnthropicNews] = useState<any[]>([]);
    const [openaiNews, setOpenaiNews] = useState<any[]>([]);
    const [arxivYesterday, setArxivYesterday] = useState<any[]>([]);
    const [arxivLastWeek, setArxivLastWeek] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchAll = async () => {
            try {
                // Use a cache-busting parameter based on time or version to bust stale 30-item array caches 
                // lingering in the browser's disk cache or NextJS global cache.
                const cacheBuster = `?v=2`;

                const now = new Date();
                const pad = (n: number) => n.toString().padStart(2, '0');

                // Yesterday date strings
                const yesterday = new Date(now);
                yesterday.setDate(now.getDate() - 1);
                const yFrom = `${yesterday.getFullYear()}${pad(yesterday.getMonth() + 1)}${pad(yesterday.getDate())}0000`;
                const yTo = `${yesterday.getFullYear()}${pad(yesterday.getMonth() + 1)}${pad(yesterday.getDate())}2359`;

                // Last week date strings
                const lastWeek = new Date(now);
                lastWeek.setDate(now.getDate() - 7);
                const wFrom = `${lastWeek.getFullYear()}${pad(lastWeek.getMonth() + 1)}${pad(lastWeek.getDate())}0000`;
                const wTo = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}2359`;

                const [hnRes, anthropicRes, openaiRes, arxivYRes, arxivWRes] = await Promise.all([
                    fetch(`/api/ai${cacheBuster}`).catch(() => null),
                    fetch(`/api/company-news?company=anthropic&v=2`).catch(() => null),
                    fetch(`/api/company-news?company=openai&v=2`).catch(() => null),
                    fetch(`/api/arxiv?subject=cs.AI&max_results=5&dateFrom=${yFrom}&dateTo=${yTo}&v=1`).catch(() => null),
                    fetch(`/api/arxiv?subject=cs.AI&max_results=5&dateFrom=${wFrom}&dateTo=${wTo}&v=1`).catch(() => null)
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
                if (arxivYRes && arxivYRes.ok) {
                    const data = await arxivYRes.json();
                    if (Array.isArray(data)) setArxivYesterday(data);
                }
                if (arxivWRes && arxivWRes.ok) {
                    const data = await arxivWRes.json();
                    if (Array.isArray(data)) setArxivLastWeek(data);
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

    const researchCards: CardItem[] = loading ? [
        {
            id: "loading-research",
            colSpan: 3,
            content: (
                <div className="flex items-center justify-center py-8 text-emerald-500">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : [
        {
            id: "ai-research-arxiv-yesterday",
            colSpan: 2,
            content: <ResearchPaperCard subject="Top AI Papers Yesterday" papers={arxivYesterday} />
        },
        {
            id: "ai-research-arxiv-week",
            colSpan: 2,
            content: <ResearchPaperCard subject="Top AI Papers Past Week" papers={arxivLastWeek} />
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
            <Section title="AI Chronicles" description="Latest autonomous developments">
                <CardGrid items={newsCards} layout="masonry" />
            </Section>

            <Section title="Research Papers" description="Latest publications and preprints">
                <CardGrid items={researchCards} layout="grid" />
            </Section>
        </div>
    );
};
