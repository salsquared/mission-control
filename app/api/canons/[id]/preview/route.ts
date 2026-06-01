import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getCanon, getCanonSelection } from "@/lib/repositories/canons";
import { findOrCreateProfile } from "@/lib/repositories/profile";
import { resolveSelection, resolveExtras } from "@/lib/canons/selection";
import { composeResumeProps } from "@/lib/resumes/templates/ats-plain";
import { renderResumeHTML } from "@/lib/resumes/render-html";
import type { SectionKey } from "@/lib/resumes/tagline-tailor";
import type { ProfileWire } from "@/lib/schemas/profile";

export const runtime = "nodejs";

// On-screen HTML preview of a Canon's manual resume selection
// (docs/archive/resume-manual-builder.html). The builder opens this in a new
// tab after Generate so links ("Repo" / "Website" / contact) open in their own
// tab — the PDF render can't do that (Chrome's PDF viewer ignores
// target=_blank). Rendered VERBATIM (no AI rewrite/tagline) to stay instant +
// match the builder's default; the persisted PDF/DOCX artifact is the
// authoritative output.

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    try {
        const canon = await getCanon(userId, id);
        if (!canon) return NextResponse.json({ error: "Canon not found" }, { status: 404 });

        const selection = await getCanonSelection(userId, id);
        if (!selection) {
            return NextResponse.json(
                { error: "This canon has no saved selection yet — open the builder and curate it first." },
                { status: 400 },
            );
        }

        // Mirror generateCanonManualResume's verbatim composition (rewrite +
        // tagline off): resolve against the live profile, filter toggled-off
        // sections, intersect extras with the profile.
        const hydrated = await findOrCreateProfile(userId);
        const profile = JSON.parse(JSON.stringify(hydrated)) as ProfileWire;
        const resolved = resolveSelection(profile, selection);
        const off = new Set(selection.sectionsOff);
        const sectionOrder = selection.sectionOrder.filter((s) => !off.has(s)) as SectionKey[];
        const extras = resolveExtras(profile, selection);
        const props = composeResumeProps(profile, resolved, [], profile.tagline ?? null, extras, sectionOrder);
        const html = await renderResumeHTML(props);

        return new NextResponse(html, {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "private, no-store, max-age=0",
            },
        });
    } catch (e) {
        console.error(`[canons/${id}/preview GET] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
