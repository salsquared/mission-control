"use client";

import React, { useState, useEffect } from "react";
import { Newspaper, ChevronLeft, ChevronRight } from "lucide-react";


interface Article {
    id: string | number;
    title: string;
    url: string;
    image_url?: string;
    news_site: string;
    published_at?: string;
    publishedAt?: string;
}

interface NewsCyclingCardProps {
    source: string;
    articles: Article[];
}

export const NewsCyclingCard: React.FC<NewsCyclingCardProps> = ({ source, articles }) => {
    const [currentIndex, setCurrentIndex] = useState(0);

    useEffect(() => {
        if (articles.length <= 1) return;
        const interval = setInterval(() => {
            setCurrentIndex((prev) => (prev + 1) % articles.length);
        }, 8000); // 8 seconds per article

        return () => clearInterval(interval);
    }, [articles.length, currentIndex]);

    const nextArticle = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setCurrentIndex((prev) => (prev + 1) % articles.length);
    };

    const prevArticle = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setCurrentIndex((prev) => (prev - 1 + articles.length) % articles.length);
    };

    if (!articles || articles.length === 0) return null;

    const currentArticle = articles[currentIndex];
    const dateStr = currentArticle.published_at || currentArticle.publishedAt;

    return (
        <div className={`flex flex-col flex-1 justify-between group relative h-full ${currentArticle.image_url ? 'min-h-[160px]' : ''}`}>
            <div className="flex-shrink-0">
                <div className="flex items-center gap-2 mb-2 text-cyan-400">
                    <Newspaper className="w-4 h-4" />
                    <span className="text-xs uppercase tracking-wider font-bold">{source}</span>
                </div>
                <div className="flex w-full gap-2 items-start mb-2 relative">
                    <h3 className="text-white font-medium text-sm line-clamp-3 group-hover:text-cyan-400 transition-colors flex-1 pr-1">
                        {currentArticle.title}
                    </h3>
                    {dateStr && (
                        <div className="text-right text-[10px] sm:text-xs text-muted-foreground mt-0.5 shrink-0 whitespace-nowrap">
                            {new Date(dateStr).toLocaleDateString()}
                        </div>
                    )}
                </div>
            </div>

            {currentArticle.image_url ? (
                <div
                    className="w-full flex-1 flex flex-col justify-end mt-2 min-h-[128px]"
                    style={{ containerType: 'inline-size' } as React.CSSProperties}
                >
                    <div className="w-full rounded-md overflow-hidden relative flex">
                        <img
                            src={currentArticle.image_url}
                            alt={currentArticle.title}
                            className="w-full object-cover bg-black/50 group-hover:scale-105 transition-transform duration-500"
                            style={{ maxHeight: '100cqw' }}
                        />
                    </div>
                </div>
            ) : (
                <div className="w-full h-2 mt-2 shrink-0" /> // spacer
            )}
            <a href={currentArticle.url} target="_blank" rel="noreferrer" className="absolute inset-0 z-10" />

            {/* Pagination Indicators and Controls */}
            {articles.length > 1 && (
                <div className="absolute top-0 right-0 flex items-center gap-2 z-20">
                    <div className="flex gap-1">
                        {articles.map((_, i) => (
                            <div
                                key={i}
                                className={`h-1.5 rounded-full transition-all duration-300 ${i === currentIndex ? 'w-3 bg-cyan-400' : 'w-1.5 bg-white/20'}`}
                            />
                        ))}
                    </div>
                    <div className="flex gap-0.5">
                        <button
                            onClick={prevArticle}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="p-0.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer" title="Previous Story">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                            onClick={nextArticle}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="p-0.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer" title="Next Story">
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
