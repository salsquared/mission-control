"use client";

import React, { useEffect, useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Loader2 } from "lucide-react";
import { Section } from "../Section";
import { ResearchPaperCard } from "../cards/ResearchPaperCard";

export const PhysicsView: React.FC = () => {
    const [arxivYesterday, setArxivYesterday] = useState<any[]>([]);
    const [arxivLastWeek, setArxivLastWeek] = useState<any[]>([]);
    const [arxivHistorical, setArxivHistorical] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    const handleRefreshYesterday = async () => {
        try {
            const res = await fetch(`/api/research?topic=physics&timeframe=yesterday&limit=5&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setArxivYesterday(data);
            }
        } catch (err) { console.error(err); }
    };

    const handleRefreshWeek = async () => {
        try {
            const res = await fetch(`/api/research?topic=physics&timeframe=week&limit=5&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setArxivLastWeek(data);
            }
        } catch (err) { console.error(err); }
    };

    const handleRefreshHistorical = async () => {
        try {
            const res = await fetch(`/api/research/historical?topic=physics&v=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setArxivHistorical(data);
            }
        } catch (err) { console.error(err); }
    };

    useEffect(() => {
        const fetchAll = async () => {
            try {
                const [arxivYRes, arxivWRes, arxivHistRes] = await Promise.all([
                    fetch(`/api/research?topic=physics&timeframe=yesterday&limit=5&v=${Date.now()}`).catch(() => null),
                    fetch(`/api/research?topic=physics&timeframe=week&limit=5&v=${Date.now()}`).catch(() => null),
                    fetch(`/api/research/historical?topic=physics&v=${Date.now()}`).catch(() => null)
                ]);

                if (arxivYRes?.ok) {
                    const data = await arxivYRes.json();
                    if (Array.isArray(data)) setArxivYesterday(data);
                }
                if (arxivWRes?.ok) {
                    const data = await arxivWRes.json();
                    if (Array.isArray(data)) setArxivLastWeek(data);
                }
                if (arxivHistRes?.ok) {
                    const data = await arxivHistRes.json();
                    if (Array.isArray(data)) setArxivHistorical(data);
                }
            } catch (err) {
                console.error("Error fetching Physics research", err);
            } finally {
                setLoading(false);
            }
        };

        fetchAll();
    }, []);

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
            id: "physics-research-arxiv-yesterday",
            colSpan: 3,
            content: <ResearchPaperCard subject="Top Physics Papers Yesterday" papers={arxivYesterday} onRefresh={handleRefreshYesterday} />
        },
        {
            id: "physics-research-arxiv-week",
            colSpan: 3,
            content: <ResearchPaperCard subject="Top Physics Papers Past Week" papers={arxivLastWeek} onRefresh={handleRefreshWeek} />
        },
        {
            id: "physics-research-arxiv-historical",
            colSpan: 3,
            content: <ResearchPaperCard subject="Historical Physics Paper" papers={arxivHistorical} onRefresh={handleRefreshHistorical} />
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8 relative">
            <Section
                title="Physics Literature"
                description="Latest publications and preprints in Physics"
            >
                <CardGrid items={researchCards} layout="grid" />
            </Section>
        </div>
    );
};
