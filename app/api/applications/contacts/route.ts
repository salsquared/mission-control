import { NextRequest, NextResponse } from "next/server";
import type { Contact } from "@prisma/client";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    ContactPostSchema,
    ContactPatchSchema,
    ContactDeleteSchema,
} from "@/lib/schemas/contacts";
import {
    listContactsForApplication,
    createContact,
    updateContact,
    deleteContact,
} from "@/lib/repositories/contacts";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

// Prisma Date fields become Date objects; serialize to ISO for JSON.
function serialize(c: Contact) {
    return {
        id: c.id,
        applicationId: c.applicationId,
        name: c.name,
        email: c.email,
        role: c.role,
        notes: c.notes,
        lastTouchedAt: c.lastTouchedAt ? c.lastTouchedAt.toISOString() : null,
        position: c.position,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
    };
}

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const applicationId = new URL(req.url).searchParams.get('applicationId');
    if (!applicationId) {
        return NextResponse.json({ error: "applicationId query param required" }, { status: 400 });
    }

    try {
        const rows = await listContactsForApplication(userId, applicationId);
        return NextResponse.json({ contacts: rows.map(serialize) }, { status: 200 });
    } catch (e) {
        console.error("[contacts GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ContactPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const contact = await createContact(userId, {
            applicationId: parsed.data.applicationId,
            name: parsed.data.name,
            email: parsed.data.email ?? null,
            role: parsed.data.role ?? null,
            notes: parsed.data.notes ?? null,
            lastTouchedAt: parsed.data.lastTouchedAt ? new Date(parsed.data.lastTouchedAt) : null,
            position: parsed.data.position,
        });
        if (!contact) {
            // Either the application doesn't exist or it belongs to a different user.
            // 404 over 403 — don't leak existence.
            return NextResponse.json({ error: "Application not found" }, { status: 404 });
        }
        broadcastEvent({ model: 'Contact', action: 'upsert', id: contact.id, timestamp: Date.now() });
        return NextResponse.json({ contact: serialize(contact) }, { status: 200 });
    } catch (e) {
        console.error("[contacts POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ContactPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const contact = await updateContact(userId, parsed.data.id, {
            name: parsed.data.name,
            email: parsed.data.email,
            role: parsed.data.role,
            notes: parsed.data.notes,
            lastTouchedAt: parsed.data.lastTouchedAt === undefined
                ? undefined
                : (parsed.data.lastTouchedAt ? new Date(parsed.data.lastTouchedAt) : null),
            position: parsed.data.position,
        });
        if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
        broadcastEvent({ model: 'Contact', action: 'upsert', id: contact.id, timestamp: Date.now() });
        return NextResponse.json({ contact: serialize(contact) }, { status: 200 });
    } catch (e) {
        console.error("[contacts PATCH] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const idParam = new URL(req.url).searchParams.get('id');
    const body = idParam ? { id: idParam } : await req.json().catch(() => ({}));
    const parsed = ContactDeleteSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const ok = await deleteContact(userId, parsed.data.id);
        if (!ok) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
        broadcastEvent({ model: 'Contact', action: 'delete', id: parsed.data.id, timestamp: Date.now() });
        return NextResponse.json({ success: true, id: parsed.data.id }, { status: 200 });
    } catch (e) {
        console.error("[contacts DELETE] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
