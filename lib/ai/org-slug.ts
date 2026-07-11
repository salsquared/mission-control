/**
 * Filename slug for a leaderboard org name ("Mistral AI" → "mistral-ai").
 * Lives alone so the client card can import it without pulling the
 * cheerio/fs-dependent leaderboard modules into the browser bundle.
 * Must stay in lockstep with the harvester's file naming (lib/ai/org-logos.ts).
 */
export function orgSlug(orgName: string): string {
    return orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
