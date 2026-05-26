/**
 * Quick CLI to set/clear `pinKeywords` on a single profile entity (WorkRole /
 * Project / Education). Bridges the gap until the Profile UI grows a
 * per-entity pin-editor chip list.
 *
 * Usage:
 *   # List entities so you can grab an ID
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/set-entity-pin-keywords.ts --list
 *
 *   # Set pins on one entity
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/set-entity-pin-keywords.ts \
 *     --kind project --id <entity-id> --pin "software engineering, computer science, space systems"
 *
 *   # Clear pins
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/set-entity-pin-keywords.ts \
 *     --kind project --id <entity-id> --clear
 *
 * Pins are stored as JSON-stringified string[]. Matching against posting
 * keywords is case-insensitive whole-word — same matcher the bullet scorer
 * uses. See `lib/resumes/select.ts:entityIsPinned` for the semantic.
 */
import { prisma } from '@/lib/prisma';

type Kind = 'workRole' | 'project' | 'education';

function parseArgs(): { list: boolean; kind?: Kind; id?: string; pin?: string[]; clear: boolean } {
    const args = process.argv.slice(2);
    let list = false;
    let kind: Kind | undefined;
    let id: string | undefined;
    let pin: string[] | undefined;
    let clear = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--list') list = true;
        else if (a === '--clear') clear = true;
        else if (a === '--kind') kind = args[++i] as Kind;
        else if (a === '--id') id = args[++i];
        else if (a === '--pin') pin = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    }
    return { list, kind, id, pin, clear };
}

async function listEntities() {
    const wrs = await prisma.workRole.findMany({
        select: { id: true, title: true, company: true, pinKeywords: true },
        orderBy: { startDate: 'desc' },
    });
    console.log('\n── workRoles ──');
    for (const w of wrs) {
        const pins = parsePins(w.pinKeywords);
        console.log(`  [${w.id}] ${w.title} @ ${w.company}` + (pins.length ? `  pin=${JSON.stringify(pins)}` : ''));
    }
    const projects = await prisma.project.findMany({
        select: { id: true, name: true, pinKeywords: true },
        orderBy: { position: 'asc' },
    });
    console.log('\n── projects ──');
    for (const p of projects) {
        const pins = parsePins(p.pinKeywords);
        console.log(`  [${p.id}] ${p.name}` + (pins.length ? `  pin=${JSON.stringify(pins)}` : ''));
    }
    const edu = await prisma.education.findMany({
        select: { id: true, institution: true, degree: true, pinKeywords: true },
        orderBy: { startDate: 'desc' },
    });
    console.log('\n── education ──');
    for (const e of edu) {
        const pins = parsePins(e.pinKeywords);
        console.log(`  [${e.id}] ${e.degree ?? 'Education'} @ ${e.institution}` + (pins.length ? `  pin=${JSON.stringify(pins)}` : ''));
    }
}

function parsePins(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const j = JSON.parse(raw);
        return Array.isArray(j) ? j.filter(x => typeof x === 'string') : [];
    } catch { return []; }
}

function serializePins(pins: string[]): string | null {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of pins) {
        const t = p.trim();
        if (!t) continue;
        const lk = t.toLowerCase();
        if (seen.has(lk)) continue;
        seen.add(lk);
        out.push(t);
    }
    return out.length === 0 ? null : JSON.stringify(out);
}

async function main() {
    const { list, kind, id, pin, clear } = parseArgs();
    console.log(`DATABASE_URL: ${process.env.DATABASE_URL ?? '(unset)'}`);

    if (list) {
        await listEntities();
        await prisma.$disconnect();
        return;
    }

    if (!kind || !id) {
        console.error('Usage: --list  OR  --kind <workRole|project|education> --id <id> {--pin "a,b,c" | --clear}');
        process.exit(2);
    }
    if (!clear && (!pin || pin.length === 0)) {
        console.error('Provide --pin "a,b,c" or --clear');
        process.exit(2);
    }

    const next = clear ? null : serializePins(pin!);

    if (kind === 'workRole') {
        const row = await prisma.workRole.update({ where: { id }, data: { pinKeywords: next }, select: { id: true, title: true, company: true, pinKeywords: true } });
        console.log(`✔ workRole [${row.id}] ${row.title} @ ${row.company}  pinKeywords=${row.pinKeywords ?? 'null'}`);
    } else if (kind === 'project') {
        const row = await prisma.project.update({ where: { id }, data: { pinKeywords: next }, select: { id: true, name: true, pinKeywords: true } });
        console.log(`✔ project [${row.id}] ${row.name}  pinKeywords=${row.pinKeywords ?? 'null'}`);
    } else if (kind === 'education') {
        const row = await prisma.education.update({ where: { id }, data: { pinKeywords: next }, select: { id: true, institution: true, degree: true, pinKeywords: true } });
        console.log(`✔ education [${row.id}] ${row.degree ?? 'Education'} @ ${row.institution}  pinKeywords=${row.pinKeywords ?? 'null'}`);
    } else {
        console.error('Unknown --kind: ' + kind);
        process.exit(2);
    }
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
