import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ThemeState {
    isDarkMode: boolean;
    viewHues: Record<string, number>;
    viewHuesEnabled: boolean;
    activeViewId: string;
    dashOrder: string[];
    dashTitles: Record<string, string>;
    defaultDashTitles: Record<string, string>;
    viewScreenshots: Record<string, string>;
    setViewHuesEnabled: (enabled: boolean) => void;
    setIsDarkMode: (isDark: boolean) => void;
    setViewHue: (viewId: string, hue: number) => void;
    setActiveViewId: (viewId: string) => void;
    setDashOrder: (order: string[]) => void;
    setDashTitle: (viewId: string, title: string) => void;
    setViewScreenshot: (viewId: string, dataUrl: string) => void;
}

export const useThemeStore = create<ThemeState>()(
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
        dashOrder: ["rocketry", "crypto", "ai-news", "ai-partner", "physics"],
        dashTitles: {},
        defaultDashTitles: {
            "rocketry": "Space",
            "crypto": "Market Analysis",
            "ai-news": "AI News",
            "ai-partner": "Internal Systems",
            "physics": "Physics",
        },
        viewScreenshots: {},
        setViewHuesEnabled: (viewHuesEnabled) => set({ viewHuesEnabled }),
        setIsDarkMode: (isDarkMode) => set({ isDarkMode }),
        setViewHue: (viewId, hue) => set((state) => ({
            viewHues: { ...state.viewHues, [viewId]: hue }
        })),
        setActiveViewId: (activeViewId) => set({ activeViewId }),
        setDashOrder: (dashOrder) => set({ dashOrder }),
        setDashTitle: (viewId, title) => set((state) => ({
            dashTitles: { ...state.dashTitles, [viewId]: title }
        })),
        setViewScreenshot: (viewId, dataUrl) => set((state) => ({
            viewScreenshots: { ...state.viewScreenshots, [viewId]: dataUrl }
        })),
    })
);
