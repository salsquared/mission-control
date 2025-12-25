"use client";

import React, { useState } from "react";
import { SpaceDashboard } from "./contexts/SpaceDashboard";
import { AIDashboard } from "./contexts/AIDashboard";
import { FinanceDashboard } from "./contexts/FinanceDashboard";
import { AICompanion } from "./AICompanion";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, LayoutGrid, MessageSquare } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

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
            component: <SpaceDashboard />,
        },
        {
            id: "crypto",
            title: "Market Analysis",
            component: <FinanceDashboard />,
        },
        {
            id: "ai-partner",
            title: "Internal Systems",
            component: <AIDashboard />,
        },
    ];

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
        <div className="relative w-full h-screen overflow-hidden bg-dot-white/[0.05] bg-black text-white">
            {/* Background Ambient Glow */}
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-0">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-cyan-500/10 blur-[150px] rounded-full" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 blur-[150px] rounded-full" />
                <div className="absolute top-[40%] left-[40%] w-[20%] h-[20%] bg-blue-500/5 blur-[100px] rounded-full" />
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
                        {/* Current Dash Title */}
                        <div className="absolute top-8 left-1/2 -translate-x-1/2 px-8 py-3 glass rounded-full border border-white/10 z-20 select-none backdrop-blur-md">
                            <span className="text-xs font-bold uppercase tracking-[0.3em] text-cyan-200 drop-shadow-glow">
                                {dashes[currentIndex].title}
                            </span>
                        </div>

                        {/* Full Screen Module */}
                        <div className="w-full h-full max-w-7xl mx-auto bg-black/40 border border-white/10 backdrop-blur-xl rounded-3xl overflow-hidden shadow-2xl relative">
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
                                className="group relative flex flex-col items-center justify-center p-8 rounded-3xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-cyan-500/50 transition-all duration-300 hover:scale-[1.02]"
                            >
                                <div className="text-xl font-bold text-white mb-4 tracking-wider group-hover:text-cyan-400">
                                    {dash.title}
                                </div>
                                <div className="w-full h-48 rounded-xl bg-black/50 border border-white/5 group-hover:border-cyan-500/30 overflow-hidden relative flex items-center justify-center">
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
                        className="absolute left-4 top-1/2 -translate-y-1/2 z-30 p-4 rounded-full bg-white/5 border border-white/10 text-white/50 hover:text-cyan-400 hover:bg-white/10 hover:border-cyan-500/50 transition-all backdrop-blur-md"
                    >
                        <ChevronLeft className="w-8 h-8" />
                    </button>
                    <button
                        onClick={nextSlide}
                        className="absolute right-4 top-1/2 -translate-y-1/2 z-30 p-4 rounded-full bg-white/5 border border-white/10 text-white/50 hover:text-cyan-400 hover:bg-white/10 hover:border-cyan-500/50 transition-all backdrop-blur-md"
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
                            ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50"
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
                            ? "bg-purple-500/20 text-purple-400 border border-purple-500/50"
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
