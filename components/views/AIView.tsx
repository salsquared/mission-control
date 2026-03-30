import React, { useEffect, useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";
import { LLMLeaderboardCard, LLMModelInfo } from "../cards/LLMLeaderboardCard";
import { COMPANY_REGISTRY } from "../../lib/company-registry";

// All AI-view companies from the registry
const AI_COMPANIES = COMPANY_REGISTRY.filter(c => c.view === 'ai');

// Ordered category labels for display grouping
const AI_CATEGORIES = [
    'AI Model Developers',
    'Fabless',
    'AI Accelerators',
    'IP/Architecture',
    'Foundries',
    'News Sources',
];

export const AIView: React.FC = () => {
    const [companyNews, setCompanyNews] = useState<Record<string, any[]>>({});
    const [hackerNews, setHackerNews] = useState<any[]>([]);
    const [arxivYesterday, setArxivYesterday] = useState<any[]>([]);
    const [arxivLastWeek, setArxivLastWeek] = useState<any[]>([]);
    const [arxivReview, setArxivReview] = useState<any[]>([]);
    const [arxivHistorical, setArxivHistorical] = useState<any[]>([]);
    const [llmLeaderboard, setLlmLeaderboard] = useState<LLMModelInfo[]>([]);
    const [llmCategory, setLlmCategory] = useState("text");
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
            const res = await fetch(`/api/ai/llmleaderboard?category=${llmCategory}&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setLlmLeaderboard(data);
            }
        } catch (err) { console.error(err); }
    };

    const handleLeaderboardCategoryChange = async (category: string) => {
        setLlmCategory(category);
        // We can optionally show loading or just clear current list, removing clearing to prevent layout jumps right now is better.
        try {
            const res = await fetch(`/api/ai/llmleaderboard?category=${category}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setLlmLeaderboard(data);
            }
        } catch (err) { console.error(err); }
    };

    useEffect(() => {
        const fetchAll = async () => {
            try {
                // Fetch all AI companies from registry
                const companyFetches = AI_COMPANIES.map(c =>
                    fetch(`/api/company-news?company=${c.id}`)
                        .then(res => res.ok ? res.json() : [])
                        .catch(() => [])
                );

                const [
                    hnRes,
                    arxivYRes, arxivWRes, arxivRevRes, arxivHistRes, llmRes,
                    ...companyResults
                ] = await Promise.all([
                    fetch(`/api/ai`).catch(() => null),
                    fetch(`/api/research?topic=ai&timeframe=yesterday&limit=5`).catch(() => null),
                    fetch(`/api/research?topic=ai&timeframe=week&limit=5`).catch(() => null),
                    fetch(`/api/research/review?topic=ai`).catch(() => null),
                    fetch(`/api/research/historical?topic=ai`).catch(() => null),
                    fetch(`/api/ai/llmleaderboard?category=text`).catch(() => null),
                    ...companyFetches
                ]);

                if (hnRes?.ok) {
                    const data = await hnRes.json();
                    if (Array.isArray(data)) setHackerNews(data);
                }

                // Build company news map from registry results
                const newsMap: Record<string, any[]> = {};
                AI_COMPANIES.forEach((company, i) => {
                    const articles = companyResults[i];
                    if (Array.isArray(articles) && articles.length > 0) {
                        newsMap[company.name] = articles;
                    }
                });
                setCompanyNews(newsMap);

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

    // Build grouped company news for the Section groups prop
    const buildCompanyGroups = () => {
        if (loading) return [];

        const groups: { label: string; items: CardItem[] }[] = [];

        for (const category of AI_CATEGORIES) {
            const companiesInCategory = AI_COMPANIES.filter(c => c.category === category);
            const categoryCards: CardItem[] = [];

            for (const company of companiesInCategory) {
                const articles = companyNews[company.name];
                if (articles && articles.length > 0) {
                    categoryCards.push({
                        id: `ai-news-${company.id}`,
                        colSpan: 1,
                        hFit: true,
                        content: <NewsCyclingCard source={company.name} articles={articles} />
                    });
                }
            }

            if (categoryCards.length > 0) {
                groups.push({ label: category, items: categoryCards });
            }
        }

        return groups;
    };

    // Build Hacker News card (general AI news aggregator)
    const hnCards: CardItem[] = loading ? [{
        id: "loading-news",
        colSpan: 3,
        content: (
            <div className="flex items-center justify-center py-8 text-emerald-500">
                <Loader2 className="w-8 h-8 animate-spin" />
            </div>
        )
    }] : hackerNews.length > 0 ? [{
        id: "ai-news-hn",
        colSpan: 1,
        hFit: true,
        content: <NewsCyclingCard source="Hacker News" articles={hackerNews} />
    }] : [];

    const companyGroups = buildCompanyGroups();

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

    const leaderboardCategories = [
        { id: 'text', label: 'Text' },
        { id: 'code', label: 'Code' },
        { id: 'vision', label: 'Vision' },
        { id: 'text-to-image', label: 'Text-to-Image' },
        { id: 'image-edit', label: 'Image Edit' },
        { id: 'search', label: 'Search' },
        { id: 'text-to-video', label: 'Text-to-Video' },
        { id: 'image-to-video', label: 'Image-to-Video' },
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
            content: (
                <LLMLeaderboardCard
                    models={llmLeaderboard}
                    onRefresh={handleRefreshLeaderboard}
                    activeCategory={llmCategory}
                    categories={leaderboardCategories}
                    onCategoryChange={handleLeaderboardCategoryChange}
                />
            )
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8 relative">
            <Section title="AI News" description="Latest autonomous developments">
                <CardGrid items={hnCards} layout="masonry" />
            </Section>

            <Section
                title="Company News"
                description="Direct feeds from AI companies"
                groups={companyGroups}
            />

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
