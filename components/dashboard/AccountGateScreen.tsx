"use client";

import React from "react";
import { AlertTriangle, RefreshCw, ShieldAlert, UserX } from "lucide-react";
import type { AccountError, AccountState } from "@/hooks/useAccount";
import { ACCESS_LOGOUT_PATH } from "@/hooks/useSignOut";

/**
 * The three TERMINAL outcomes of `useAccount()` — everything that is neither
 * `'loading'` (transient) nor `'ready'` (the shell renders). Derived from
 * `AccountState` rather than re-typed, so a new member of that union becomes a
 * `tsc` error here instead of silently falling into the generic branch.
 */
export type AccountGateState = Exclude<AccountState, "loading" | "ready">;

interface AccountGateScreenProps {
    state: AccountGateState;
    error: AccountError | null;
    onRetry: () => void;
}

/**
 * Shared chrome for the three screens. Deliberately thin: the whole point of
 * P3.8 is that the three states read DIFFERENTLY, so the frame carries only
 * layout and each branch below supplies its own icon, headline, explanation
 * and call to action.
 */
const GateFrame: React.FC<{
    icon: React.ReactNode;
    title: string;
    children: React.ReactNode;
}> = ({ icon, title, children }) => (
    <div className="w-full min-h-screen flex items-center justify-center bg-background text-foreground p-8">
        <div className="w-full max-w-xl bg-black/40 rounded-lg border border-white/5 p-8">
            <div className="flex items-center gap-4">
                {icon}
                <h1 className="text-sm font-bold uppercase tracking-[0.2em] text-foreground/70">
                    {title}
                </h1>
            </div>
            <div className="mt-8 space-y-4 text-sm leading-relaxed text-foreground/60">
                {children}
            </div>
        </div>
    </div>
);

const RetryButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
    <button
        onClick={onClick}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 bg-white/5 text-foreground/80 text-sm font-medium hover:bg-white/10 transition-colors"
    >
        <RefreshCw className="w-4 h-4" />
        {label}
    </button>
);

/** Muted diagnostic line — what to quote to the owner when the copy isn't enough. */
const StatusLine: React.FC<{ error: AccountError | null }> = ({ error }) => {
    if (!error) return null;
    const code = error.status === 0 ? "no response" : `HTTP ${error.status}`;
    return (
        <p className="font-mono text-xs text-foreground/30 break-words">
            {error.reason ? `${code} · ${error.reason}` : code}
        </p>
    );
};

/**
 * The terminal state for a viewer the shell cannot render for (P3.8).
 *
 * Before this existed, a person in OQ3a's two-step provisioning window — P5.3
 * widens the Access policy, P5.4 creates their `User` row, and real people sit
 * between the two — got an INFINITE SPINNER: the shell was unguarded and
 * `useAccount()` runs with `retry: false`, so the 403 resolved to a permanent
 * loading state with no text at all.
 *
 * The three states are kept apart on purpose, because each one implies a
 * different action by a different person:
 *
 *   'unprovisioned' (403) — the edge knows them, this instance does not. The
 *                           OWNER has to add the address. Recoverable, expected.
 *   'unauthenticated' (401) — no Access-verified identity reached the origin at
 *                           all. An edge / routing misconfiguration; provisioning
 *                           the address would do nothing.
 *   'error'         — network failure, 5xx, or a payload this client cannot read.
 *                     No verdict was issued about their access.
 *
 * Collapsing them would send the reader to the wrong person with the wrong ask,
 * which is exactly why `lib/auth-guards.ts` separates the two codes (§2.3).
 *
 * The guard's `detail` is rendered VERBATIM in both rejection branches. It is
 * written as human-facing copy — the 403 leads with the signed-in email so the
 * reader can quote the exact address to provision, and the 401 names the public
 * hostnames to reach the app through. Paraphrasing it here would duplicate
 * facts that live in `denyViewer()` and drift from them.
 */
export const AccountGateScreen: React.FC<AccountGateScreenProps> = ({ state, error, onRetry }) => {
    if (state === "unprovisioned") {
        return (
            <GateFrame
                icon={<UserX className="w-8 h-8 shrink-0 text-amber-400" />}
                title="Account not provisioned"
            >
                <p>
                    Cloudflare Access verified who you are at the edge, but this Mission Control
                    instance has no account for that address yet. Your sign-in is fine — the owner
                    just has to add you.
                </p>
                {error?.detail && (
                    <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-foreground/80">
                        {error.detail}
                    </p>
                )}
                <p>
                    Send the owner the address above, exactly as it appears. Once they have added
                    it, retry — no need to reload the page.
                </p>
                <RetryButton label="I've been added — retry" onClick={onRetry} />
                <p>
                    {/*
                     * Escape hatch for the MOST LIKELY 403: someone who
                     * authenticated at the edge with the wrong Google account.
                     * The only other sign-out control lives in AccountPanel
                     * inside the Launchpad, which never mounts in a gate state
                     * — and Access sessions last 24h on prod / a month on dev,
                     * so without this link the trap is durable (clearing
                     * cookies is the only manual escape, painful on mobile).
                     * A plain navigation, same as useSignOut: the edge serves
                     * ACCESS_LOGOUT_PATH on this hostname and clears the
                     * Access cookie. Deliberately ONLY on this branch — on the
                     * 401 screen there is no Access session to end, and
                     * offering sign-out there would misdirect the reader
                     * toward a fix that cannot work.
                     */}
                    Not you?{" "}
                    <a
                        href={ACCESS_LOGOUT_PATH}
                        className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
                    >
                        Sign out and switch accounts
                    </a>
                    .
                </p>
                <StatusLine error={error} />
            </GateFrame>
        );
    }

    if (state === "unauthenticated") {
        return (
            <GateFrame
                icon={<ShieldAlert className="w-8 h-8 shrink-0 text-red-400" />}
                title="No verified identity"
            >
                <p>
                    No Cloudflare-Access-verified identity reached this origin, so Mission Control
                    cannot tell who you are. This is a routing or edge-configuration problem, not a
                    missing account — asking the owner to provision your address will not fix it.
                </p>
                {error?.detail && (
                    <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-foreground/80">
                        {error.detail}
                    </p>
                )}
                <p>
                    If that is already the URL you are on, the tunnel or the Access application
                    needs attention — tell the owner.
                </p>
                <RetryButton label="Retry" onClick={onRetry} />
                <StatusLine error={error} />
            </GateFrame>
        );
    }

    return (
        <GateFrame
            icon={<AlertTriangle className="w-8 h-8 shrink-0 text-red-400" />}
            title="Account check failed"
        >
            <p>
                {error?.status === 0
                    ? "The request never reached the server. You are offline, or this instance is down."
                    : "Mission Control could not read your account. Nothing was decided about your access — this is a failed request, not a refusal."}
            </p>
            {error?.message && (
                <p className="font-mono text-xs text-foreground/40 break-words">{error.message}</p>
            )}
            <RetryButton label="Try again" onClick={onRetry} />
            <StatusLine error={error} />
        </GateFrame>
    );
};
