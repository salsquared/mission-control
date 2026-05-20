import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./prisma";

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
        async signIn({ account }) {
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
