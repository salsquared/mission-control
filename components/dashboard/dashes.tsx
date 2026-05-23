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
