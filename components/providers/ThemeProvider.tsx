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
                document.documentElement.classList.add("dark");
                document.documentElement.style.colorScheme = "dark";
            } else {
                document.documentElement.classList.add("light");
                document.documentElement.classList.remove("dark");
                document.documentElement.style.colorScheme = "light";
            }
            const hue = viewHuesEnabled ? (viewHues[activeViewId] ?? 250) : 250;
            document.documentElement.style.setProperty("--theme-hue", `${hue}deg`);
        }
    }, [mounted, isDarkMode, viewHues, viewHuesEnabled, activeViewId]);

    if (!mounted) {
        // Avoid hydration mismatch by rendering without theme changes first
        return <>{children}</>;
    }

    return <>{children}</>;
}
