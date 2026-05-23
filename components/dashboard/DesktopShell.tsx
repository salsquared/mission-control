"use client";

import React, { useState } from "react";
import { AICompanion } from "../AICompanion";
import { SavedPapersOverlay } from "../overlays/SavedPapersOverlay";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, LayoutGrid, MessageSquare, Library } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useSettingsStore } from "@/components/providers/settingsStore";
import { LaunchpadOverlay } from "../overlays/LaunchpadOverlay";
import { NotificationBell } from "../overlays/NotificationBell";
import type { DashCarouselState } from "./useDashCarousel";
import { type DashConfig, getTopic } from "./dashes";

interface DesktopShellProps {
    carousel: DashCarouselState;
    baseDashes: DashConfig[];
}

export const DesktopShell: React.FC<DesktopShellProps> = ({ carousel, baseDashes }) => {
    const { orderedDashes, currentIndex, nextSlide, prevSlide, goToSlide } = carousel;
    const [isLaunchpadOpen, setIsLaunchpadOpen] = useState(false);
    const [isAIChatOpen, setIsAIChatOpen] = useState(false);
    const [isLibraryOpen, setIsLibraryOpen] = useState(false);

    const { aiCompanionEnabled } = useSettingsStore();

    const handleGoToSlide = (id: string) => {
        goToSlide(id);
        setIsLaunchpadOpen(false);
    };

    return (
        <div className="relative w-full h-screen overflow-hidden bg-background text-foreground transition-colors duration-500">
            {/* Background Ambient Glow */}
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-0">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-white/5 blur-[150px] rounded-full" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-white/5 blur-[150px] rounded-full" />
                <div className="absolute top-[40%] left-[40%] w-[20%] h-[20%] bg-white/5 blur-[100px] rounded-full" />
            </div>

            {/* Content Area */}
            <AnimatePresence mode="wait">
                {!isLaunchpadOpen ? (
                    <motion.div
                        key="active-slide"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 1.05 }}
                        transition={{ duration: 0.3 }}
                        className="relative z-10 w-full h-full p-12 flex flex-col items-center justify-center"
                    >
                        {/* Full Screen Module */}
                        <div className="w-full h-full flex flex-col pt-16 pb-4 max-w-7xl mx-auto bg-card/80 border border-white/10 rounded-3xl overflow-hidden shadow-2xl relative transition-colors duration-500">
                            {/* Current Dash Title Inner */}
                            <div className="absolute top-6 left-1/2 -translate-x-1/2 select-none z-20">
                                <span className="text-sm font-bold uppercase tracking-[0.2em] text-foreground/50">
                                    {orderedDashes[currentIndex]?.title}
                                </span>
                            </div>
                            {orderedDashes[currentIndex]?.component}
                        </div>
                    </motion.div>
                ) : (
                    <LaunchpadOverlay dashes={baseDashes} goToSlide={handleGoToSlide} />
                )}
            </AnimatePresence>

            {/* Global notification bell — fixed top-right, visible from every dash.
                Hidden when the Launchpad is open since the Launchpad takes over
                the chrome and the bell would clash with its dash grid. */}
            {!isLaunchpadOpen && <NotificationBell />}

            {/* Navigation Controls (Only visible when not in Launchpad) */}
            {!isLaunchpadOpen && (
                <>
                    <button
                        onClick={prevSlide}
                        className="absolute left-4 top-1/2 -translate-y-1/2 z-30 p-4 rounded-full bg-black border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <ChevronLeft className="w-8 h-8" />
                    </button>
                    <button
                        onClick={nextSlide}
                        className="absolute right-4 top-1/2 -translate-y-1/2 z-30 p-4 rounded-full bg-black border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <ChevronRight className="w-8 h-8" />
                    </button>
                </>
            )}

            {/* Bottom Controls Bar. bottom uses max(1.5rem, safe-area-inset)
                so notched iOS doesn't slide the home indicator under the bar
                (MD-0). On non-notched devices the inset is 0 and bottom-6 wins. */}
            <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 px-6 py-3 rounded-2xl bg-black/60 border border-white/10 backdrop-blur-xl">
                <button
                    onClick={() => setIsLaunchpadOpen(!isLaunchpadOpen)}
                    className={cn(
                        "p-3 rounded-xl transition-all",
                        isLaunchpadOpen
                            ? "bg-white/20 text-white border border-white/30"
                            : "hover:bg-white/10 text-white/70 hover:text-white"
                    )}
                    title="Mission Control Launchpad"
                >
                    <LayoutGrid className="w-6 h-6" />
                </button>

                <div className="w-px h-8 bg-white/10" />

                <button
                    onClick={() => setIsLibraryOpen(!isLibraryOpen)}
                    className={cn(
                        "p-3 rounded-xl transition-all",
                        isLibraryOpen
                            ? "bg-white/20 text-white border border-white/30"
                            : "hover:bg-white/10 text-white/70 hover:text-white"
                    )}
                    title="My Library"
                >
                    <Library className="w-6 h-6" />
                </button>

                {aiCompanionEnabled && (
                    <>
                        <div className="w-px h-8 bg-white/10" />
                        <button
                            onClick={() => setIsAIChatOpen(!isAIChatOpen)}
                            className={cn(
                                "p-3 rounded-xl transition-all",
                                isAIChatOpen
                                    ? "bg-white/20 text-white border border-white/30"
                                    : "hover:bg-white/10 text-white/70 hover:text-white"
                            )}
                            title="Toggle AI Assistant"
                        >
                            <MessageSquare className="w-6 h-6" />
                        </button>
                    </>
                )}
            </div>

            {/* Saved Papers Overlay */}
            <AnimatePresence>
                {isLibraryOpen && orderedDashes[currentIndex] && (
                    <div className="absolute inset-y-0 right-0 z-50">
                        <SavedPapersOverlay topic={getTopic(orderedDashes[currentIndex].id)} onClose={() => setIsLibraryOpen(false)} />
                    </div>
                )}
            </AnimatePresence>

            {/* AI Companion Overlay (gated on aiCompanionEnabled feature flag) */}
            <AnimatePresence>
                {aiCompanionEnabled && isAIChatOpen && orderedDashes[currentIndex] && (
                    <motion.div
                        initial={{ opacity: 0, x: 20, scale: 0.95 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, x: 20, scale: 0.95 }}
                        className="absolute bottom-24 right-6 w-[400px] h-[600px] z-50 shadow-2xl shadow-purple-900/20"
                    >
                        <AICompanion activeContext={orderedDashes[currentIndex].id} />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
