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
 *
 * Position is tracked by DASH ID, not by index (OQ11a). `dashOrder` is a
 * cross-device field hydrated asynchronously from /api/settings — an index
 * resolved at mount against the pre-hydration order goes stale the moment
 * the custom order arrives (orderedDashes re-sorts under a fixed index, the
 * visible dash silently flips, and the activeViewId sync effect then
 * persists the WRONG id). Holding the id as the source of truth and deriving
 * the index against the current `orderedDashes` means a re-sort moves the
 * index with the dash instead of the dash under the index.
 */
export function useDashCarousel(baseDashes: DashConfig[]): DashCarouselState {
    // Source of truth: the current dash ID. null = not yet restored (renders
    // as position 0 of whatever order is current, same as before).
    const [currentId, setCurrentId] = useState<string | null>(null);
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

        // Restore by ID — no index resolution at mount, so the async
        // /api/settings dashOrder hydration can land whenever it likes; the
        // derived index below simply reinterprets the same id against the
        // new order. A stale id (dash removed from BASE_DASHES) is dropped
        // and the carousel stays at position 0 of the current order.
        if (baseDashes.some(d => d.id === storedId)) {
            setCurrentId(storedId);
        }

        if (typeof window !== 'undefined' && legacyId && post.activeViewId) {
            localStorage.removeItem('mc-active-view');
        }

        setIsMounted(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Derived: where the current dash sits in TODAY's order. Recomputed on
    // every dashOrder/dashTitles change, so a settings hydration that
    // re-sorts orderedDashes moves the index with the dash.
    const currentIndex = useMemo(() => {
        if (!currentId) return 0;
        const i = orderedDashes.findIndex(d => d.id === currentId);
        return i === -1 ? 0 : i;
    }, [orderedDashes, currentId]);

    const currentDashId = orderedDashes[currentIndex]?.id;

    useEffect(() => {
        if (isMounted && currentDashId) {
            setActiveViewId(currentDashId);
        }
    }, [currentDashId, setActiveViewId, isMounted]);

    // Navigation: neighbor math still happens in index space, but always
    // against the CURRENT order, and the result is stored back as an id.
    const stepSlide = useCallback((delta: number) => {
        setCurrentId(prev => {
            const len = orderedDashes.length;
            if (len === 0) return prev;
            const i = prev ? orderedDashes.findIndex(d => d.id === prev) : -1;
            const base = i === -1 ? 0 : i;
            return orderedDashes[(base + delta + len) % len].id;
        });
    }, [orderedDashes]);

    const nextSlide = useCallback(() => stepSlide(1), [stepSlide]);
    const prevSlide = useCallback(() => stepSlide(-1), [stepSlide]);

    // Index-based jump (mobile page dots). The index is interpreted against
    // the current order at call time, then immediately converted to an id.
    const setCurrentIndex = useCallback((i: number) => {
        const dash = orderedDashes[i];
        if (dash) setCurrentId(dash.id);
    }, [orderedDashes]);

    const goToSlide = useCallback((id: string): boolean => {
        if (orderedDashes.some(d => d.id === id)) {
            setCurrentId(id);
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
