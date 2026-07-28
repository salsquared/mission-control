"use client";

import React from "react";
import { useEffectiveMobileLayout } from "@/hooks/useMobileLayout";
import { useDashCarousel } from "./useDashCarousel";
import { DesktopShell } from "./DesktopShell";
import { MobileShell } from "./MobileShell";
import { dashesForRole } from "./dashes";
import type { Role } from "@/hooks/useAccount";

interface RoleDashboardProps {
    /**
     * The viewer's RESOLVED role. Non-optional on purpose, mirroring
     * `dashesForRole()`: there is no "unknown" value to pass, because this
     * component must not be mounted until the role is known.
     */
    role: Role;
}

/**
 * The dashboard for a KNOWN role — the carousel-consuming half of the shell,
 * split out of `Dashboard.tsx` so that `useDashCarousel` does not run at all
 * while the role is still unresolved (OQ9a / P3.3).
 *
 * WHY THIS IS A SEPARATE COMPONENT rather than an early return in
 * `Dashboard.tsx`: `useDashCarousel` does its `syncAvailableDashes` +
 * restore-by-id inside a ONE-SHOT `useEffect(…, [])` (useDashCarousel.ts:62-90)
 * that closes over the FIRST render's `baseDashes`. Hooks cannot be called
 * conditionally, so a spinner-returning `if` placed after the hook call in
 * `Dashboard` would still let that effect fire against the wrong array and
 * merely paint over the damage — the rejected OQ9c behaviour, where an owner
 * whose last dash was `rocketry` has that id dropped by the sync, is never
 * restored when the set later widens, and lands on position 0.
 *
 * Mounting is the gate. React does not call a component's hooks until the
 * element is rendered, so with `Dashboard` returning a spinner (or a terminal
 * state) for every non-`ready` account state, this component's FIRST render —
 * and therefore the one-shot effect — happens with `role` already known and
 * `baseDashes` already final. `dashesForRole(role)` is also never `[]`, so the
 * unguarded `baseDashes[0].id` read at useDashCarousel.ts:73 is safe.
 *
 * `dashesForRole` returns one of two module-level arrays, so `baseDashes` is
 * referentially stable across re-renders and the carousel's `useMemo`/callback
 * deps do not churn. A role FLIP (which cannot happen in practice — role is
 * process-stable for a session) is handled by the `key={role}` at the mount
 * site in `Dashboard`, which remounts this subtree so the one-shot effect
 * re-runs against the new set rather than silently keeping the old one.
 */
export const RoleDashboard: React.FC<RoleDashboardProps> = ({ role }) => {
    const isMobile = useEffectiveMobileLayout();
    const baseDashes = dashesForRole(role);
    const carousel = useDashCarousel(baseDashes);

    return isMobile
        ? <MobileShell carousel={carousel} baseDashes={baseDashes} />
        : <DesktopShell carousel={carousel} baseDashes={baseDashes} />;
};
