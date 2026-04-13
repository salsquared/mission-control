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
    syncAvailableDashes: (dashes: { id: string, title: string }[]) => void;
}

export const useThemeStore = create<ThemeState>()(
    (set) => ({
        isDarkMode: true,
        viewHues: {
            "rocketry": 250,
            "crypto": 150,
            "ai-news": 200,
            "internal-systems": 320,
        },
        viewHuesEnabled: true,
        activeViewId: "rocketry",
        dashOrder: ["rocketry", "crypto", "ai-news", "physics", "applications", "planning", "internal-systems"],
        dashTitles: {},
        defaultDashTitles: {
            "rocketry": "Space",
            "crypto": "Market Analysis",
            "ai-news": "AI News",
            "internal-systems": "Internal Systems",
            "physics": "Physics",
            "applications": "Applications",
            "planning": "Planning & Strategy",
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
        syncAvailableDashes: (dashes) => set((state) => {
            let orderChanged = false;
            const newOrder = [...state.dashOrder];
            const newTitles = { ...state.defaultDashTitles };
            
            dashes.forEach(dash => {
                if (!newOrder.includes(dash.id)) {
                    newOrder.push(dash.id);
                    orderChanged = true;
                }
                if (newTitles[dash.id] !== dash.title) {
                    newTitles[dash.id] = dash.title;
                    orderChanged = true;
                }
            });

            const aiPartnerIndex = newOrder.indexOf("internal-systems");
            if (aiPartnerIndex !== -1 && aiPartnerIndex !== newOrder.length - 1) {
                newOrder.splice(aiPartnerIndex, 1);
                newOrder.push("internal-systems");
                orderChanged = true;
            }

            if (orderChanged) {
                return { dashOrder: newOrder, defaultDashTitles: newTitles };
            }
            return state;
        }),
    })
);
