"use client";

import { useEffect, useState } from "react";
import { useThemeStore } from "./themeStore";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [mounted, setMounted] = useState(false);
    const { isDarkMode, viewHues, viewHuesEnabled, activeViewId } = useThemeStore();

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        if (mounted) {
            if (isDarkMode) {
                document.documentElement.classList.remove("light");
            } else {
                document.documentElement.classList.add("light");
            }
            const hue = viewHuesEnabled ? (viewHues[activeViewId] ?? 250) : 250;
            document.documentElement.style.setProperty("--theme-hue", hue.toString());
        }
    }, [mounted, isDarkMode, viewHues, viewHuesEnabled, activeViewId]);

    if (!mounted) {
        // Avoid hydration mismatch by rendering without theme changes first
        return <>{children}</>;
    }

    return <>{children}</>;
}
