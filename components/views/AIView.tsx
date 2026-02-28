import React, { useEffect, useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";
import { LLMLeaderboardCard, LLMModelInfo } from "../cards/LLMLeaderboardCard";

export const AIView: React.FC = () => {
    const [hackerNews, setHackerNews] = useState<any[]>([]);
    const [anthropicNews, setAnthropicNews] = useState<any[]>([]);
    const [openaiNews, setOpenaiNews] = useState<any[]>([]);
    const [arxivYesterday, setArxivYesterday] = useState<any[]>([]);
    const [arxivLastWeek, setArxivLastWeek] = useState<any[]>([]);
    const [arxivReview, setArxivReview] = useState<any[]>([]);
    const [arxivHistorical, setArxivHistorical] = useState<any[]>([]);
    const [llmLeaderboard, setLlmLeaderboard] = useState<LLMModelInfo[]>([]);
    const [loading, setLoading] = useState(true);

    const handleRefreshYesterday = async () => {
        try {
            const res = await fetch(`/api/research?topic=ai&timeframe=yesterday&limit=5&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setArxivYesterday(data);
            }
        } catch (err) { console.error(err); }
    };

    const handleRefreshWeek = async () => {
        try {
            const res = await fetch(`/api/research?topic=ai&timeframe=week&limit=5&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setArxivLastWeek(data);
            }
        } catch (err) { console.error(err); }
    };

    const handleRefreshReview = async () => {
        try {
            const res = await fetch(`/api/research/review?topic=ai&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setArxivReview(data);
            }
        } catch (err) { console.error(err); }
    };

    const handleRefreshHistorical = async () => {
        try {
            const res = await fetch(`/api/research/historical?topic=ai&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setArxivHistorical(data);
            }
        } catch (err) { console.error(err); }
    };

    const handleRefreshLeaderboard = async () => {
        try {
            const res = await fetch(`/api/ai/llmleaderboard?v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setLlmLeaderboard(data);
            }
        } catch (err) { console.error(err); }
    };

    useEffect(() => {
        const fetchAll = async () => {
            try {
                const [hnRes, anthropicRes, openaiRes, arxivYRes, arxivWRes, arxivRevRes, arxivHistRes, llmRes] = await Promise.all([
                    fetch(`/api/ai`).catch(() => null),
                    fetch(`/api/company-news?company=anthropic`).catch(() => null),
                    fetch(`/api/company-news?company=openai`).catch(() => null),
                    fetch(`/api/research?topic=ai&timeframe=yesterday&limit=5`).catch(() => null),
                    fetch(`/api/research?topic=ai&timeframe=week&limit=5`).catch(() => null),
                    fetch(`/api/research/review?topic=ai`).catch(() => null),
                    fetch(`/api/research/historical?topic=ai`).catch(() => null),
                    fetch(`/api/ai/llmleaderboard`).catch(() => null)
                ]);

                if (hnRes?.ok) {
                    const data = await hnRes.json();
                    if (Array.isArray(data)) setHackerNews(data);
                }
                if (anthropicRes?.ok) {
                    const data = await anthropicRes.json();
                    if (Array.isArray(data)) setAnthropicNews(data);
                }
                if (openaiRes?.ok) {
                    const data = await openaiRes.json();
                    if (Array.isArray(data)) setOpenaiNews(data);
                }
                if (arxivYRes?.ok) {
                    const data = await arxivYRes.json();
                    if (Array.isArray(data)) setArxivYesterday(data);
                }
                if (arxivWRes?.ok) {
                    const data = await arxivWRes.json();
                    if (Array.isArray(data)) setArxivLastWeek(data);
                }
                if (arxivRevRes?.ok) {
                    const data = await arxivRevRes.json();
                    if (Array.isArray(data)) setArxivReview(data);
                }
                if (arxivHistRes?.ok) {
                    const data = await arxivHistRes.json();
                    if (Array.isArray(data)) setArxivHistorical(data);
                }
                if (llmRes?.ok) {
                    const data = await llmRes.json();
                    if (Array.isArray(data)) setLlmLeaderboard(data);
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
            hFit: true,
            content: <NewsCyclingCard source="Hacker News" articles={hackerNews} />
        },
        {
            id: "ai-news-openai",
            colSpan: 1,
            hFit: true,
            content: <NewsCyclingCard source="OpenAI" articles={openaiNews} />
        },
        {
            id: "ai-news-anthropic",
            colSpan: 1,
            hFit: true,
            content: <NewsCyclingCard source="Anthropic" articles={anthropicNews} />
        }
    ];

    const researchCards: CardItem[] = loading ? [
        {
            id: "loading-research",
            colSpan: 3,
            content: (
                <div className="flex items-center justify-center py-8 text-purple-500">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : [
        {
            id: "ai-research-arxiv-yesterday",
            colSpan: 3,
            content: <ResearchPaperCard subject="Top AI Papers Yesterday" papers={arxivYesterday} onRefresh={handleRefreshYesterday} />
        },
        {
            id: "ai-research-arxiv-week",
            colSpan: 3,
            content: <ResearchPaperCard subject="Top AI Papers Past Week" papers={arxivLastWeek} onRefresh={handleRefreshWeek} />
        },
        {
            id: "ai-research-arxiv-review",
            colSpan: 3,
            content: <ResearchPaperCard subject="Weekly Recommended Review" papers={arxivReview} onRefresh={handleRefreshReview} />
        },
        {
            id: "ai-research-arxiv-historical",
            colSpan: 3,
            content: <ResearchPaperCard subject="Historical Paper of the Week" papers={arxivHistorical} onRefresh={handleRefreshHistorical} />
        }
    ];

    const leaderboardCards: CardItem[] = loading ? [
        {
            id: "loading-leaderboard",
            colSpan: 3,
            content: (
                <div className="flex items-center justify-center py-8 text-indigo-500">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : [
        {
            id: "ai-llm-leaderboard",
            colSpan: 3,
            content: <LLMLeaderboardCard models={llmLeaderboard} onRefresh={handleRefreshLeaderboard} />
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8 relative">
            <Section title="AI Chronicles" description="Latest autonomous developments">
                <CardGrid items={newsCards} layout="grid" />
            </Section>

            <Section title="Chatbot Arena Leaderboard" description="Top models by Arena Elo rating">
                <CardGrid items={leaderboardCards} layout="grid" />
            </Section>

            <Section
                title="Research Papers"
                description="Latest publications and preprints"
            >
                <CardGrid items={researchCards} layout="grid" />
            </Section>
        </div>
    );
};
