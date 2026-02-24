"use client";

import React, { useState } from "react";
import { SpaceView } from "./views/SpaceView";
import { InternalView } from "./views/InternalView";
import { FinanceView } from "./views/FinanceView";
import { AIView } from "./views/AIView";
import { AICompanion } from "./AICompanion";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, LayoutGrid, MessageSquare } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useThemeStore } from "@/store/themeStore";
import { useEffect } from "react";

interface DashConfig {
    id: string;
    title: string;
    component: React.ReactNode;
}

export const Dashboard: React.FC = () => {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isLaunchpadOpen, setIsLaunchpadOpen] = useState(false);
    const [isAIChatOpen, setIsAIChatOpen] = useState(false);

    const dashes: DashConfig[] = [
        {
            id: "rocketry",
            title: "Launches & Telemetry",
            component: <SpaceView />,
        },
        {
            id: "crypto",
            title: "Market Analysis",
            component: <FinanceView />,
        },
        {
            id: "ai-news",
            title: "AI News",
            component: <AIView />,
        },
        {
            id: "ai-partner",
            title: "Internal Systems",
            component: <InternalView />,
        },
    ];

    const { setActiveViewId } = useThemeStore();

    useEffect(() => {
        setActiveViewId(dashes[currentIndex].id);
    }, [currentIndex, setActiveViewId]);

    const nextSlide = () => {
        setCurrentIndex((prev) => (prev + 1) % dashes.length);
    };

    const prevSlide = () => {
        setCurrentIndex((prev) => (prev - 1 + dashes.length) % dashes.length);
    };

    const goToSlide = (index: number) => {
        setCurrentIndex(index);
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
                                    {dashes[currentIndex].title}
                                </span>
                            </div>
                            {dashes[currentIndex].component}
                        </div>
                    </motion.div>
                ) : (
                    <motion.div
                        key="launchpad"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="relative z-10 w-full h-full p-20 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 overflow-y-auto"
                    >
                        {dashes.map((dash, index) => (
                            <button
                                key={dash.id}
                                onClick={() => goToSlide(index)}
                                className="group relative flex flex-col items-center justify-center p-8 rounded-3xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/30 transition-all duration-300 hover:scale-[1.02]"
                            >
                                <div className="text-xl font-bold text-white mb-4 tracking-wider group-hover:text-white/80">
                                    {dash.title}
                                </div>
                                <div className="w-full h-48 rounded-xl bg-black/50 border border-white/5 group-hover:border-white/20 overflow-hidden relative flex items-center justify-center">
                                    <div className="text-white/20 text-4xl font-black uppercase tracking-tighter">
                                        PREVIEW
                                    </div>
                                </div>
                            </button>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>

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

            {/* Bottom Controls Bar */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 px-6 py-3 rounded-2xl bg-black/60 border border-white/10 backdrop-blur-xl">
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
            </div>

            {/* AI Companion Overlay */}
            <AnimatePresence>
                {isAIChatOpen && (
                    <motion.div
                        initial={{ opacity: 0, x: 20, scale: 0.95 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, x: 20, scale: 0.95 }}
                        className="absolute bottom-24 right-6 w-[400px] h-[600px] z-50 shadow-2xl shadow-purple-900/20"
                    >
                        <AICompanion activeContext={dashes[currentIndex].id} />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
