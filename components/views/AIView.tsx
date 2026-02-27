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
    const [arxivReview, setArxivReview] = useState<any[]>([]);
    const [arxivHistorical, setArxivHistorical] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshKey, setRefreshKey] = useState(Date.now());

    const handleRefresh = () => {
        setRefreshKey(Date.now());
    };

    useEffect(() => {
        const fetchAll = async () => {
            try {
                const cacheBuster = `?v=${refreshKey}`;
                const cb = cacheBuster.replace('?', '&');

                const [hnRes, anthropicRes, openaiRes, arxivYRes, arxivWRes, arxivRevRes, arxivHistRes] = await Promise.all([
                    fetch(`/api/ai${cacheBuster}`).catch(() => null),
                    fetch(`/api/company-news?company=anthropic${cb}`).catch(() => null),
                    fetch(`/api/company-news?company=openai${cb}`).catch(() => null),
                    fetch(`/api/research?topic=ai&timeframe=yesterday&limit=5${cb}`).catch(() => null),
                    fetch(`/api/research?topic=ai&timeframe=week&limit=5${cb}`).catch(() => null),
                    fetch(`/api/research/review?topic=ai${cb}`).catch(() => null),
                    fetch(`/api/research/historical?topic=ai${cb}`).catch(() => null)
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
            } catch (err) {
                console.error("Error fetching AI news", err);
            } finally {
                setLoading(false);
            }
        };

        fetchAll();
    }, [refreshKey]);

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
            content: <ResearchPaperCard subject="Top AI Papers Yesterday" papers={arxivYesterday} onRefresh={handleRefresh} />
        },
        {
            id: "ai-research-arxiv-week",
            colSpan: 3,
            content: <ResearchPaperCard subject="Top AI Papers Past Week" papers={arxivLastWeek} onRefresh={handleRefresh} />
        },
        {
            id: "ai-research-arxiv-review",
            colSpan: 3,
            content: <ResearchPaperCard subject="Weekly Recommended Review" papers={arxivReview} onRefresh={handleRefresh} />
        },
        {
            id: "ai-research-arxiv-historical",
            colSpan: 3,
            content: <ResearchPaperCard subject="Historical Paper of the Week" papers={arxivHistorical} onRefresh={handleRefresh} />
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8 relative">
            <Section title="AI Chronicles" description="Latest autonomous developments">
                <CardGrid items={newsCards} layout="grid" />
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
