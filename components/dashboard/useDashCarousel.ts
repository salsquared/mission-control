"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useThemeStore } from "@/components/providers/themeStore";
import type { DashConfig } from "./dashes";

export interface DashCarouselState {
    orderedDashes: DashConfig[];
    currentIndex: number;
    currentDashId: string | undefined;
    isMounted: boolean;
    setCurrentIndex: (i: number) => void;
    nextSlide: () => void;
    prevSlide: () => void;
    /** Returns true if the id matched a known dash and navigation happened. */
    goToSlide: (id: string) => boolean;
}

/**
 * Shared carousel state across DesktopShell and MobileShell. Owns:
 *   - resolving user dash order against BASE_DASHES
 *   - mounting + restoring the last-viewed dash from persisted state /
 *     legacy localStorage key
 *   - syncing `activeViewId` back to the store on slide changes
 *   - the three navigation primitives (next, prev, jump-by-id)
 *
 * Lifted out of Dashboard.tsx so both shells render the same dash at the
 * same index without duplicating mount logic. The shells layer chrome and
 * gesture handling on top.
 */
export function useDashCarousel(baseDashes: DashConfig[]): DashCarouselState {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isMounted, setIsMounted] = useState(false);

    const { setActiveViewId, dashOrder, dashTitles } = useThemeStore();

    const orderedDashes = useMemo(() => {
        if (!isMounted) return [...baseDashes];
        return [...baseDashes]
            .map(dash => ({ ...dash, title: dashTitles[dash.id] || dash.title }))
            .sort((a, b) => {
                const indexA = dashOrder.indexOf(a.id);
                const indexB = dashOrder.indexOf(b.id);
                if (indexA === -1 && indexB === -1) return 0;
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
    }, [dashOrder, dashTitles, isMounted, baseDashes]);

    useEffect(() => {
        const store = useThemeStore.getState();
        store.syncAvailableDashes(baseDashes.map(d => ({ id: d.id, title: d.title })));

        // Source of truth for the last-viewed dash is `useAppStore.activeViewId`
        // (persisted by Zustand under `app-state` in localStorage). The legacy
        // `mc-active-view` localStorage key is read here as a one-time migration
        // for users coming from before MVP1 5B unified the store; if both
        // exist, the unified store wins.
        const post = useThemeStore.getState();
        const legacyId = typeof window !== 'undefined' ? localStorage.getItem('mc-active-view') : null;
        const storedId = post.activeViewId || legacyId || baseDashes[0].id;

        // Resolve the index against the **post-sync** user order, not against
        // `orderedDashes` (which is still memoized as baseDashes because
        // isMounted is false here). Using orderedDashes would resolve indices
        // against the default order, then flip on the next render and surface
        // a different dash — the "reload drops me a couple views back" bug.
        const dashesById = new Map(baseDashes.map(d => [d.id, d]));
        const userOrderedIds = [
            ...post.dashOrder.filter(id => dashesById.has(id)),
            ...baseDashes.filter(d => !post.dashOrder.includes(d.id)).map(d => d.id),
        ];

        const index = userOrderedIds.findIndex(id => id === storedId);
        if (index !== -1) {
            setCurrentIndex(index);
        }

        if (typeof window !== 'undefined' && legacyId && post.activeViewId) {
            localStorage.removeItem('mc-active-view');
        }

        setIsMounted(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const currentDashId = orderedDashes[currentIndex]?.id;

    useEffect(() => {
        if (isMounted && currentDashId) {
            setActiveViewId(currentDashId);
        }
    }, [currentDashId, setActiveViewId, isMounted]);

    const nextSlide = useCallback(() => {
        setCurrentIndex((prev) => (prev + 1) % orderedDashes.length);
    }, [orderedDashes.length]);

    const prevSlide = useCallback(() => {
        setCurrentIndex((prev) => (prev - 1 + orderedDashes.length) % orderedDashes.length);
    }, [orderedDashes.length]);

    const goToSlide = useCallback((id: string): boolean => {
        const index = orderedDashes.findIndex(d => d.id === id);
        if (index !== -1) {
            setCurrentIndex(index);
            return true;
        }
        return false;
    }, [orderedDashes]);

    return {
        orderedDashes,
        currentIndex,
        currentDashId,
        isMounted,
        setCurrentIndex,
        nextSlide,
        prevSlide,
        goToSlide,
    };
}
