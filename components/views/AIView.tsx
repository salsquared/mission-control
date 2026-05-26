import React, { useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";
import { LLMLeaderboardCard, LLMModelInfo } from "../cards/ai/LLMLeaderboardCard";
import { COMPANIES as COMPANY_REGISTRY } from "../../lib/companies/manifest";
import { fetcher } from "@/lib/fetcher-client";

const AI_COMPANIES = COMPANY_REGISTRY.filter(c => c.view === 'ai');
const AI_CATEGORIES = ['AI Model Developers', 'Fabless', 'AI Accelerators', 'IP/Architecture', 'Foundries', 'News Sources'];

function useCompanyNews(companies: typeof AI_COMPANIES) {
    const results = useQueries({
        queries: companies.map(c => ({
            queryKey: ['company-news', c.id],
            queryFn: () => fetcher<any[]>(`/api/company-news?company=${c.id}`),
        })),
    });
    const newsMap: Record<string, any[]> = {};
    companies.forEach((c, i) => {
        const data = results[i].data;
        if (Array.isArray(data) && data.length > 0) newsMap[c.name] = data;
    });
    const isLoading = results.some(r => r.isLoading);
    return { newsMap, isLoading };
}

export const AIView: React.FC = () => {
    const [llmCategory, setLlmCategory] = useState("text");

    const qHN = useQuery<any[]>({ queryKey: ['ai', 'hn'], queryFn: () => fetcher('/api/ai') });
    const qY = useQuery<any[]>({ queryKey: ['research', 'ai', 'yesterday'], queryFn: () => fetcher('/api/research?topic=ai&timeframe=yesterday&limit=5') });
    const qW = useQuery<any[]>({ queryKey: ['research', 'ai', 'week'], queryFn: () => fetcher('/api/research?topic=ai&timeframe=week&limit=5') });
    const qRev = useQuery<any[]>({ queryKey: ['research', 'ai', 'review'], queryFn: () => fetcher('/api/research/review?topic=ai') });
    const qHist = useQuery<any[]>({ queryKey: ['research', 'ai', 'historical'], queryFn: () => fetcher('/api/research/historical?topic=ai') });
    const { data: hackerNews } = qHN;
    const { data: arxivYesterday, refetch: refetchY } = qY;
    const { data: arxivLastWeek, refetch: refetchW } = qW;
    const { data: arxivReview, refetch: refetchRev } = qRev;
    const { data: arxivHistorical, refetch: refetchHist } = qHist;
    const { data: llmLeaderboard, refetch: refetchLLM } = useQuery<LLMModelInfo[]>({ queryKey: ['ai', 'llmleaderboard', llmCategory], queryFn: () => fetcher(`/api/ai/llmleaderboard?category=${llmCategory}`) });

    const { newsMap: companyNews, isLoading: companyLoading } = useCompanyNews(AI_COMPANIES);

    // Spinner only while every query is still pending. Once any settle (data
    // OR error), surface the cards so failed ones expose a manual refresh.
    const newsLoading = qHN.isPending;
    const researchLoading = qY.isPending && qW.isPending && qRev.isPending && qHist.isPending;

    const buildCompanyGroups = () => {
        if (companyLoading) return [];
        return AI_CATEGORIES.map(category => {
            const items: CardItem[] = AI_COMPANIES
                .filter(c => c.category === category && companyNews[c.name]?.length)
                .map(c => ({ id: `ai-news-${c.id}`, colSpan: 1 as const, hFit: true, content: <NewsCyclingCard source={c.name} articles={companyNews[c.name]} /> }));
            return items.length > 0 ? { label: category, items } : null;
        }).filter(Boolean) as { label: string; items: CardItem[] }[];
    };

    const hnCards: CardItem[] = newsLoading ? [{ id: "loading-news", colSpan: 3, content: <div className="flex items-center justify-center py-8 text-emerald-500"><Loader2 className="w-8 h-8 animate-spin" /></div> }]
        : (hackerNews ?? []).length > 0 ? [{ id: "ai-news-hn", colSpan: 1, hFit: true, content: <NewsCyclingCard source="Hacker News" articles={hackerNews!} /> }]
        : [];

    const researchCards: CardItem[] = researchLoading ? [{ id: "loading-research", colSpan: 3, content: <div className="flex items-center justify-center py-8 text-purple-500"><Loader2 className="w-8 h-8 animate-spin" /></div> }]
        : [
            { id: "ai-research-arxiv-yesterday", colSpan: 3, content: <ResearchPaperCard subject="Top AI Papers Yesterday" papers={arxivYesterday ?? []} onRefresh={() => refetchY()} isRefreshing={qY.isFetching} errorMessage={qY.isError ? "arXiv is rate-limiting us. Try again in a minute." : undefined} /> },
            { id: "ai-research-arxiv-week", colSpan: 3, content: <ResearchPaperCard subject="Top AI Papers Past Week" papers={arxivLastWeek ?? []} onRefresh={() => refetchW()} isRefreshing={qW.isFetching} errorMessage={qW.isError ? "arXiv is rate-limiting us. Try again in a minute." : undefined} /> },
            { id: "ai-research-arxiv-review", colSpan: 3, content: <ResearchPaperCard subject="Weekly Recommended Review" papers={arxivReview ?? []} onRefresh={() => refetchRev()} isRefreshing={qRev.isFetching} errorMessage={qRev.isError ? "arXiv is rate-limiting us. Try again in a minute." : undefined} /> },
            { id: "ai-research-arxiv-historical", colSpan: 3, content: <ResearchPaperCard subject="Historical Paper of the Week" papers={arxivHistorical ?? []} onRefresh={() => refetchHist()} isRefreshing={qHist.isFetching} errorMessage={qHist.isError ? "arXiv is rate-limiting us. Try again in a minute." : undefined} /> }
        ];

    const leaderboardCategories = [
        { id: 'text', label: 'Text' }, { id: 'code', label: 'Code' }, { id: 'vision', label: 'Vision' },
        { id: 'text-to-image', label: 'Text-to-Image' }, { id: 'image-edit', label: 'Image Edit' },
        { id: 'search', label: 'Search' }, { id: 'text-to-video', label: 'Text-to-Video' }, { id: 'image-to-video', label: 'Image-to-Video' },
    ];

    const leaderboardCards: CardItem[] = !llmLeaderboard ? [{ id: "loading-leaderboard", colSpan: 3, content: <div className="flex items-center justify-center py-8 text-indigo-500"><Loader2 className="w-8 h-8 animate-spin" /></div> }]
        : [{ id: "ai-llm-leaderboard", colSpan: 3, content: (
            <LLMLeaderboardCard
                models={llmLeaderboard}
                onRefresh={() => refetchLLM()}
                activeCategory={llmCategory}
                categories={leaderboardCategories}
                onCategoryChange={(cat) => { setLlmCategory(cat); }}
            />
        )}];

    return (
        <Scrollbar className="w-full h-full pb-8 relative">
            <Section title="AI News" description="Latest autonomous developments">
                <CardGrid items={hnCards} layout="masonry" />
            </Section>
            <Section title="Company News" description="Direct feeds from AI companies" groups={buildCompanyGroups()}>
                {companyLoading && <CardGrid items={[{ id: "loading-company-news", colSpan: 3, content: <div className="flex items-center justify-center py-8 text-blue-500"><Loader2 className="w-8 h-8 animate-spin" /></div> }]} layout="grid" />}
            </Section>
            <Section title="Chatbot Arena Leaderboard" description="Top models by Arena Elo rating">
                <CardGrid items={leaderboardCards} layout="grid" />
            </Section>
            <Section title="Research Papers" description="Latest publications and preprints">
                <CardGrid items={researchCards} layout="grid" />
            </Section>
        </Scrollbar>
    );
};
