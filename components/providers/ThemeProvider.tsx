"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "./state";
import { api } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return ((...args: any[]) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    }) as T;
}

async function refetchAndReconcile() {
    try {
        const fresh = await api.settings.get();
        if (fresh.data) {
            useAppStore.setState(fresh.data);
            toastStore.push({
                message: 'Settings updated elsewhere — reloaded',
                type: 'warning',
            });
        }
    } catch (e) {
        console.error('[settings] Failed to refetch on conflict:', e);
    }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [mounted, setMounted] = useState(false);
    const { isDarkMode, viewHues, viewHuesEnabled, activeViewId } = useAppStore();

    // Pull from API on mount
    useEffect(() => {
        api.settings.get()
            .then(res => {
                if (res.data) {
                    useAppStore.setState(res.data);
                }
                setMounted(true);
            })
            .catch(err => {
                console.error("Failed to load settings:", err);
                setMounted(true);
            });
    }, []);

    // Push to API on state change — debounced 500 ms so rapid edits (e.g. title
    // typing) fire one request after the user stops, not one per keystroke.
    // Reads the current `version` at fire time and includes it as If-Match.
    // On 409 conflict, refetches and toasts; the user's in-flight edit is
    // dropped in favor of the winning state.
    const debouncedSave = useRef(
        debounce(async (data: any) => {
            const expectedVersion = useAppStore.getState().version;
            try {
                const result = await api.settings.update(data, expectedVersion);
                if (result.ok) {
                    useAppStore.setState({ version: result.version });
                } else {
                    await refetchAndReconcile();
                }
            } catch (err) {
                console.error("Failed to save settings:", err);
            }
        }, 500)
    ).current;

    useEffect(() => {
        if (!mounted) return;

        const unsubscribe = useAppStore.subscribe((state, prevState) => {
            const getSyncableState = (s: any) => ({
                isDarkMode: s.isDarkMode,
                viewHues: s.viewHues,
                viewHuesEnabled: s.viewHuesEnabled,
                dashOrder: s.dashOrder,
                dashTitles: s.dashTitles,
            });

            const currentData = getSyncableState(state);
            const prevData = getSyncableState(prevState || state);

            if (prevState && JSON.stringify(currentData) !== JSON.stringify(prevData)) {
                debouncedSave(currentData);
            }
        });

        return () => { unsubscribe(); };
    }, [mounted, debouncedSave]);

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
        return <>{children}</>;
    }

    return <>{children}</>;
}
