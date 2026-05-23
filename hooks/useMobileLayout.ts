"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/components/providers/state";

const MOBILE_BREAKPOINT_QUERY = "(max-width: 768px)";

/**
 * Width-based mobile detection. Returns false on the server and on the first
 * client render to avoid hydration mismatch, then settles to the real
 * matchMedia result once mounted.
 *
 * Use `useEffectiveMobileLayout()` instead in components — that combines the
 * width check with the user's `mobileLayoutPreference` override.
 */
export function useMobileLayout(): boolean {
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined" || !window.matchMedia) return;
        const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
        setIsMobile(mql.matches);
        const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    return isMobile;
}

/**
 * Effective layout: combines the width-based check with the persisted
 * `mobileLayoutPreference` device pref. `force-on` / `force-off` override the
 * width detection; `auto` falls through to it. This is the hook UI code
 * should use.
 */
export function useEffectiveMobileLayout(): boolean {
    const widthIsMobile = useMobileLayout();
    const preference = useAppStore((s) => s.mobileLayoutPreference);
    if (preference === "force-on") return true;
    if (preference === "force-off") return false;
    return widthIsMobile;
}
