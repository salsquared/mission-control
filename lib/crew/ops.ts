/**
 * Server-side `Ops` builder for `lib/crew/core.ts` (docs/multi-user-crew.html P7).
 *
 * WHY THIS IS A SEPARATE FILE FROM THE CORE. The core is deliberately
 * environment-agnostic — it never resolves a path — so that the same logic runs
 * under `tsx` from the repo root (the CLI) and inside a bundled Next server
 * (the owner-only crew routes). Each caller supplies the two directories a
 * removal has to sweep by hand, because all 18 `User` relations cascade in
 * SQLite but THE FILESYSTEM DOES NOT.
 *
 * WHY `process.cwd()` AND NOT `__dirname`. `scripts/manage-crew.ts` derives its
 * root from `__dirname` on purpose — a CLI can be invoked from anywhere, and
 * the sweep must not move with the shell's cwd. That reasoning INVERTS inside
 * Next: `__dirname` there points into the build output, so the same expression
 * would resolve to a directory containing no resume files at all, and the sweep
 * would report success having deleted nothing. PM2 starts both tiers from the
 * repo root, and `lib/resumes/storage.ts:14` already writes these files at
 * `join(process.cwd(), "data", "resumes")` — so matching that expression is
 * what guarantees the sweep looks where the writer put them. If storage.ts ever
 * changes how it roots that path, this must change with it.
 */
import { join } from 'node:path';

import type { Db, Ops } from '@/lib/crew/core';

export function crewOps(db: Db): Ops {
    return {
        db,
        resumesDir: join(process.cwd(), 'data', 'resumes'),
        uploadsDir: join(process.cwd(), 'data', 'resume-uploads'),
    };
}
