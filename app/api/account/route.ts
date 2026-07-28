import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// Required Google scopes for the Gmail + Calendar features. `googleConnected`
// is true only when the viewer's Google Account row carries a refresh_token AND
// all of these are present in the granted scope string. Mirrors the `scope`
// requested in lib/auth.ts authOptions — adding a scope there means adding it
// here so a stale-consent account reads as "not connected" and the non-blocking
// reconnect affordance shows.
//
// Only the owner ever has such a row: crew never connect Google (OQ6a is an
// explicit v1 non-goal, and ALLOWED_SIGNIN_EMAILS stays at its single entry),
// so `googleConnected` is permanently false for them. That is why the frontend
// gates the "Connect Gmail / Calendar" affordance on `role === 'crew'` and NOT
// on `googleConnected` — see P3.5.
const REQUIRED_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events",
] as const;

// GET /api/account — the VIEWER's identity, role and Google-connection state:
// everything the frontend needs to decide what to render once past Cloudflare
// Access. Guarded by `requireSession`, so any provisioned viewer passes (owner
// or crew) and the two rejections are kept apart on purpose
// (lib/auth-guards.ts, §2.3):
//
//   401 `no-verified-identity` — no Access-verified identity reached the
//       origin. The edge or the JWT config is wrong; nothing the person can do.
//   403 `not-provisioned`      — Access authenticated them, but this instance
//       has no `User` row for that address (OQ3a's deliberate two-step
//       provisioning). The `detail` string names the signed-in email so the UI
//       can tell them exactly which address the owner must add.
//
// This is the ONE route every client hits before rendering, so those two codes
// are the client's only signal for that fork — hooks/useAccount.ts surfaces
// them separately (P3.8's terminal state) rather than collapsing both into a
// generic error.
//
// RESPONSE (200): { user: { id, email, role }, googleConnected }
//
// `role` costs ZERO extra queries — `requireSession` already synthesized it
// onto the session from the single `resolveViewer()` lookup. Do not add a
// `prisma.user.findUnique` here to re-read it.
export async function GET() {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;

    const { id, email, role } = guard.session.user;

    let googleConnected = false;
    try {
        // The viewer's Google Account row. `findFirst` (not unique on userId +
        // provider here) is null-safe — a fresh owner with no completed OAuth,
        // or any crew member, has no row, which reads as not-connected.
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

    // Additive: `role` joins `user`, so every existing `user.id` / `user.email`
    // consumer is untouched. It is `"owner" | "crew"` — already narrowed by
    // `normalizeRole()` in lib/viewer.ts, so a garbage DB value can never reach
    // the client as a third variant.
    return NextResponse.json({ user: { id, email, role }, googleConnected }, { status: 200 });
}
