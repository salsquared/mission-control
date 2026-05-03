import React, { useState } from "react";
import useSWR from "swr";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";
import { LLMLeaderboardCard, LLMModelInfo } from "../cards/LLMLeaderboardCard";
import { COMPANY_REGISTRY } from "../../lib/company-registry";
import { fetcher } from "@/lib/fetcher-client";

const AI_COMPANIES = COMPANY_REGISTRY.filter(c => c.view === 'ai');
const AI_CATEGORIES = ['AI Model Developers', 'Fabless', 'AI Accelerators', 'IP/Architecture', 'Foundries', 'News Sources'];

// Stable hook for per-company news
function useCompanyNews(companies: typeof AI_COMPANIES) {
    // SWR doesn't support conditional array of hooks, so we fetch all in a batch via useSWR with a null key pattern.
    // Each company gets its own SWR key — React rules of hooks: we call them for each company in a fixed-length array.
    const results = companies.map(c => {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        return useSWR<any[]>(`/api/company-news?company=${c.id}`, fetcher);
    });
    const newsMap: Record<string, any[]> = {};
    companies.forEach((c, i) => {
        const data = results[i].data;
        if (Array.isArray(data) && data.length > 0) newsMap[c.name] = data;
    });
    const isLoading = results.some(r => !r.data && !r.error);
    return { newsMap, isLoading };
}

export const AIView: React.FC = () => {
    const [llmCategory, setLlmCategory] = useState("text");

    const { data: hackerNews, mutate: mutateHN } = useSWR<any[]>('/api/ai', fetcher);
    const { data: arxivYesterday, mutate: mutateY } = useSWR<any[]>('/api/research?topic=ai&timeframe=yesterday&limit=5', fetcher);
    const { data: arxivLastWeek, mutate: mutateW } = useSWR<any[]>('/api/research?topic=ai&timeframe=week&limit=5', fetcher);
    const { data: arxivReview, mutate: mutateRev } = useSWR<any[]>('/api/research/review?topic=ai', fetcher);
    const { data: arxivHistorical, mutate: mutateHist } = useSWR<any[]>('/api/research/historical?topic=ai', fetcher);
    const { data: llmLeaderboard, mutate: mutateLLM } = useSWR<LLMModelInfo[]>(`/api/ai/llmleaderboard?category=${llmCategory}`, fetcher);

    const { newsMap: companyNews, isLoading: companyLoading } = useCompanyNews(AI_COMPANIES);

    const loading = !hackerNews || !arxivYesterday;

    const buildCompanyGroups = () => {
        if (companyLoading) return [];
        return AI_CATEGORIES.map(category => {
            const items: CardItem[] = AI_COMPANIES
                .filter(c => c.category === category && companyNews[c.name]?.length)
                .map(c => ({ id: `ai-news-${c.id}`, colSpan: 1 as const, hFit: true, content: <NewsCyclingCard source={c.name} articles={companyNews[c.name]} /> }));
            return items.length > 0 ? { label: category, items } : null;
        }).filter(Boolean) as { label: string; items: CardItem[] }[];
    };

    const hnCards: CardItem[] = loading ? [{ id: "loading-news", colSpan: 3, content: <div className="flex items-center justify-center py-8 text-emerald-500"><Loader2 className="w-8 h-8 animate-spin" /></div> }]
        : (hackerNews ?? []).length > 0 ? [{ id: "ai-news-hn", colSpan: 1, hFit: true, content: <NewsCyclingCard source="Hacker News" articles={hackerNews!} /> }]
        : [];

    const researchCards: CardItem[] = loading ? [{ id: "loading-research", colSpan: 3, content: <div className="flex items-center justify-center py-8 text-purple-500"><Loader2 className="w-8 h-8 animate-spin" /></div> }]
        : [
            { id: "ai-research-arxiv-yesterday", colSpan: 3, content: <ResearchPaperCard subject="Top AI Papers Yesterday" papers={arxivYesterday ?? []} onRefresh={() => mutateY()} /> },
            { id: "ai-research-arxiv-week", colSpan: 3, content: <ResearchPaperCard subject="Top AI Papers Past Week" papers={arxivLastWeek ?? []} onRefresh={() => mutateW()} /> },
            { id: "ai-research-arxiv-review", colSpan: 3, content: <ResearchPaperCard subject="Weekly Recommended Review" papers={arxivReview ?? []} onRefresh={() => mutateRev()} /> },
            { id: "ai-research-arxiv-historical", colSpan: 3, content: <ResearchPaperCard subject="Historical Paper of the Week" papers={arxivHistorical ?? []} onRefresh={() => mutateHist()} /> }
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
                onRefresh={() => mutateLLM()}
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
