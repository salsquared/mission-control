"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";
import { fetcher } from "@/lib/fetcher-client";

export const PhysicsView: React.FC = () => {
    const { data: arxivYesterday, refetch: refetchY } = useQuery<any[]>({ queryKey: ['research', 'physics', 'yesterday'], queryFn: () => fetcher('/api/research?topic=physics&timeframe=yesterday&limit=5') });
    const { data: arxivLastWeek, refetch: refetchW } = useQuery<any[]>({ queryKey: ['research', 'physics', 'week'], queryFn: () => fetcher('/api/research?topic=physics&timeframe=week&limit=5') });
    const { data: arxivReview, refetch: refetchRev } = useQuery<any[]>({ queryKey: ['research', 'physics', 'review'], queryFn: () => fetcher('/api/research/review?topic=physics') });
    const { data: arxivHistorical, refetch: refetchHist } = useQuery<any[]>({ queryKey: ['research', 'physics', 'historical'], queryFn: () => fetcher('/api/research/historical?topic=physics') });

    const loading = !arxivYesterday && !arxivLastWeek && !arxivReview && !arxivHistorical;

    const researchCards: CardItem[] = loading ? [
        { id: "loading-research", colSpan: 3, content: (
            <div className="flex items-center justify-center py-8 text-purple-500">
                <Loader2 className="w-8 h-8 animate-spin" />
            </div>
        )}
    ] : [
        { id: "physics-research-arxiv-yesterday", colSpan: 3, content: <ResearchPaperCard subject="Top Physics Papers Yesterday" papers={arxivYesterday ?? []} onRefresh={() => refetchY()} /> },
        { id: "physics-research-arxiv-week", colSpan: 3, content: <ResearchPaperCard subject="Top Physics Papers Past Week" papers={arxivLastWeek ?? []} onRefresh={() => refetchW()} /> },
        { id: "physics-research-arxiv-review", colSpan: 3, content: <ResearchPaperCard subject="Weekly Recommended Review" papers={arxivReview ?? []} onRefresh={() => refetchRev()} /> },
        { id: "physics-research-arxiv-historical", colSpan: 3, content: <ResearchPaperCard subject="Historical Physics Paper" papers={arxivHistorical ?? []} onRefresh={() => refetchHist()} /> }
    ];

    return (
        <Scrollbar className="w-full h-full pb-8 relative">
            <Section title="Physics Literature" description="Latest publications and preprints in Physics">
                <CardGrid items={researchCards} layout="grid" />
            </Section>
        </Scrollbar>
    );
};
