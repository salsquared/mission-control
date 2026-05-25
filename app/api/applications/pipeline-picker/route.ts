import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { findInterestedWithPostingForUser } from "@/lib/repositories/applications";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    const id = user?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
}

// M8.4.4 (story S8.12) — Pipeline picker endpoint. Read-only projection of the
// user's INTERESTED-status applications that carry a usable posting URL. Used
// by the Pipeline tab of GenerateResumeCard's segmented control as the source
// list. Per Decision 6.4, URL-less Interested apps are hidden — the picker is
// purpose-built for the auto-fill generate flow, and a posting URL is what
// the generate pipeline consumes.
//
// Hardcoded to status='INTERESTED'; no ?status param. Different columns aren't
// in scope for the picker (defense-in-depth: the POST handler also rejects
// applicationIds whose application isn't INTERESTED).
export async function GET() {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    try {
        const rows = await findInterestedWithPostingForUser(userId);
        const items = rows
            // Defensive: schema permits posting.sourceUrl absence (and posting
            // itself could in theory be null mid-cascade), so post-filter rather
            // than trust the `NOT: { postingId: null }` in the repo helper.
            .filter(r => typeof r.posting?.sourceUrl === "string" && r.posting.sourceUrl.length > 0)
            .map(r => {
                const postingTitleRaw = r.posting?.title ?? "";
                const postingTitle = postingTitleRaw.trim().length > 0
                    ? postingTitleRaw
                    : (r.role ?? "");
                return {
                    id: r.id,
                    company: r.company,
                    role: r.role,
                    postingUrl: r.posting!.sourceUrl,
                    postingTitle,
                    track: r.track,
                };
            });
        return NextResponse.json({ items }, { status: 200 });
    } catch (e) {
        console.error("[pipeline-picker GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
