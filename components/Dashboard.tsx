"use client";

import React from "react";
import { Loader2 } from "lucide-react";
import { useAccount } from "@/hooks/useAccount";
import { RoleDashboard } from "./dashboard/RoleDashboard";
import { AccountGateScreen } from "./dashboard/AccountGateScreen";
import { type DashConfig } from "./dashboard/dashes";

// Re-export for backward compat — LaunchpadOverlay imports DashConfig from
// here today. New code should import from `./dashboard/dashes` directly.
export type { DashConfig };

/** Full-viewport spinner for the role-resolution window. Matches the per-dash
 *  `DashLoading` in `dashes.tsx` so a cold load reads as one continuous wait. */
const ShellLoading: React.FC = () => (
    <div className="w-full min-h-screen flex items-center justify-center bg-background text-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-white/40" />
    </div>
);

/**
 * Top-level dashboard — now purely the ACCOUNT GATE (OQ9a / P3.3, P3.8). It
 * owns no carousel state of its own; it decides which of four things is on
 * screen and lets `RoleDashboard` own everything downstream of a known role.
 *
 *   'loading'                                  → spinner
 *   'unauthenticated' | 'unprovisioned' | 'error' → AccountGateScreen (P3.8)
 *   'ready'                                    → RoleDashboard (shell + carousel)
 *
 * THE GATE IS A MOUNT BOUNDARY, NOT AN EARLY RETURN NEXT TO THE HOOK. This
 * file used to call `useDashCarousel(BASE_DASHES)` unconditionally at the top;
 * that hook's one-shot `useEffect(…, [])` closes over the FIRST render's
 * `baseDashes`, and hooks cannot be called conditionally — so keeping the call
 * here and adding a spinner-returning `if` below it would let the sync +
 * restore-by-id run against the unfiltered set and then hide the damage. That
 * is OQ9c, rejected as "actively broken for the owner". Moving the call into a
 * child that is only MOUNTED once `role` is known means the hook never runs
 * during the unknown window at all.
 *
 * Consequences worth preserving if this file is edited again:
 *   - Never pass a placeholder array (`[]`, or the crew set "optimistically")
 *     down while the role is unknown. `[]` throws at useDashCarousel.ts:73 and
 *     the crew set is the OQ9c regression.
 *   - Never write `dashesForRole(role ?? 'crew')`. `role` is non-optional for
 *     exactly this reason; let `tsc` keep the gate honest.
 *   - `key={role}` forces a remount if the role ever flips mid-session, so the
 *     one-shot effect re-runs against the new dash set instead of keeping the
 *     old one. In practice role is process-stable and this never fires.
 */
export const Dashboard: React.FC = () => {
    const { state, role, error, refetch } = useAccount();

    // Terminal states first, so a rejection can never be mistaken for a wait.
    if (state === "unauthenticated" || state === "unprovisioned" || state === "error") {
        return (
            <AccountGateScreen
                state={state}
                error={error}
                onRetry={() => { void refetch(); }}
            />
        );
    }

    // `state === 'loading'`, plus the structurally-impossible 'ready'-without-a-
    // role. Narrowing on `role` rather than on `state` is what lets the JSX below
    // pass a non-optional `Role` with no assertion.
    if (!role) return <ShellLoading />;

    return <RoleDashboard key={role} role={role} />;
};
