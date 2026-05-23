"use client";

import React from "react";
import { useEffectiveMobileLayout } from "@/hooks/useMobileLayout";
import { useDashCarousel } from "./dashboard/useDashCarousel";
import { DesktopShell } from "./dashboard/DesktopShell";
import { MobileShell } from "./dashboard/MobileShell";
import { BASE_DASHES, type DashConfig } from "./dashboard/dashes";

// Re-export for backward compat — LaunchpadOverlay imports DashConfig from
// here today. New code should import from `./dashboard/dashes` directly.
export type { DashConfig };

/**
 * Top-level dashboard. Picks a shell based on the effective mobile-layout
 * preference (viewport width, with a force-on / force-off override on the
 * DevicePrefs slice). Both shells consume the same `useDashCarousel` state
 * so swapping between them mid-session preserves the active dash + index.
 */
export const Dashboard: React.FC = () => {
    const isMobile = useEffectiveMobileLayout();
    const carousel = useDashCarousel(BASE_DASHES);

    return isMobile
        ? <MobileShell carousel={carousel} baseDashes={BASE_DASHES} />
        : <DesktopShell carousel={carousel} baseDashes={BASE_DASHES} />;
};
