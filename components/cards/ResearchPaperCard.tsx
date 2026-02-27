"use client";

import React, { useState, useEffect } from "react";
import { BookOpen, ChevronLeft, ChevronRight, User, Bookmark, Heart, Check, Star, Quote, ArrowUp } from "lucide-react";

interface Paper {
    id: string;
    title: string;
    summary: string;
    url: string;
    author: string;
    published_at: string;
    source: string;
    arxivId?: string;
    upvotes?: number;
    citationCount?: number;
    status?: 'READ' | 'READ_LATER' | 'FAVORITE' | null;
}

interface ResearchPaperCardProps {
    subject: string;
    papers: Paper[];
}

export const ResearchPaperCard: React.FC<ResearchPaperCardProps> = ({ subject, papers }) => {
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

    if (!papers || papers.length === 0) return null;

    const currentPaper = papers[currentIndex];

    // Local optimistic UI state for saving
    const [localStatuses, setLocalStatuses] = useState<Record<string, string>>({});

    const handleSave = async (e: React.MouseEvent, status: string) => {
        e.preventDefault();
        e.stopPropagation();

        const paper = papers[currentIndex];
        if (!paper.arxivId) return;

        // Toggle logic: if already this status, remove it (DELETE)
        const currentStatus = localStatuses[paper.arxivId] || paper.status;
        const isRemoving = currentStatus === status;

        setLocalStatuses(prev => ({ ...prev, [paper.arxivId!]: isRemoving ? '' : status }));

        try {
            if (isRemoving) {
                await fetch(`/api/research/saved?arxivId=${paper.arxivId}`, { method: 'DELETE' });
            } else {
                await fetch('/api/research/saved', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        arxivId: paper.arxivId,
                        title: paper.title,
                        summary: paper.summary,
                        url: paper.url,
                        authors: paper.author,
                        publishedAt: paper.published_at,
                        topic: subject.toLowerCase().includes('space') ? 'Space' : subject.toLowerCase().includes('crypto') ? 'Crypto' : 'AI', // Simple topic derivation
                        status
                    })
                });
            }
        } catch (error) {
            console.error("Failed to save paper", error);
            // Revert on fail
            setLocalStatuses(prev => ({ ...prev, [paper.arxivId!]: currentStatus || '' }));
        }
    };

    const activeStatus = localStatuses[currentPaper.arxivId || ''] || currentPaper.status;

    return (
        <div className="flex flex-col flex-1 justify-between group relative h-full">
            <div className="flex-shrink-0 mb-4">
                <div className="flex items-center justify-between gap-4 mb-2">
                    {/* Left: Source */}
                    <div className="flex items-center gap-2 text-purple-400 min-w-0 flex-1">
                        <BookOpen className="w-4 h-4 shrink-0" />
                        <span className="text-xs uppercase tracking-wider font-bold truncate" title={`arXiv • ${subject}`}>arXiv • {subject}</span>
                    </div>

                    {/* Right: Metrics & Pagination */}
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
                        {papers.length > 1 && (
                            <div className="flex items-center gap-2 z-20 shrink-0">
                                <div className="flex gap-1 hidden sm:flex">
                                    {papers.map((_, i) => (
                                        <div
                                            key={i}
                                            className={`h-1.5 rounded-full transition-all duration-300 ${i === currentIndex ? 'w-3 bg-purple-400' : 'w-1.5 bg-white/20'}`}
                                        />
                                    ))}
                                </div>
                                <div className="flex gap-0.5 bg-black/50 rounded-md backdrop-blur-sm">
                                    <button
                                        onClick={prevPaper}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        className="p-0.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer" title="Previous Paper">
                                        <ChevronLeft className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={nextPaper}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        className="p-0.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer" title="Next Paper">
                                        <ChevronRight className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex w-full gap-2 items-start relative">
                    <h3 className="text-white font-medium text-base group-hover:text-purple-400 transition-colors flex-1 pr-1" title={currentPaper.title}>
                        <a href={currentPaper.url} target="_blank" rel="noreferrer" className="hover:underline">
                            {currentPaper.title}
                        </a>
                    </h3>
                    <div className="text-right text-[10px] sm:text-xs text-muted-foreground mt-0.5 shrink-0 whitespace-nowrap">
                        {new Date(currentPaper.published_at).toLocaleDateString()}
                    </div>
                </div>
            </div>

            <div className="flex-1 relative mb-4">
                <div className="text-sm text-white/80 leading-relaxed whitespace-pre-line">
                    {currentPaper.summary}
                </div>
            </div>

            <div className="flex items-center justify-between mt-auto pt-4 border-t border-white/10 z-20">
                <div className="flex items-center gap-2 text-xs text-white/50 w-2/3">
                    <User className="w-4 h-4 shrink-0" />
                    <span className="truncate">{currentPaper.author}</span>
                </div>

                {/* Save Actions */}
                {currentPaper.arxivId && (
                    <div className="flex items-center gap-1 bg-black/40 rounded-full p-0.5 border border-white/5">
                        <button
                            onClick={(e) => handleSave(e, 'READ')}
                            className={`p-1.5 rounded-full transition-colors ${activeStatus === 'READ' ? 'bg-emerald-500/20 text-emerald-400' : 'text-white/40 hover:text-emerald-400 hover:bg-white/10'}`}
                            title="Mark as Read"
                        >
                            <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={(e) => handleSave(e, 'READ_LATER')}
                            className={`p-1.5 rounded-full transition-colors ${activeStatus === 'READ_LATER' ? 'bg-blue-500/20 text-blue-400' : 'text-white/40 hover:text-blue-400 hover:bg-white/10'}`}
                            title="Read Later"
                        >
                            <Bookmark className={`w-3.5 h-3.5 ${activeStatus === 'READ_LATER' ? 'fill-blue-400' : ''}`} />
                        </button>
                        <button
                            onClick={(e) => handleSave(e, 'FAVORITE')}
                            className={`p-1.5 rounded-full transition-colors ${activeStatus === 'FAVORITE' ? 'bg-rose-500/20 text-rose-400' : 'text-white/40 hover:text-rose-400 hover:bg-white/10'}`}
                            title="Favorite"
                        >
                            <Heart className={`w-3.5 h-3.5 ${activeStatus === 'FAVORITE' ? 'fill-rose-400' : ''}`} />
                        </button>
                    </div>
                )}
            </div>

        </div>
    );
};
