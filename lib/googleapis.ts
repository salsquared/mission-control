import { google } from "googleapis";
import { prisma } from "./prisma";

/**
 * Retrieves a properly authenticated Google OAuth2 client for a given user.
 * Expects the caller to provide a valid user ID who has authenticated with Google via NextAuth.
 */
export async function getGoogleAuthClient(userId: string) {
  const account = await prisma.account.findFirst({
    where: {
      userId: userId,
      provider: "google",
    },
  });

  if (!account || !account.refresh_token) {
    throw new Error("User Google account not linked or missing refresh token.");
  }

  const oauthClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauthClient.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token,
  });

  return oauthClient;
}
