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
    // Cross-device negative filters (regex patterns). Hydrated from
    // /api/settings GET alongside the theme fields. Excluded from
    // ThemeProvider's auto-sync diff (it has its own explicit Save UX in
    // WatchlistsCard); writes update both this field and `version` directly.
    // One shared list applied to every watchlist regardless of track — a
    // company blocked here is blocked everywhere.
    negativeFilters: string[];
    // Cross-device watchlist visibility: IDs of watchlists whose postings are
    // hidden from the New/Side postings feed. Synced via /api/settings (one
    // user, many devices → identical feed everywhere) alongside negativeFilters
    // and, like it, excluded from ThemeProvider's auto-sync diff because the
    // eye toggle in WatchlistsCard saves explicitly. Empty = show all.
    hiddenWatchlistIds: string[];
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
    /** Company-name exclude list. Postings whose `company` matches any chip
     *  (case-insensitive substring) are dropped server-side. Useful for the
     *  "I've already reviewed every Lockheed posting, don't show me more"
     *  pattern — strictly subtractive, AND'd against the positive `companies`
     *  whitelist if both are set. */
    excludedCompanies: string[];
}

const DEFAULT_POSTING_FILTERS: PostingFilters = {
    employmentTypes: [],
    remoteOnly: false,
    locations: [],
    includeUnspecified: false,
    companies: [],
    excludedCompanies: [],
};

// MB Phase 4: filter slice is keyed by track. Both NewPostingsCard instances
// (career + side) mount simultaneously on ApplicationsView, so a single
// `postingFilters` object would mean toggling a chip on one card mirrors it
// onto the other. Per-track slices keep them independent and persist
// separately.
export type PostingsTrackKey = "career" | "side";

const DEFAULT_POSTING_FILTERS_BY_TRACK: Record<PostingsTrackKey, PostingFilters> = {
    career: DEFAULT_POSTING_FILTERS,
    side: DEFAULT_POSTING_FILTERS,
};

// Track D / MD-1: mobile-mode activation override. `auto` defers to the
// matchMedia('(max-width: 768px)') check; the force values pin the shell
// regardless of viewport (useful for testing mobile mode on a desktop browser,
// or for users who want to opt out on a tablet).
export type MobileLayoutPreference = "auto" | "force-on" | "force-off";

interface DevicePrefsSlice {
    autoResearch: boolean;
    aiCompanionEnabled: boolean;
    postingFilters: Record<PostingsTrackKey, PostingFilters>;
    mobileLayoutPreference: MobileLayoutPreference;

    setAutoResearch: (v: boolean) => void;
    setAiCompanionEnabled: (v: boolean) => void;
    setPostingFilters: (track: PostingsTrackKey, next: PostingFilters) => void;
    setMobileLayoutPreference: (v: MobileLayoutPreference) => void;
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
            negativeFilters: [],
            hiddenWatchlistIds: [],
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
            postingFilters: DEFAULT_POSTING_FILTERS_BY_TRACK,
            mobileLayoutPreference: "auto",
            setAutoResearch: (autoResearch) => set({ autoResearch }),
            setAiCompanionEnabled: (aiCompanionEnabled) => set({ aiCompanionEnabled }),
            setPostingFilters: (track, next) =>
                set((s) => ({ postingFilters: { ...s.postingFilters, [track]: next } })),
            setMobileLayoutPreference: (mobileLayoutPreference) => set({ mobileLayoutPreference }),
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
                mobileLayoutPreference: state.mobileLayoutPreference,
            }),
            version: 8,
            migrate: (persisted: any, fromVersion: number) => {
                // v2 → v3: flip includeUnspecified to false. Existing users
                // would otherwise inherit the old `true` default and the
                // type-chip filter would silently no-op for them.
                // v3 → v4: introduce `companies` filter (default []).
                // v4 → v5: `locationContains: string` → `locations: string[]`.
                //          Wrap any prior single substring into a 1-chip array
                //          so users don't lose their saved location filter.
                // v5 → v6: introduce `excludedCompanies` filter (default []).
                // v6 → v7 (MB Phase 4): `postingFilters` becomes per-track
                //          (Record<"career"|"side", PostingFilters>). Splay the
                //          existing single filter set across BOTH tracks so a
                //          mid-session migration doesn't reset filters the user
                //          had configured for career; side starts as the same
                //          shape (sensible: their current company/location
                //          filters were career-flavored, so career inherits).
                // v7 → v8 (MD-1 / Track D): introduce `mobileLayoutPreference`
                //          (default 'auto'). Existing users get auto-detection
                //          on first reload after the mobile shell ships.
                const pf = persisted.postingFilters;
                // Normalize whatever's at persisted.postingFilters into the
                // current PostingFilters shape. Handles either an old single-
                // object (v6 and below) or a new record (v7+).
                const normalizeOne = (raw: any): PostingFilters => {
                    if (!raw) return DEFAULT_POSTING_FILTERS;
                    let locations: string[] = [];
                    if (Array.isArray(raw.locations)) {
                        locations = raw.locations
                            .filter((s: unknown): s is string => typeof s === 'string')
                            .map((s: string) => s.trim())
                            .filter((s: string) => s.length > 0);
                    } else if (typeof raw.locationContains === 'string' && raw.locationContains.trim()) {
                        locations = [raw.locationContains.trim()];
                    }
                    return {
                        employmentTypes: Array.isArray(raw.employmentTypes) ? raw.employmentTypes : [],
                        remoteOnly: !!raw.remoteOnly,
                        locations,
                        includeUnspecified: fromVersion < 3 ? false : (raw.includeUnspecified ?? false),
                        companies: Array.isArray(raw.companies) ? raw.companies : [],
                        excludedCompanies: Array.isArray(raw.excludedCompanies)
                            ? raw.excludedCompanies
                                .filter((s: unknown): s is string => typeof s === 'string')
                                .map((s: string) => s.trim())
                                .filter((s: string) => s.length > 0)
                            : [],
                    };
                };
                let postingFilters: Record<PostingsTrackKey, PostingFilters>;
                if (pf && typeof pf === 'object' && 'career' in pf) {
                    // Already v7+ shape (defensive — covers re-migration).
                    postingFilters = {
                        career: normalizeOne(pf.career),
                        side: normalizeOne(pf.side),
                    };
                } else {
                    // v6 and earlier: single filter object. Splay across both.
                    const one = normalizeOne(pf);
                    postingFilters = { career: one, side: one };
                }
                const mobileLayoutPreference: MobileLayoutPreference =
                    persisted.mobileLayoutPreference === "force-on" ||
                    persisted.mobileLayoutPreference === "force-off"
                        ? persisted.mobileLayoutPreference
                        : "auto";
                return {
                    autoResearch: persisted.autoResearch ?? false,
                    aiCompanionEnabled: persisted.aiCompanionEnabled ?? persisted.backgroundTasks ?? false,
                    activeViewId: persisted.activeViewId ?? 'rocketry',
                    viewScreenshots: persisted.viewScreenshots ?? {},
                    postingFilters,
                    mobileLayoutPreference,
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
