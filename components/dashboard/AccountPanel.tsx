"use client";

import React from "react";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccount } from "@/hooks/useAccount";
import { useSignOut } from "@/hooks/useSignOut";

interface AccountPanelProps {
    /** Outer spacing, supplied by the caller so each Launchpad variant can
     *  place the block itself (sheet stacks it under the other rows; the
     *  desktop variant pushes it to the bottom with `mt-auto`). */
    className?: string;
}

/**
 * Who you are + the way out. Lives in the Launchpad because that is the one
 * chrome surface BOTH shells share — the desktop bottom controls bar has no
 * mobile equivalent, so anything homed there would exist for half the users.
 *
 * The sign-out itself lives in `useSignOut()`, shared with the Internal Systems
 * account card so the two controls cannot drift into meaning different things.
 *
 * Reads `useAccount()` itself rather than taking `user`/`role` as props. That
 * does not contradict the "LaunchpadOverlay stays presentational" contract in
 * that file: the contract exists so ROLE-GATING decisions have one owner (the
 * shell withholds the Library handler, and the overlay never re-derives why).
 * Nothing here is gated — every viewer gets an identity line and a sign-out —
 * so there is no decision to hoist, and threading two more props through two
 * shells to display the value they already fetch would be the worse trade.
 */
export const AccountPanel: React.FC<AccountPanelProps> = ({ className }) => {
    const { user, role } = useAccount();
    const { signOut, signingOut } = useSignOut();

    // `role === undefined` means NOT KNOWN YET (or the fetch failed) — never
    // "crew". Render nothing rather than a panel that would claim the wrong
    // identity for a frame and then correct itself.
    if (!user || !role) return null;

    return (
        <div className={cn("w-full", className)}>
            <div className="text-[11px] uppercase tracking-widest font-bold text-white/40 px-1 mb-2">
                Account
            </div>
            <div className="flex items-center justify-between gap-4 flex-wrap px-4 py-3 rounded-xl bg-white/5 border border-white/10">
                <div className="min-w-0">
                    <div className="text-sm font-medium text-white/90 truncate" title={user.email}>
                        {user.email}
                    </div>
                    <div
                        className={cn(
                            "mt-1 inline-block px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-widest",
                            role === "owner"
                                ? "text-cyan-300 border-cyan-500/30 bg-cyan-500/10"
                                : "text-white/60 border-white/15 bg-white/5"
                        )}
                    >
                        {role}
                    </div>
                </div>
                <button
                    onClick={signOut}
                    disabled={signingOut}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-white/80 hover:text-white text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <LogOut className="w-4 h-4" />
                    {signingOut ? "Signing out…" : "Sign out"}
                </button>
            </div>
        </div>
    );
};
