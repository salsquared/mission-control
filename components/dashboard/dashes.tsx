"use client";

import React from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// Lazy-load every dash via next/dynamic so the dev worker only compiles
// the active view — not all 8 upfront. Each dash is its own webpack chunk;
// swiping to a new one triggers an on-demand compile (visible as a brief
// spinner the first time, then HMR-cached). This is the biggest single
// lever against the ~920 MB dev-floor footprint identified in the perf
// audit (docs/perf-profile.md): a Next dev worker holds every parsed
// module in memory, so the more we can defer parsing, the lower the
// floor.
const DashLoading = () => (
    <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-white/40" />
    </div>
);
const SpaceView = dynamic(() => import("../views/SpaceView").then(m => m.SpaceView), { ssr: false, loading: DashLoading });
const InternalView = dynamic(() => import("../views/InternalView").then(m => m.InternalView), { ssr: false, loading: DashLoading });
const FinanceView = dynamic(() => import("../views/FinanceView").then(m => m.FinanceView), { ssr: false, loading: DashLoading });
const AIView = dynamic(() => import("../views/AIView").then(m => m.AIView), { ssr: false, loading: DashLoading });
const PhysicsView = dynamic(() => import("../views/PhysicsView").then(m => m.PhysicsView), { ssr: false, loading: DashLoading });
const ApplicationsView = dynamic(() => import("../views/ApplicationsView").then(m => m.ApplicationsView), { ssr: false, loading: DashLoading });
const ProfileView = dynamic(() => import("../views/ProfileView").then(m => m.ProfileView), { ssr: false, loading: DashLoading });
const PlanningView = dynamic(() => import("../views/PlanningView").then(m => m.PlanningView), { ssr: false, loading: DashLoading });

export interface DashConfig {
    id: string;
    title: string;
    component: React.ReactNode;
}

export const getTopic = (id: string) => {
    if (id === 'rocketry') return 'Space';
    if (id === 'crypto') return 'Crypto';
    if (id === 'ai-news') return 'AI';
    if (id === 'physics') return 'Physics';
    if (id === 'planning') return 'Planning';
    return 'General';
};

export const BASE_DASHES: DashConfig[] = [
    { id: "rocketry", title: "Space", component: <SpaceView /> },
    { id: "crypto", title: "Market Analysis", component: <FinanceView /> },
    { id: "ai-news", title: "AI News", component: <AIView /> },
    { id: "internal-systems", title: "Internal Systems", component: <InternalView /> },
    { id: "physics", title: "Physics", component: <PhysicsView /> },
    { id: "applications", title: "Applications", component: <ApplicationsView /> },
    { id: "profile", title: "Profile", component: <ProfileView /> },
    { id: "planning", title: "Planning & Strategy", component: <PlanningView /> },
];

// Dash ids a crew member is shown. Everything else in BASE_DASHES is
// owner-only. `planning` is in the set (OQ5a) because it costs nothing:
// the tasks + goals routes behind it already run resolveScopedUserId,
// which prefers the guard's session id, so they are per-user for free.
const CREW_DASH_IDS = new Set(["applications", "profile", "planning"]);

// Computed once at module init rather than per call, so both branches of
// dashesForRole() return a referentially STABLE array. useDashCarousel
// lists `baseDashes` in a useMemo dep (useDashCarousel.ts:60), so a fresh
// array identity on every render would re-derive orderedDashes and churn
// every navigation callback hanging off it. Filtering preserves
// BASE_DASHES order, which the carousel's persisted-order resolution
// assumes. Treat the result as read-only — it is a shared module array.
const CREW_DASHES: DashConfig[] = BASE_DASHES.filter(d => CREW_DASH_IDS.has(d.id));

/**
 * The dashes a role is shown, in BASE_DASHES order.
 *
 * HIDING A DASH IS NOT ACCESS CONTROL. This is a UX affordance and nothing
 * more — it keeps a crew member off surfaces that would only 403 on them.
 * The actual enforcement is server-side at the route guard (requireOwner);
 * a client-side array cannot stop anyone from typing a URL or calling the
 * API directly. `internal-systems` in particular is an ops surface (live
 * logs, system stats) that MUST be blocked at the route — omitting it here
 * is the cosmetic half of that, never the whole of it.
 *
 * Pure over a static array — no hooks, no state, no I/O — so it is safe to
 * call during render.
 *
 * `role` is deliberately NOT optional, and there is deliberately no
 * unknown/loading return value. Neither candidate works: returning the crew
 * set optimistically strands an owner on the wrong dash (useDashCarousel
 * restores by id against whatever baseDashes its one-shot effect saw on the
 * FIRST render, so the owner's last-viewed id is dropped and never restored
 * when the set later widens — this is OQ9c, rejected), and returning []
 * throws outright (useDashCarousel.ts:73 reads baseDashes[0].id with no
 * empty-array guard). So the caller's obligation is structural: do not call
 * this — and do not run the carousel hook at all — until the role has
 * resolved (OQ9a). Do not paper over the unknown window with
 * `dashesForRole(role ?? "crew")`; that is OQ9c with extra steps.
 */
export const dashesForRole = (role: "owner" | "crew"): DashConfig[] =>
    role === "owner" ? BASE_DASHES : CREW_DASHES;
