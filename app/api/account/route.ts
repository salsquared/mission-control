import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// Required Google scopes for the Gmail + Calendar features. `googleConnected`
// is true only when the owner's Google Account row carries a refresh_token AND
// all of these are present in the granted scope string. Mirrors the `scope`
// requested in lib/auth.ts authOptions — adding a scope there means adding it
// here so a stale-consent account reads as "not connected" and the non-blocking
// reconnect affordance shows.
const REQUIRED_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events",
] as const;

// GET /api/account — the owner identity + Google-connection state the frontend
// needs once past Cloudflare Access. Guarded by the edge-trusted
// `requireSession` (returns the owner; 401 only on the 0-users fresh-machine
// state). Replaces the four components' direct `useSession` gate.
export async function GET() {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;

    const { id, email } = guard.session.user;

    let googleConnected = false;
    try {
        // The owner's Google Account row. `findFirst` (not unique on userId +
        // provider here) is null-safe — a fresh owner with no completed OAuth
        // has no row, which reads as not-connected.
        const account = await prisma.account.findFirst({
            where: { userId: id, provider: "google" },
            select: { refresh_token: true, scope: true },
        });
        const grantedScopes = new Set((account?.scope ?? "").split(/\s+/).filter(Boolean));
        googleConnected = Boolean(account?.refresh_token)
            && REQUIRED_SCOPES.every((s) => grantedScopes.has(s));
    } catch (e) {
        // Best-effort: a DB hiccup degrades to "not connected" (shows the
        // reconnect affordance) rather than failing the whole account fetch.
        console.warn("[account GET] googleConnected derivation failed:", e);
    }

    return NextResponse.json({ user: { id, email }, googleConnected }, { status: 200 });
}
