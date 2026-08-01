"use client";

import React, { useState, useEffect } from "react";
import { Newspaper, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Card } from "../ui/Card";
import { cn } from "@/lib/utils";
import type { LatestArticle } from "@/lib/news/latest";

interface HeroNewsCarouselProps {
    /** Newest-first, pre-deduped — build with `selectLatestArticles(newsMap)`. */
    articles: LatestArticle[];
    /** True only while we have nothing to show yet; a partially-arrived set renders. */
    loading?: boolean;
    /** ms per slide. 0 disables auto-advance. */
    intervalMs?: number;
}

const HERO_HEIGHT = "h-64 md:h-96";

export const HeroNewsCarousel: React.FC<HeroNewsCarouselProps> = ({
    articles,
    loading = false,
    intervalMs = 8000,
}) => {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [paused, setPaused] = useState(false);

    // Auto-advance, but never while the pointer is over the hero — this slide is
    // big enough to actually read, so rotating out from under the reader is worse
    // than on the small per-company cards.
    useEffect(() => {
        if (articles.length <= 1 || paused || intervalMs <= 0) return;
        const timer = setInterval(() => {
            setCurrentIndex((prev) => (prev + 1) % articles.length);
        }, intervalMs);
        return () => clearInterval(timer);
    }, [articles.length, paused, intervalMs, currentIndex]);

    const go = (delta: number) => (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setCurrentIndex((prev) => (prev + delta + articles.length) % articles.length);
    };

    if (loading) {
        return (
            <Card wrapperClassName="bg-black/40 rounded-lg border border-white/5 transition-colors p-4">
                <div className={cn(HERO_HEIGHT, "w-full rounded-lg bg-black/40 flex items-center justify-center")}>
                    <Loader2 className="w-8 h-8 animate-spin text-cyan-500" />
                </div>
            </Card>
        );
    }

    if (articles.length === 0) return null;

    // Modulo rather than a reset effect: the feeds refetch on an interval, so the
    // list can shrink under a held index between renders.
    const safeIndex = currentIndex % articles.length;
    const article = articles[safeIndex];
    if (!article) return null;

    const publisher = article.news_site && article.news_site !== article.feed ? article.news_site : null;

    return (
        <Card wrapperClassName="group bg-black/40 rounded-lg border border-white/5 hover:border-cyan-500/30 transition-colors p-4">
            <div
                className={cn(HERO_HEIGHT, "relative w-full rounded-lg overflow-hidden bg-black/60")}
                onMouseEnter={() => setPaused(true)}
                onMouseLeave={() => setPaused(false)}
            >
                {article.image_url ? (
                    <img
                        key={article.image_url}
                        src={article.image_url}
                        alt={article.title}
                        className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                    />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-cyan-950/40 to-black">
                        <Newspaper className="w-16 h-16 text-white/10" />
                    </div>
                )}

                {/* Legibility scrim — the headline sits on arbitrary upstream imagery. */}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/10" />

                <div className="absolute inset-x-0 bottom-0 p-4 md:p-8 z-10">
                    <div className="flex items-center gap-2 mb-2 text-xs">
                        <span className="font-bold uppercase tracking-widest text-cyan-400">{article.feed}</span>
                        {publisher && <span className="text-white/40 truncate">via {publisher}</span>}
                        {article.publishedMs !== null && (
                            <span className="text-white/50 ml-auto shrink-0">
                                {new Date(article.publishedMs).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                    <h3 className="text-white font-bold text-lg md:text-3xl leading-tight line-clamp-3 group-hover:text-cyan-400 transition-colors">
                        {article.title}
                    </h3>
                </div>

                {articles.length > 1 && (
                    <>
                        <button
                            onClick={go(-1)}
                            onPointerDown={(e) => e.stopPropagation()}
                            title="Previous story"
                            className="absolute left-2 top-1/2 -translate-y-1/2 z-20 p-2 rounded-full bg-black/50 backdrop-blur-sm text-white/60 hover:text-white hover:bg-black/70 transition-colors cursor-pointer"
                        >
                            <ChevronLeft className="w-4 h-4 md:w-8 md:h-8" />
                        </button>
                        <button
                            onClick={go(1)}
                            onPointerDown={(e) => e.stopPropagation()}
                            title="Next story"
                            className="absolute right-2 top-1/2 -translate-y-1/2 z-20 p-2 rounded-full bg-black/50 backdrop-blur-sm text-white/60 hover:text-white hover:bg-black/70 transition-colors cursor-pointer"
                        >
                            <ChevronRight className="w-4 h-4 md:w-8 md:h-8" />
                        </button>

                        <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
                            <div className="hidden sm:flex gap-1">
                                {articles.map((a, i) => (
                                    <button
                                        key={a.url}
                                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setCurrentIndex(i); }}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        title={a.title}
                                        className={cn(
                                            "h-1.5 rounded-full transition-all duration-300 cursor-pointer",
                                            i === safeIndex ? "w-8 bg-cyan-400" : "w-2 bg-white/30 hover:bg-white/60",
                                        )}
                                    />
                                ))}
                            </div>
                            <span className="text-xs text-white/50 tabular-nums bg-black/50 backdrop-blur-sm rounded-md px-2 py-0.5">
                                {safeIndex + 1}/{articles.length}
                            </span>
                        </div>
                    </>
                )}

                {/* Below the controls (z-20) so the chevrons/dots win the click. */}
                <a href={article.url} target="_blank" rel="noreferrer" className="absolute inset-0 z-10" title={article.title} />
            </div>
        </Card>
    );
};
