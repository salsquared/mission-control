/**
 * Hermetic smoke for the curated company directory.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/company-directory-smoke.ts
 *
 * The directory's whole job is to ship watchlist configs the API would
 * accept verbatim. Catch shape drift (a typo in a tenantHost, a stale slug
 * field, a missing companyName) at boot, not on the user's first click.
 *
 * Also asserts:
 *   - every entry has unique name (no dupes)
 *   - every entry's tags are valid DirectoryTag values
 *   - the search helper handles empty query / tag set correctly
 */
import { COMPANY_DIRECTORY, DIRECTORY_TAGS, searchDirectory } from "@/lib/company-directory";
import { WatchlistConfigSchema, WatchlistPostSchema } from "@/lib/schemas/watchlists";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function main() {
    if (COMPANY_DIRECTORY.length === 0) {
        fail("directory is empty");
        return;
    }
    pass(`directory has ${COMPANY_DIRECTORY.length} entries`);

    const seenNames = new Set<string>();
    for (const entry of COMPANY_DIRECTORY) {
        if (seenNames.has(entry.name)) {
            fail(`duplicate name in directory: ${entry.name}`);
            continue;
        }
        seenNames.add(entry.name);

        // 1. Tags must be in the canonical set.
        for (const tag of entry.tags) {
            if (!DIRECTORY_TAGS.includes(tag)) {
                fail(`${entry.name}: unknown tag "${tag}"`);
            }
        }

        // 2. Config must parse against the live WatchlistConfig schema —
        // this is the same parse the /api/watchlists POST does.
        const parsed = WatchlistConfigSchema.safeParse(entry.config);
        if (!parsed.success) {
            fail(`${entry.name}: config doesn't validate`, parsed.error.flatten().fieldErrors);
            continue;
        }

        // 3. End-to-end: the full POST shape (what the modal sends).
        const postShape = WatchlistPostSchema.safeParse({
            name: `${entry.name} — jobs`,
            config: entry.config,
            scheduleMinutes: 60,
        });
        if (!postShape.success) {
            fail(`${entry.name}: full POST shape doesn't validate`, postShape.error.flatten().fieldErrors);
            continue;
        }

        pass(`${entry.name}: valid ${entry.config.kind} config`);
    }

    // 4. Search helper sanity.
    if (searchDirectory("", null).length !== COMPANY_DIRECTORY.length) {
        fail("searchDirectory('', null) should return everything");
    } else {
        pass("searchDirectory('', null) returns all entries");
    }

    const anthropic = searchDirectory("anthropic", null);
    if (anthropic.length !== 1 || anthropic[0].name !== "Anthropic") {
        fail(`searchDirectory("anthropic") expected [Anthropic], got ${anthropic.map(e => e.name).join(",")}`);
    } else {
        pass("searchDirectory matches by name (case-insensitive)");
    }

    const spaceOnly = searchDirectory("", new Set(["space"]));
    if (spaceOnly.length === 0 || spaceOnly.some(e => !e.tags.includes("space"))) {
        fail(`searchDirectory tag filter expected non-empty all-tagged-space, got ${spaceOnly.map(e => `${e.name}[${e.tags.join(",")}]`).join(",")}`);
    } else {
        pass(`searchDirectory tag-filters correctly (space-only: ${spaceOnly.length})`);
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails === 0) console.log("All checks passed.");
    if (fails > 0) process.exit(1);
}

main();
