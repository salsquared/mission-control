import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ThemeState {
    isDarkMode: boolean;
    viewHues: Record<string, number>;
    viewHuesEnabled: boolean;
    activeViewId: string;
    setViewHuesEnabled: (enabled: boolean) => void;
    setIsDarkMode: (isDark: boolean) => void;
    setViewHue: (viewId: string, hue: number) => void;
    setActiveViewId: (viewId: string) => void;
}

export const useThemeStore = create<ThemeState>()(
    persist(
        (set) => ({
            isDarkMode: true,
            viewHues: {
                "rocketry": 250,
                "crypto": 150,
                "ai-news": 200,
                "ai-partner": 320,
            },
            viewHuesEnabled: true,
            activeViewId: "rocketry",
            setViewHuesEnabled: (viewHuesEnabled) => set({ viewHuesEnabled }),
            setIsDarkMode: (isDarkMode) => set({ isDarkMode }),
            setViewHue: (viewId, hue) => set((state) => ({
                viewHues: { ...state.viewHues, [viewId]: hue }
            })),
            setActiveViewId: (activeViewId) => set({ activeViewId }),
        }),
        {
            name: 'theme-storage',
        }
    )
);
