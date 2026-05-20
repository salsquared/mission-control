/**
 * Unified application state store.
 *
 * Three slices with distinct persistence policies:
 *   theme       — synced to /api/settings (cross-device)
 *   devicePrefs — localStorage only (per-device)
 *   ui          — ephemeral in-memory, never persisted
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ---------- Theme slice (mirrors GlobalSetting columns) ----------
interface ThemeSlice {
    isDarkMode: boolean;
    viewHues: Record<string, number>;
    viewHuesEnabled: boolean;
    activeViewId: string;
    dashOrder: string[];
    dashTitles: Record<string, string>;
    defaultDashTitles: Record<string, string>;
    viewScreenshots: Record<string, string>;
    // Cross-device global negative filters (regex patterns). Hydrated from
    // /api/settings GET alongside the theme fields. Excluded from
    // ThemeProvider's auto-sync diff (it has its own explicit Save UX in
    // WatchlistsCard); writes update both this field and `version` directly.
    globalNegativeFilters: string[];
    // Optimistic-concurrency counter. Hydrated from /api/settings GET, sent
    // back as If-Match on POST, bumped on successful save. Deliberately
    // excluded from the synced-state diff so updating it doesn't trigger a
    // re-save.
    version: number;

    setViewHuesEnabled: (enabled: boolean) => void;
    setIsDarkMode: (isDark: boolean) => void;
    setViewHue: (viewId: string, hue: number) => void;
    setActiveViewId: (viewId: string) => void;
    setDashOrder: (order: string[]) => void;
    setDashTitle: (viewId: string, title: string) => void;
    setViewScreenshot: (viewId: string, dataUrl: string) => void;
    syncAvailableDashes: (dashes: { id: string; title: string }[]) => void;
}

// ---------- DevicePrefs slice (localStorage) ----------
// PB-15: new-postings feed filter selection. Kept per-device so two laptops
// can have different default views. `employmentTypes` is empty = no filter.
export type PostingEmploymentType = "full-time" | "part-time" | "internship" | "contract" | "temporary";

export interface PostingFilters {
    employmentTypes: PostingEmploymentType[];
    remoteOnly: boolean;
    /** Location chip allow-list — case-insensitive substring match against
     *  `JobPosting.location`. Empty = no location filter. Multiple chips are
     *  OR'd ("show postings in NYC OR Boston OR Remote"). Replaced the prior
     *  single-string `locationContains` so users can mix multiple cities /
     *  states / countries without having to pick one. */
    locations: string[];
    /** Include postings whose employmentType is null. Defaults to false so
     *  that activating a type chip ("Internship") strictly filters down —
     *  ATS feeds like Workday/Greenhouse leave most postings unclassified,
     *  and a `true` default lets them all leak through, making the filter
     *  look broken. The checkbox in the UI is the escape hatch. */
    includeUnspecified: boolean;
    /** Company names whitelist. Empty = show all companies. Compared against
     *  `JobPosting.company` (display name from the fetcher, e.g. "Anthropic"). */
    companies: string[];
}

const DEFAULT_POSTING_FILTERS: PostingFilters = {
    employmentTypes: [],
    remoteOnly: false,
    locations: [],
    includeUnspecified: false,
    companies: [],
};

interface DevicePrefsSlice {
    autoResearch: boolean;
    aiCompanionEnabled: boolean;
    postingFilters: PostingFilters;

    setAutoResearch: (v: boolean) => void;
    setAiCompanionEnabled: (v: boolean) => void;
    setPostingFilters: (next: PostingFilters) => void;
}

// ---------- Combined store ----------
export interface AppState extends ThemeSlice, DevicePrefsSlice {}

const DEFAULT_DASH_TITLES: Record<string, string> = {
    'rocketry': 'Space',
    'crypto': 'Market Analysis',
    'ai-news': 'AI News',
    'internal-systems': 'Internal Systems',
    'physics': 'Physics',
    'applications': 'Applications',
    'profile': 'Profile',
    'planning': 'Planning & Strategy',
};

export const useAppStore = create<AppState>()(
    persist(
        (set, get) => ({
            // ---------- ThemeSlice defaults ----------
            isDarkMode: true,
            viewHues: { rocketry: 250, crypto: 150, 'ai-news': 200, 'internal-systems': 320, profile: 280 },
            viewHuesEnabled: true,
            activeViewId: 'rocketry',
            dashOrder: ['rocketry', 'crypto', 'ai-news', 'physics', 'applications', 'profile', 'planning', 'internal-systems'],
            dashTitles: {},
            defaultDashTitles: DEFAULT_DASH_TITLES,
            viewScreenshots: {},
            globalNegativeFilters: [],
            version: 0,

            setViewHuesEnabled: (viewHuesEnabled) => set({ viewHuesEnabled }),
            setIsDarkMode: (isDarkMode) => set({ isDarkMode }),
            setViewHue: (viewId, hue) => set((s) => ({ viewHues: { ...s.viewHues, [viewId]: hue } })),
            setActiveViewId: (activeViewId) => set({ activeViewId }),
            setDashOrder: (dashOrder) => set({ dashOrder }),
            setDashTitle: (viewId, title) => set((s) => ({ dashTitles: { ...s.dashTitles, [viewId]: title } })),
            setViewScreenshot: (viewId, dataUrl) => set((s) => ({ viewScreenshots: { ...s.viewScreenshots, [viewId]: dataUrl } })),
            syncAvailableDashes: (dashes) => set((state) => {
                const validIds = dashes.map(d => d.id);
                let newOrder = state.dashOrder.filter(id => validIds.includes(id));
                const newTitles = { ...state.defaultDashTitles };
                Object.keys(newTitles).forEach(id => { if (!validIds.includes(id)) delete newTitles[id]; });
                dashes.forEach(dash => {
                    if (!newOrder.includes(dash.id)) newOrder.push(dash.id);
                    newTitles[dash.id] = dash.title;
                });
                const idx = newOrder.indexOf('internal-systems');
                if (idx !== -1 && idx !== newOrder.length - 1) {
                    newOrder.splice(idx, 1);
                    newOrder.push('internal-systems');
                }
                return { dashOrder: newOrder, defaultDashTitles: newTitles };
            }),

            // ---------- DevicePrefsSlice defaults ----------
            autoResearch: false,
            aiCompanionEnabled: false,
            postingFilters: DEFAULT_POSTING_FILTERS,
            setAutoResearch: (autoResearch) => set({ autoResearch }),
            setAiCompanionEnabled: (aiCompanionEnabled) => set({ aiCompanionEnabled }),
            setPostingFilters: (postingFilters) => set({ postingFilters }),
        }),
        {
            name: 'app-state',
            // Persist only device-local fields; theme fields are loaded from the API.
            partialize: (state) => ({
                autoResearch: state.autoResearch,
                aiCompanionEnabled: state.aiCompanionEnabled,
                activeViewId: state.activeViewId,
                viewScreenshots: state.viewScreenshots,
                postingFilters: state.postingFilters,
            }),
            version: 5,
            migrate: (persisted: any, fromVersion: number) => {
                // v2 → v3: flip includeUnspecified to false. Existing users
                // would otherwise inherit the old `true` default and the
                // type-chip filter would silently no-op for them.
                // v3 → v4: introduce `companies` filter (default []).
                // v4 → v5: `locationContains: string` → `locations: string[]`.
                //          Wrap any prior single substring into a 1-chip array
                //          so users don't lose their saved location filter.
                const pf = persisted.postingFilters;
                let locations: string[] = [];
                if (pf) {
                    if (Array.isArray(pf.locations)) {
                        locations = pf.locations
                            .filter((s: unknown): s is string => typeof s === 'string')
                            .map((s: string) => s.trim())
                            .filter((s: string) => s.length > 0);
                    } else if (typeof pf.locationContains === 'string' && pf.locationContains.trim()) {
                        locations = [pf.locationContains.trim()];
                    }
                }
                const postingFilters: PostingFilters = pf
                    ? {
                        employmentTypes: Array.isArray(pf.employmentTypes) ? pf.employmentTypes : [],
                        remoteOnly: !!pf.remoteOnly,
                        locations,
                        includeUnspecified: fromVersion < 3 ? false : (pf.includeUnspecified ?? false),
                        companies: Array.isArray(pf.companies) ? pf.companies : [],
                    }
                    : DEFAULT_POSTING_FILTERS;
                return {
                    autoResearch: persisted.autoResearch ?? false,
                    aiCompanionEnabled: persisted.aiCompanionEnabled ?? persisted.backgroundTasks ?? false,
                    activeViewId: persisted.activeViewId ?? 'rocketry',
                    viewScreenshots: persisted.viewScreenshots ?? {},
                    postingFilters,
                };
            },
        }
    )
);

// ---------- Backward-compat re-exports ----------
// These let existing consumers of useThemeStore / useSettingsStore continue
// to work with zero changes. Remove after all callsites are updated.
export const useThemeStore = useAppStore;
export const useSettingsStore = useAppStore;
