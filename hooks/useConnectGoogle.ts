"use client";

import { useCallback } from "react";

/**
 * Start (or refresh) the Google connection — the Gmail + Calendar refresh token
 * that `lib/auth.ts` persists on the `Account` row. Shared by the three owner-only
 * "Connect / Reconnect Google" affordances (Internal Systems' account card, the
 * Profile banner, the Applications header) so they cannot drift.
 *
 * This is a NAVIGATION, deliberately, and NOT next-auth's `signIn("google")`.
 *
 * next-auth v4's `signIn()` is fetch-based: before it ever touches
 * `window.location` it awaits THREE requests — `/api/auth/providers`,
 * `/api/auth/csrf`, then a POST to `/api/auth/signin/google`. On prod every one
 * of those paths sits behind its own owner-only Cloudflare Access application
 * (the path-scoped app on `/api/auth/*`, which exists so a crew member cannot
 * self-provision through Google sign-in — `PrismaAdapter` mints a `User` row on
 * first sign-in, and a `User` row IS the authorization). Access answers an
 * unauthenticated request there with a cross-origin 302 to the Cloudflare login
 * page, which a `fetch` cannot follow: it throws, next-auth logs
 * `CLIENT_FETCH_ERROR … "Load failed"`, and its `if (!providers)` branch then
 * strands the user on `/api/auth/error`.
 *
 * Navigating hands the redirect to the BROWSER, which follows it natively and
 * comes back. A GET on this route renders next-auth's own sign-in page carrying
 * hidden `csrfToken` + `callbackUrl` inputs, and its button is a form POST —
 * also a navigation. The cost is one extra click; the benefit is that it works
 * from behind the edge, which the fetch path does not.
 *
 * `callbackUrl` is the current URL, so the user lands back on the dash they
 * started from rather than the app root.
 */
export function useConnectGoogle() {
    return useCallback(() => {
        const callbackUrl = encodeURIComponent(window.location.href);
        window.location.href = `/api/auth/signin/google?callbackUrl=${callbackUrl}`;
    }, []);
}
