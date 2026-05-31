"use client";

import React, { useState, useEffect } from "react";
import { BookOpen, User, Quote, ArrowUp, RefreshCw, AlertTriangle } from "lucide-react";
import { CarouselControls } from "../ui/CarouselControls";
import { PaperActions } from "../ui/PaperActions";
import { api } from "@/lib/api-client";
import { Card } from "../ui/Card";

interface Paper {
    id: string;
    title: string;
    summary: string;
    url: string;
    author: string;
    published_at: string;
    source: string;
    arxivId?: string; // Kept for legacy compatibility if needed
    paperId?: string;
    upvotes?: number;
    citationCount?: number;
    status?: 'READ' | 'READ_LATER' | 'FAVORITE' | null;
}

interface ResearchPaperCardProps {
    subject: string;
    papers: Paper[];
    onRefresh?: () => void;
    isRefreshing?: boolean;
    errorMessage?: string;
}

export const ResearchPaperCard: React.FC<ResearchPaperCardProps> = ({ subject, papers, onRefresh, isRefreshing, errorMessage }) => {
    const [currentIndex, setCurrentIndex] = useState(0);

    useEffect(() => {
        if (!papers || papers.length <= 1) return;
        const interval = setInterval(() => {
            setCurrentIndex((prev) => (prev + 1) % papers.length);
        }, 60000); // 1 minute per paper

        return () => clearInterval(interval);
    }, [papers, currentIndex]);

    const nextPaper = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setCurrentIndex((prev) => (prev + 1) % papers.length);
    };

    const prevPaper = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setCurrentIndex((prev) => (prev - 1 + papers.length) % papers.length);
    };

    // Local optimistic UI state for saving
    const [localStatuses, setLocalStatuses] = useState<Record<string, string>>({});

    if (!papers || papers.length === 0) {
        const hasError = !!errorMessage;
        return (
            <Card
                title={`arXiv • ${subject}`}
                icon={BookOpen}
                iconColorClass="text-purple-400"
                wrapperClassName="min-h-[160px]"
            >
                <div className="flex-1 flex flex-col items-center justify-center text-white/40 text-sm gap-2 mt-4 px-4 text-center">
                    {hasError ? (
                        <div className="flex items-start gap-2 text-amber-400/80">
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span>{errorMessage}</span>
                        </div>
                    ) : (
                        <span>No papers found for this period.</span>
                    )}
                    {onRefresh && (
                        <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRefresh(); }}
                            disabled={isRefreshing}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 hover:text-white transition-colors text-xs cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                            <span>{isRefreshing ? 'Refreshing…' : 'Refresh'}</span>
                        </button>
                    )}
                </div>
            </Card>
        );
    }

    const currentPaper = papers[currentIndex];

    const handleSave = async (e: React.MouseEvent, status: string) => {
        e.preventDefault();
        e.stopPropagation();

        const paper = papers[currentIndex];
        const idToUse = paper.paperId || paper.arxivId;
        if (!idToUse) return;

        // Toggle logic: if already this status, remove it (DELETE)
        const currentStatus = localStatuses[idToUse] || paper.status;
        const isRemoving = currentStatus === status;

        setLocalStatuses(prev => ({ ...prev, [idToUse]: isRemoving ? '' : status }));

        try {
            if (isRemoving) {
                await api.savedPapers.delete(idToUse);
            } else {
                await api.savedPapers.upsert({
                    paperId: idToUse,
                    title: paper.title,
                    summary: paper.summary,
                    url: paper.url,
                    authors: paper.author,
                    publishedAt: paper.published_at,
                    topic: subject.toLowerCase().includes('space') ? 'Space' : subject.toLowerCase().includes('crypto') ? 'Crypto' : 'AI',
                    status,
                });
            }
        } catch (error) {
            console.error("Failed to save paper", error);
            // Revert on fail
            setLocalStatuses(prev => ({ ...prev, [idToUse]: currentStatus || '' }));
        }
    };

    const activeStatus = localStatuses[currentPaper.paperId || currentPaper.arxivId || ''] || currentPaper.status;

    return (
        <Card
            title={`arXiv • ${subject}`}
            icon={BookOpen}
            iconColorClass="text-purple-400"
            wrapperClassName="group relative"
            action={
                <div className="flex items-center gap-3 shrink-0">
                    {/* Metrics Badges */}
                    <div className="flex items-center gap-2">
                        {currentPaper.upvotes !== undefined && (
                            <div className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full font-medium" title="Hugging Face Upvotes">
                                <ArrowUp className="w-3 h-3 text-amber-400" />
                                {currentPaper.upvotes} HF
                            </div>
                        )}
                        {currentPaper.citationCount !== undefined && (
                            <div className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full font-medium" title="Semantic Scholar Citations">
                                <Quote className="w-3 h-3 fill-emerald-400" />
                                {currentPaper.citationCount}
                            </div>
                        )}
                    </div>

                    {/* Pagination Indicators and Controls */}
                    <CarouselControls
                        currentIndex={currentIndex}
                        totalItems={papers.length}
                        onNext={nextPaper}
                        onPrev={prevPaper}
                    />
                </div>
            }
        >
            <div className="flex w-full gap-2 items-start relative mb-4 shrink-0">
                <h3 className="text-white font-medium text-base group-hover:text-purple-400 transition-colors flex-1 pr-1" title={currentPaper.title}>
                    <a href={currentPaper.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {currentPaper.title}
                    </a>
                </h3>
                <div className="text-right text-[10px] sm:text-xs text-muted-foreground mt-0.5 shrink-0 whitespace-nowrap">
                    {new Date(currentPaper.published_at).toLocaleDateString()}
                </div>
            </div>

            <div className="flex-1 relative mb-4 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="text-sm text-white/80 leading-relaxed whitespace-pre-line md:columns-2 md:gap-8 text-justify">
                    {currentPaper.summary}
                </div>
            </div>

            <div className="flex items-center justify-between mt-auto pt-4 border-t border-white/10 z-20 shrink-0">
                <div className="flex items-center gap-2 text-xs text-white/50 w-2/3">
                    <User className="w-4 h-4 shrink-0" />
                    <span className="truncate">{currentPaper.author}</span>
                </div>

                {/* Save Actions */}
                {(currentPaper.arxivId || currentPaper.paperId) && (
                    <PaperActions
                        activeStatus={activeStatus}
                        onAction={handleSave}
                        onRefresh={onRefresh}
                    />
                )}
            </div>
        </Card>
    );
};
