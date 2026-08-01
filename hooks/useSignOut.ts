"use client";

import { useCallback, useState } from "react";

/**
 * Cloudflare Access's logout endpoint, served AT THE EDGE on whatever hostname
 * the browser is already on — the request never reaches this origin. Hitting it
 * clears the `CF_Authorization` cookie, and that cookie is the ENTIRE session:
 * `lib/viewer.ts:resolveViewer()` derives identity from the header the edge
 * stamps after verifying it, and this app holds no session of its own.
 *
 * Relative on purpose. `mc.salsquared.xyz` and `mc-dev.salsquared.xyz` are
 * separate Access applications with separate cookies (separate AUDs), so
 * sign-out has to act on the host the user is actually on — an absolute URL
 * would sign a dev tester out of prod instead, or silently no-op.
 *
 * Verified live 2026-08-01: GET returns 200 from `server: cloudflare` with
 * Cloudflare's own page ("No Access cookie found. Please login first." when
 * there is nothing to clear). It answers GET only — a HEAD probe 404s, which
 * is a red herring, not a broken endpoint.
 *
 * On loopback (127.0.0.1:3101 / :4101) there is no edge, so this 404s against
 * Next. That is only reachable via the env-gated `MC_{DEV,PROD}_LOOPBACK_OWNER`
 * break-glass branches — where there is no Access session to end anyway — so a
 * 404 is the honest outcome rather than a bug worth coding around.
 */
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

/**
 * The one way out of the app, shared by the Launchpad's account panel and the
 * Internal Systems account card so the two can never drift apart.
 *
 * It is deliberately ONE navigation and nothing else.
 *
 * IT DOES NOT CALL next-auth's `signOut()`. That was the original Internal
 * Systems "Disconnect" button, and it fails three ways at once:
 *
 *  1. It clears a cookie NOTHING READS. `useSession` has zero callers in this
 *     repo and `resolveViewer()` authorizes off the Access header, so the
 *     NextAuth session is vestigial — retained only to mint/refresh the Gmail +
 *     Calendar token (`lib/auth.ts`). Clearing it ends no session.
 *  2. It fetches `/api/auth/csrf` and then POSTs `/api/auth/signout` — two
 *     fetches, and on prod those live behind their OWN Access application
 *     (the path-scoped owner-only "OAuth Connect" app on `/api/auth/*`), which
 *     answers a cross-origin 302 to the Cloudflare login page. A `fetch` cannot
 *     follow that, so each one throws and next-auth logs
 *     `CLIENT_FETCH_ERROR … "Load failed"`. Two calls, two console errors.
 *  3. Its default `redirect: true` finishes by reloading the page, which is
 *     why the button appeared to "do nothing but refresh".
 *
 * A plain navigation has none of those failure modes: the browser follows
 * redirects natively (which is also why the neighbouring `signIn("google")`
 * still works — it navigates rather than fetches), and the edge does the work.
 *
 * The NextAuth cookie is therefore left to expire on its own. That is a
 * deliberate call, not an oversight: nothing authorizes off it, and on prod
 * `/api/auth/*` is owner-only at the edge, so a later viewer on the same
 * browser cannot reach an endpoint that would even echo it back.
 */
export function useSignOut() {
    const [signingOut, setSigningOut] = useState(false);

    const signOut = useCallback(() => {
        // `signingOut` is returned so the caller can disable its own control.
        // The navigation is asynchronous from the click handler's point of
        // view — the page keeps running while it tears down — so without a
        // disabled state the button stays clickable the whole way out.
        setSigningOut(true);
        window.location.href = ACCESS_LOGOUT_PATH;
    }, []);

    return { signOut, signingOut };
}
