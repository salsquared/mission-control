"use client";

import React, { useState, useEffect } from "react";
import { BookOpen, ChevronLeft, ChevronRight, User } from "lucide-react";

interface Paper {
    id: string;
    title: string;
    summary: string;
    url: string;
    author: string;
    published_at: string;
    source: string;
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

    return (
        <div className="flex flex-col flex-1 justify-between group relative h-full">
            <div className="flex-shrink-0 mb-4">
                <div className="flex items-center gap-2 mb-2 text-purple-400">
                    <BookOpen className="w-4 h-4" />
                    <span className="text-xs uppercase tracking-wider font-bold">arXiv • {subject}</span>
                </div>
                <div className="flex w-full gap-2 items-start relative">
                    <h3 className="text-white font-medium text-base group-hover:text-purple-400 transition-colors flex-1 pr-1" title={currentPaper.title}>
                        {currentPaper.title}
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

            <div className="flex items-center gap-2 text-xs text-white/50 mt-auto pt-4 border-t border-white/10">
                <User className="w-4 h-4" />
                <span className="truncate">{currentPaper.author}</span>
            </div>

            <a href={currentPaper.url} target="_blank" rel="noreferrer" className="absolute inset-0 z-10" />

            {/* Pagination Indicators and Controls */}
            {papers.length > 1 && (
                <div className="absolute top-0 right-0 flex items-center gap-2 z-20">
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
    );
};
