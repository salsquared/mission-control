import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./prisma";
import { registerGmailWatch } from "./gmail/watch";
import { allowlistUnconfiguredMessage, evaluateSignIn } from "./auth-allowlist";

/**
 * Where an unconfigured allowlist sends the browser. NextAuth's built-in error
 * page renders `Configuration` as "Server error — There is a problem with the
 * server configuration. Check the server logs for more information." (HTTP 500),
 * which is exactly right here and is NOT what a plain `return false` produces:
 * that yields `AccessDenied` ("You do not have permission to sign in"), i.e. the
 * page a genuinely rejected address should see. Keeping the two apart is the
 * difference between "fix your env" and "you're not on the list".
 *
 * NextAuth sets this string as the `Location` header verbatim
 * (next-auth/next `toResponse`), so a relative URL is valid; NEXTAUTH_URL is
 * used when set purely so the redirect is absolute like NextAuth's own.
 */
function signInConfigErrorUrl(): string {
    const base = (process.env.NEXTAUTH_URL ?? "").trim().replace(/\/+$/, "");
    return `${base}/api/auth/error?error=Configuration`;
}

export const authOptions: NextAuthOptions = {
    adapter: PrismaAdapter(prisma) as any,
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
            // Single-provider app + Google verifies emails, so auto-linking
            // an OAuth sign-in to the existing User by email is safe and
            // avoids the OAuthAccountNotLinked loop after an Account row is
            // cleared/recreated.
            allowDangerousEmailAccountLinking: true,
            authorization: {
                params: {
                    access_type: "offline",
                    response_type: "code",
                    // `consent` (not just `select_account`) forces Google's consent
                    // screen on every sign-in. Without it, Google treats already-
                    // consented sign-ins as returning users and omits the
                    // refresh_token — which breaks any flow that goes through
                    // getGoogleAuthClient (Gmail scan, Calendar mirror, etc.) on
                    // a fresh Account row (e.g. after the prod DB was created
                    // separately from dev, both pointing at the same Google
                    // client_id). The signIn callback below persists whatever
                    // tokens Google sends, so this self-heals on next sign-in.
                    prompt: "select_account consent",
                    // Request scopes for Gmail API and Calendar API
                    scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events"
                }
            }
        }),
    ],
    secret: process.env.NEXTAUTH_SECRET,
    callbacks: {
        async signIn({ user, account }) {
            // P1.1 (OQ1a) sign-in allowlist — runs BEFORE any token persist so
            // a disallowed Google account never writes to the Account row, and
            // before PrismaAdapter can mint a `User` row for it. Since the
            // multi-user work that row IS authorization to use this instance
            // (CLAUDE.md §Auth), so this check is FAIL-CLOSED: an unset
            // ALLOWED_SIGNIN_EMAILS refuses everyone rather than admitting
            // everyone. See lib/auth-allowlist.ts's header for the full why.
            const decision = evaluateSignIn(user?.email, process.env.ALLOWED_SIGNIN_EMAILS);
            if (!decision.ok) {
                if (decision.reason === "unconfigured") {
                    // Logged on EVERY attempt, not once per process: the whole
                    // point is that the line is there when the operator looks,
                    // which is the moment sign-in just failed on them.
                    console.error(allowlistUnconfiguredMessage());
                    return signInConfigErrorUrl();
                }
                console.warn(`[auth] sign-in REJECTED for ${user?.email ?? "<no email>"} — not in ALLOWED_SIGNIN_EMAILS`);
                return false;
            }

            // PrismaAdapter doesn't update tokens on re-sign-in to an already-
            // linked account, so a fresh refresh_token from Google would be
            // silently discarded. Persist it (and the new access_token /
            // expiry) onto the existing Account row whenever Google sends one.
            if (account?.provider === "google") {
                const data: Record<string, unknown> = {};
                if (account.refresh_token) data.refresh_token = account.refresh_token;
                if (account.access_token) data.access_token = account.access_token;
                if (account.expires_at) data.expires_at = account.expires_at;
                if (account.id_token) data.id_token = account.id_token;
                if (account.scope) data.scope = account.scope;
                if (Object.keys(data).length > 0) {
                    await prisma.account.updateMany({
                        where: {
                            provider: account.provider,
                            providerAccountId: account.providerAccountId,
                        },
                        data,
                    });
                }

                // Arm the Gmail push watch best-effort so a fresh connect /
                // re-consent goes live immediately instead of waiting for the
                // next daily scheduler tick. Never block (or fail) sign-in on a
                // watch error; the scheduler is the primary keeper. No-ops when
                // GMAIL_PUBSUB_TOPIC is unset. See docs/archive/gmail-realtime-push.html.
                try {
                    const acct = await prisma.account.findFirst({
                        where: { provider: "google", providerAccountId: account.providerAccountId },
                        select: { userId: true },
                    });
                    if (acct) await registerGmailWatch(acct.userId);
                } catch (e) {
                    console.warn("[auth] gmail watch on sign-in failed:", (e as Error)?.message ?? e);
                }
            }
            return true;
        },
        async session({ session, user }) {
            if (session?.user && user?.id) {
                (session.user as any).id = user.id;
            }
            return session;
        }
    }
};
