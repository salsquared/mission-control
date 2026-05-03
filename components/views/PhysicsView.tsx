"use client";

import React from "react";
import useSWR from "swr";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";
import { fetcher } from "@/lib/fetcher-client";

export const PhysicsView: React.FC = () => {
    const { data: arxivYesterday, mutate: mutateY } = useSWR<any[]>('/api/research?topic=physics&timeframe=yesterday&limit=5', fetcher);
    const { data: arxivLastWeek, mutate: mutateW } = useSWR<any[]>('/api/research?topic=physics&timeframe=week&limit=5', fetcher);
    const { data: arxivReview, mutate: mutateRev } = useSWR<any[]>('/api/research/review?topic=physics', fetcher);
    const { data: arxivHistorical, mutate: mutateHist } = useSWR<any[]>('/api/research/historical?topic=physics', fetcher);

    const loading = !arxivYesterday && !arxivLastWeek && !arxivReview && !arxivHistorical;

    const handleRefresh = async (mutate: () => void) => { mutate(); };

    const researchCards: CardItem[] = loading ? [
        { id: "loading-research", colSpan: 3, content: (
            <div className="flex items-center justify-center py-8 text-purple-500">
                <Loader2 className="w-8 h-8 animate-spin" />
            </div>
        )}
    ] : [
        { id: "physics-research-arxiv-yesterday", colSpan: 3, content: <ResearchPaperCard subject="Top Physics Papers Yesterday" papers={arxivYesterday ?? []} onRefresh={() => mutateY()} /> },
        { id: "physics-research-arxiv-week", colSpan: 3, content: <ResearchPaperCard subject="Top Physics Papers Past Week" papers={arxivLastWeek ?? []} onRefresh={() => mutateW()} /> },
        { id: "physics-research-arxiv-review", colSpan: 3, content: <ResearchPaperCard subject="Weekly Recommended Review" papers={arxivReview ?? []} onRefresh={() => mutateRev()} /> },
        { id: "physics-research-arxiv-historical", colSpan: 3, content: <ResearchPaperCard subject="Historical Physics Paper" papers={arxivHistorical ?? []} onRefresh={() => mutateHist()} /> }
    ];

    return (
        <Scrollbar className="w-full h-full pb-8 relative">
            <Section title="Physics Literature" description="Latest publications and preprints in Physics">
                <CardGrid items={researchCards} layout="grid" />
            </Section>
        </Scrollbar>
    );
};
