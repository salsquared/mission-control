/**
 * Owner-only crew removal (docs/multi-user-crew.html P7, OQ17b).
 *
 * THE MOST DESTRUCTIVE ROUTE IN THIS CODEBASE. One call deletes a person's
 * `User` row, cascades all 18 relations (applications, resumes, watchlists,
 * tasks, notifications, their Google account link…) and sweeps their generated
 * resume + upload files off disk. There is no undo and no soft-delete. The CLI
 * equivalent makes you pass `--confirm-delete` after printing a manifest; the
 * UI equivalent makes you type the email. This route enforces the second.
 *
 * THREE INDEPENDENT SAFETY CHECKS, in order:
 *   1. `requireOwner()` — crew cannot reach it at all.
 *   2. `confirmEmail` must equal the TARGET ROW's email. The id says which row,
 *      the typed string says which person; if they disagree the request is
 *      refused. This is what makes a stale list or a mis-wired button unable to
 *      delete the wrong human — the dangerous failure is not "deletes nobody",
 *      it is "deletes somebody else".
 *   3. `removeUser` itself refuses `role: 'owner'` (lib/crew/core.ts), so even
 *      an owner id typed with a matching owner email is rejected — deleting
 *      that row 403s the owner out of their own app permanently, because
 *      `resolveOwner()` selects on it.
 */
import { NextResponse } from 'next/server';

import { requireOwner } from '@/lib/auth-guards';
import { prisma } from '@/lib/prisma';
import { removeUser, type Ops } from '@/lib/crew/core';
import { crewOps } from '@/lib/crew/ops';
import { CrewDeleteSchema } from '@/lib/schemas/crew';

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const guard = await requireOwner();
    if ('error' in guard) return guard.error;

    const { id } = await ctx.params;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }
    const parsed = CrewDeleteSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'Type the account\'s email address to confirm removal.', issues: parsed.error.issues },
            { status: 400 },
        );
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
    if (!target) {
        return NextResponse.json({ error: 'No such account.' }, { status: 404 });
    }

    // Check (2). Compared the same way both provisioning surfaces normalize —
    // trimmed and lowercased — so a confirmation typed with different casing is
    // accepted while a confirmation naming a DIFFERENT PERSON never is.
    const typed = parsed.data.confirmEmail.trim().toLowerCase();
    const actual = (target.email ?? '').trim().toLowerCase();
    if (!actual || typed !== actual) {
        return NextResponse.json(
            {
                error: 'That email does not match the account you are removing. Nothing was deleted.',
                reason: 'confirm-mismatch',
            },
            { status: 400 },
        );
    }

    // Check (3) lives inside `removeUser`, not here — one implementation of the
    // owner refusal, shared with the CLI, so the two cannot disagree about it.
    const ops: Ops = crewOps(prisma as unknown as Ops['db']);
    const result = await removeUser(target.email ?? '', ops, { confirm: true });

    if (result.outcome === 'refused-owner') {
        return NextResponse.json(
            {
                error: 'That account is the owner and cannot be removed — deleting it would lock you out of this app.',
                reason: 'refused-owner',
            },
            { status: 400 },
        );
    }
    if (result.outcome === 'not-found') {
        return NextResponse.json({ error: 'No such account.' }, { status: 404 });
    }
    if (!result.ok) {
        return NextResponse.json({ error: 'Removal failed. Check the server log.' }, { status: 500 });
    }

    // `swept.failed` is NOT an error: the row and every cascaded relation are
    // already gone, so failing the request would imply the delete did not
    // happen. Report it instead — an orphaned file the owner can remove by hand
    // is a far better outcome than a caller that retries a completed delete.
    return NextResponse.json({
        email: result.email,
        deletedFiles: result.swept?.deleted.length ?? 0,
        orphanedFiles: result.swept?.failed ?? [],
    });
}
