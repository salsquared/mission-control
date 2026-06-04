"use client";

import React, { useCallback, useRef, useState } from "react";
import { motion, useMotionValue, animate, AnimatePresence } from "framer-motion";
import type { PanInfo } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/components/providers/themeStore";
import { useSettingsStore } from "@/components/providers/settingsStore";
import { useFinePointer } from "@/hooks/useMobileLayout";
import { LaunchpadOverlay } from "../overlays/LaunchpadOverlay";
import { NotificationBell } from "../overlays/NotificationBell";
import { SavedPapersOverlay } from "../overlays/SavedPapersOverlay";
import { AICompanion } from "../AICompanion";
import type { DashCarouselState } from "./useDashCarousel";
import { type DashConfig, getTopic } from "./dashes";

interface MobileShellProps {
    carousel: DashCarouselState;
    baseDashes: DashConfig[];
}

// Snap thresholds. The drag commits to a slide change when EITHER the
// total horizontal offset crosses SNAP_OFFSET_PX or the release velocity
// crosses SNAP_VELOCITY_PX_S. Velocity-driven snap lets a quick flick
// commit even when the finger barely moved.
const SNAP_OFFSET_PX = 50;
const SNAP_VELOCITY_PX_S = 500;

// Edge-swipe-down: a 24px-tall invisible strip at top:0. A downward pan
// past EDGE_PAN_DOWN_PX opens the Launchpad sheet — gestural redundancy
// for the title-tap, iOS-style.
const EDGE_PAN_DOWN_PX = 80;

/**
 * Mobile dashboard shell. Drops the desktop "card-on-a-canvas" frame
 * entirely: the active view fills the viewport edge-to-edge with just a
 * top hue bar (with title + notification bell) and a bottom page-dot row.
 * Navigation is via horizontal swipe (real drag-with-finger carousel) or
 * via taps on the bottom dots / title.
 *
 * Carousel implementation: renders only [current, next, prev] as three
 * absolutely-positioned slots offset by ±100 % within an outer motion
 * wrapper whose x is bound to a motionValue. On drag end, if the snap
 * threshold is crossed the wrapper springs to ±viewport-width, then on
 * animation-complete the carousel state advances and the wrapper resets
 * to x=0 (the new current slot is now at offset 0). Stable id-keys on
 * each slot let React preserve the two shared dashes across the index
 * shift — only one view mounts and one unmounts per swipe.
 */
export const MobileShell: React.FC<MobileShellProps> = ({ carousel, baseDashes }) => {
    const { orderedDashes, currentIndex, currentDashId, setCurrentIndex, nextSlide, prevSlide, goToSlide } = carousel;
    const len = orderedDashes.length;

    const [isLaunchpadOpen, setIsLaunchpadOpen] = useState(false);
    const [isLibraryOpen, setIsLibraryOpen] = useState(false);
    const [isAIChatOpen, setIsAIChatOpen] = useState(false);

    const { aiCompanionEnabled } = useSettingsStore();
    const { viewHues } = useThemeStore();
    const hasFinePointer = useFinePointer();

    const viewportRef = useRef<HTMLDivElement>(null);
    const x = useMotionValue(0);

    const handleDragEnd = useCallback((_e: unknown, info: PanInfo) => {
        const width = viewportRef.current?.offsetWidth ?? window.innerWidth;
        const wantNext = info.offset.x < -SNAP_OFFSET_PX || info.velocity.x < -SNAP_VELOCITY_PX_S;
        const wantPrev = info.offset.x > SNAP_OFFSET_PX || info.velocity.x > SNAP_VELOCITY_PX_S;
        if (wantNext) {
            animate(x, -width, {
                type: "spring", stiffness: 320, damping: 32,
                onComplete: () => {
                    nextSlide();
                    x.set(0);
                },
            });
        } else if (wantPrev) {
            animate(x, width, {
                type: "spring", stiffness: 320, damping: 32,
                onComplete: () => {
                    prevSlide();
                    x.set(0);
                },
            });
        } else {
            animate(x, 0, { type: "spring", stiffness: 320, damping: 32 });
        }
    }, [x, nextSlide, prevSlide]);

    // Build the visible slots. Wraparound matches the desktop chevron
    // behavior (`useDashCarousel.nextSlide` already wraps via modulo).
    // Defensive: skip duplicate ids when len < 3 so React doesn't warn.
    const slots: { dash: DashConfig; offset: number }[] = [];
    if (len > 0) slots.push({ dash: orderedDashes[currentIndex], offset: 0 });
    if (len > 1) slots.push({ dash: orderedDashes[(currentIndex + 1) % len], offset: 1 });
    if (len > 2) slots.push({ dash: orderedDashes[(currentIndex - 1 + len) % len], offset: -1 });

    const hue = (currentDashId && viewHues[currentDashId]) ?? 220;

    const handleGoToSlide = (id: string) => {
        goToSlide(id);
        setIsLaunchpadOpen(false);
    };

    const openLibraryFromSheet = () => {
        setIsLaunchpadOpen(false);
        setIsLibraryOpen(true);
    };

    const openAIFromSheet = aiCompanionEnabled
        ? () => {
            setIsLaunchpadOpen(false);
            setIsAIChatOpen(true);
        }
        : undefined;

    return (
        <div className="relative w-full h-screen overflow-hidden bg-background text-foreground">
            {/* Ambient glow — same as desktop for visual continuity when the
                view doesn't fill its background (e.g. card masonry leaves gaps). */}
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-0">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-white/5 blur-[150px] rounded-full" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-white/5 blur-[150px] rounded-full" />
            </div>

            {/* Top bar — tap title opens Launchpad sheet. Hue accent from the
                active dash. Padding-top respects the iOS status-bar inset. */}
            <div
                className="absolute top-0 left-0 right-0 z-30 flex items-center justify-center"
                style={{
                    paddingTop: "max(0.5rem, env(safe-area-inset-top))",
                    paddingBottom: "0.5rem",
                    background: `linear-gradient(to bottom, hsla(${hue}, 70%, 35%, 0.35), transparent)`,
                }}
            >
                <button
                    onClick={() => setIsLaunchpadOpen(true)}
                    className="text-sm font-bold uppercase tracking-[0.2em] text-foreground/60 hover:text-foreground/90 transition-colors px-4 py-1"
                    title="Open Launchpad"
                >
                    {orderedDashes[currentIndex]?.title ?? "—"}
                </button>
            </div>

            {/* Edge-swipe-down strip — invisible 24 px ribbon that opens the
                Launchpad sheet on a downward pan. Hidden when the sheet is
                already open so we don't capture its own drag handle. */}
            {!isLaunchpadOpen && (
                <motion.div
                    className="absolute top-0 left-0 right-0 h-6 z-40"
                    style={{ touchAction: "none" }}
                    onPanEnd={(_e, info) => {
                        if (info.offset.y > EDGE_PAN_DOWN_PX) setIsLaunchpadOpen(true);
                    }}
                />
            )}

            {/* Notification bell — already fixed top-right with safe-area
                from MD-0; sits above the top bar at z-40. */}
            <NotificationBell />

            {/* Carousel viewport. The `[&_*]:touch-pan-y` rule forces every
                descendant to allow horizontal pan to JS — without it the
                browser claims the gesture on inner cards (default
                touch-action: auto) and fires pointercancel before
                framer-motion's drag can commit. Vertical scroll still works
                because pan-y leaves it to the browser. */}
            <div
                ref={viewportRef}
                className="absolute inset-0 z-10"
                style={{
                    paddingTop: "calc(2.75rem + env(safe-area-inset-top))",
                    paddingBottom: "calc(2.5rem + env(safe-area-inset-bottom))",
                    // Tighten the Section horizontal gutter (0.5rem, == Tailwind
                    // px-2) for every view in the carousel. Section reads
                    // `--section-gutter` (default 2rem on desktop); overriding it
                    // here is what shrinks the gutter in tandem with the
                    // mobile-shell swap, rather than via a separate CSS breakpoint
                    // that could drift.
                    "--section-gutter": "0.5rem",
                } as React.CSSProperties}
            >
                <motion.div
                    className="relative w-full h-full [&_*]:touch-pan-y"
                    style={{ x, touchAction: "pan-y" }}
                    drag="x"
                    dragDirectionLock
                    onDragEnd={handleDragEnd}
                >
                    {slots.map(({ dash, offset }) => (
                        <div
                            key={dash.id}
                            className="absolute inset-0 overflow-hidden"
                            style={{ transform: `translateX(${offset * 100}%)` }}
                        >
                            {dash.component}
                        </div>
                    ))}
                </motion.div>
            </div>

            {/* Pagination chevrons — only shown when the device reports a
                fine pointer (mouse / trackpad). Swipe is the natural gesture
                with a finger but awkward with a mouse, so a small desktop
                window in mobile layout gets explicit prev / next buttons.
                Hidden on real touch devices to keep the mobile look clean. */}
            {hasFinePointer && len > 1 && !isLaunchpadOpen && (
                <>
                    <button
                        onClick={prevSlide}
                        aria-label="Previous dash"
                        className="absolute left-2 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-black/60 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                        onClick={nextSlide}
                        aria-label="Next dash"
                        className="absolute right-2 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-black/60 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <ChevronRight className="w-5 h-5" />
                    </button>
                </>
            )}

            {/* Page dots — one per dash, hue-tinted, active one enlarged.
                Tap to jump directly. */}
            <div
                className="absolute left-0 right-0 z-30 flex items-center justify-center gap-2"
                style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
            >
                {orderedDashes.map((dash, i) => {
                    const dotHue = viewHues[dash.id] ?? 220;
                    const active = i === currentIndex;
                    return (
                        <button
                            key={dash.id}
                            onClick={() => setCurrentIndex(i)}
                            aria-label={`Go to ${dash.title}`}
                            className={cn(
                                "rounded-full transition-all",
                                active ? "w-2.5 h-2.5" : "w-1.5 h-1.5 opacity-50 hover:opacity-80"
                            )}
                            style={{ background: `hsl(${dotHue}, 70%, 60%)` }}
                        />
                    );
                })}
            </div>

            {/* Launchpad sheet (MD-4 variant) */}
            <AnimatePresence>
                {isLaunchpadOpen && (
                    <LaunchpadOverlay
                        dashes={baseDashes}
                        goToSlide={handleGoToSlide}
                        variant="sheet"
                        onClose={() => setIsLaunchpadOpen(false)}
                        onOpenLibrary={openLibraryFromSheet}
                        onOpenAICompanion={openAIFromSheet}
                    />
                )}
            </AnimatePresence>

            {/* Library overlay — full-screen sheet on mobile since the
                desktop variant relies on an off-canvas side panel that
                wouldn't fit. */}
            <AnimatePresence>
                {isLibraryOpen && orderedDashes[currentIndex] && (
                    <div className="absolute inset-0 z-50">
                        <SavedPapersOverlay topic={getTopic(orderedDashes[currentIndex].id)} onClose={() => setIsLibraryOpen(false)} />
                    </div>
                )}
            </AnimatePresence>

            {/* AI Companion overlay (gated on aiCompanionEnabled) */}
            <AnimatePresence>
                {aiCompanionEnabled && isAIChatOpen && orderedDashes[currentIndex] && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 20 }}
                        className="absolute inset-x-3 z-50 shadow-2xl shadow-purple-900/20"
                        style={{
                            top: "calc(3rem + env(safe-area-inset-top))",
                            bottom: "calc(2.5rem + env(safe-area-inset-bottom))",
                        }}
                    >
                        <div className="relative w-full h-full">
                            <button
                                onClick={() => setIsAIChatOpen(false)}
                                className="absolute top-2 right-2 z-10 w-8 h-8 rounded-full bg-black/60 border border-white/10 text-white/70 hover:text-white flex items-center justify-center"
                                aria-label="Close AI Companion"
                            >
                                ×
                            </button>
                            <AICompanion activeContext={orderedDashes[currentIndex].id} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
