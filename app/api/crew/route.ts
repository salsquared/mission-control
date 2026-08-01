/**
 * Owner-only crew management — list + provision (docs/multi-user-crew.html P7).
 *
 * This is the SECOND production `user.create` path in the codebase. The first,
 * `scripts/manage-crew.ts`, carried a header saying it was the only one; that
 * is why the shared invariants were extracted to `lib/crew/core.ts` before this
 * file existed rather than after. Both surfaces call the same `addCrew`, so
 * neither can drift on "only ever writes role: 'crew'".
 *
 * GUARD: `requireOwner()`. Crew must not enumerate each other — the list here
 * carries every crew member's email plus what they have been spending, which is
 * exactly the cross-user visibility §3.2 says the owner has and crew do not.
 */
import { NextResponse } from 'next/server';

import { requireOwner } from '@/lib/auth-guards';
import { prisma } from '@/lib/prisma';
import { addCrew, type Ops } from '@/lib/crew/core';
import { crewAiDailyLimit } from '@/lib/ai/quota';
import { utcDateBucket } from '@/lib/notifications/dispatch';
import { CrewCreateSchema } from '@/lib/schemas/crew';
import { crewOps } from '@/lib/crew/ops';

export async function GET() {
    const guard = await requireOwner();
    if ('error' in guard) return guard.error;

    const users = await prisma.user.findMany({
        orderBy: [{ role: 'desc' }, { email: 'asc' }],   // owner first, then crew A–Z
        select: { id: true, email: true, name: true, role: true },
    });

    // Counters, batched rather than per-row: three grouped queries instead of
    // 3N. The crew list is small today, but a per-row loop here is the N+1 that
    // gets noticed only once it is slow.
    const ids = users.map((u) => u.id);
    const today = utcDateBucket();
    const [aiRows, watchRows, appRows] = await Promise.all([
        prisma.aiUsage.findMany({ where: { userId: { in: ids }, day: today }, select: { userId: true, count: true } }),
        prisma.watchlist.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true } }),
        prisma.application.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true } }),
    ]);
    const aiByUser = new Map(aiRows.map((r) => [r.userId, r.count]));
    const watchByUser = new Map(watchRows.map((r) => [r.userId, r._count._all]));
    const appByUser = new Map(appRows.map((r) => [r.userId, r._count._all]));

    return NextResponse.json({
        crew: users.map((u) => ({
            id: u.id,
            email: u.email ?? '',
            name: u.name ?? null,
            role: u.role ?? 'crew',
            aiUsedToday: aiByUser.get(u.id) ?? 0,
            watchlistCount: watchByUser.get(u.id) ?? 0,
            applicationCount: appByUser.get(u.id) ?? 0,
        })),
        aiDailyLimit: crewAiDailyLimit(),
        ownerCount: users.filter((u) => u.role === 'owner').length,
    });
}

export async function POST(req: Request) {
    const guard = await requireOwner();
    if ('error' in guard) return guard.error;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const parsed = CrewCreateSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'Provide an email address.', issues: parsed.error.issues }, { status: 400 });
    }

    // `addCrew` owns normalization, the duplicate check, the never-mint-an-owner
    // assertion and the post-create verification. Everything below is
    // translation of its outcome into HTTP — no provisioning logic lives here.
    const ops: Ops = crewOps(prisma as unknown as Ops['db']);
    const result = await addCrew(parsed.data.email, ops);

    if (result.outcome === 'invalid-email') {
        return NextResponse.json({ error: `"${parsed.data.email}" is not a valid email address.` }, { status: 400 });
    }
    if (result.outcome === 'duplicate') {
        return NextResponse.json(
            { error: `${result.email} already has an account on this instance.`, email: result.email },
            { status: 409 },
        );
    }
    if (!result.ok) {
        // Includes `refused-owner` — the create-returned-a-non-crew-row trap,
        // which `addCrew` undoes before reporting. A 500 is right: it means an
        // invariant the schema is supposed to guarantee did not hold.
        return NextResponse.json({ error: 'Could not provision that account. Check the server log.' }, { status: 500 });
    }

    return NextResponse.json({ email: result.email, role: result.role ?? 'crew' }, { status: 201 });
}
