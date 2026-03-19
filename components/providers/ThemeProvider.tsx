"use client";

import { useEffect, useState } from "react";
import { useThemeStore } from "./themeStore";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [mounted, setMounted] = useState(false);
    const { isDarkMode, viewHues, viewHuesEnabled, activeViewId } = useThemeStore();

    // Pull from API on mount
    useEffect(() => {
        fetch('/api/settings')
            .then(res => res.json())
            .then(res => {
                if (res.data) {
                    useThemeStore.setState(res.data);
                }
                setMounted(true);
            })
            .catch(err => {
                console.error("Failed to load settings:", err);
                setMounted(true);
            });
    }, []);

    // Push to API on state change
    useEffect(() => {
        if (!mounted) return;

        const unsubscribe = useThemeStore.subscribe((state) => {
            const dataToSave = {
                isDarkMode: state.isDarkMode,
                viewHues: state.viewHues,
                viewHuesEnabled: state.viewHuesEnabled,
                activeViewId: state.activeViewId,
                dashOrder: state.dashOrder,
                dashTitles: state.dashTitles
            };

            fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dataToSave)
            }).catch(err => console.error("Failed to default save settings:", err));
        });

        return () => unsubscribe();
    }, [mounted]);

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
