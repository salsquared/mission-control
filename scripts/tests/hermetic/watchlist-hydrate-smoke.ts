/**
 * Hermetic smoke for PB-14: hydrateWatchlistConfig / resolveCreatePayload.
 *
 * Verifies:
 *   1. Null directoryKey → returns parsed stored config (legacy / Advanced).
 *   2. directoryKey matching a real entry → returns the live directory config
 *      (overrides stale stored JSON).
 *   3. directoryKey set to a removed entry → falls back to stored snapshot.
 *   4. resolveCreatePayload with a valid key overrides client-submitted config.
 *   5. resolveCreatePayload with an invented key resets the key to null.
 *
 * No DB, no network. Wire into pre-push.
 */
import { hydrateWatchlistConfig, resolveCreatePayload } from "@/lib/watchlists/hydrate";
import { COMPANY_DIRECTORY } from "@/lib/company-directory";
import type { WatchlistConfig } from "@/lib/schemas/watchlists";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// Pick a known entry to test against — Anthropic is foundational; if it's
// removed from the directory this smoke needs a different anchor.
const anchor = COMPANY_DIRECTORY.find(e => e.name === "Anthropic");
if (!anchor) {
    console.error("Anchor entry 'Anthropic' missing from directory — update this smoke.");
    process.exit(1);
}

// 1. Null directoryKey → parse stored config.
{
    const stored: WatchlistConfig = { kind: "greenhouse", boardSlug: "custom-slug", companyName: "Custom Co" };
    const got = hydrateWatchlistConfig({ config: JSON.stringify(stored), directoryKey: null });
    check(
        "null directoryKey returns parsed stored config",
        got.kind === "greenhouse" && got.kind === "greenhouse" && got.boardSlug === "custom-slug",
    );
}

// 2. directoryKey matching an entry overrides stored config.
{
    const staleStored: WatchlistConfig = { kind: "greenhouse", boardSlug: "wrong-slug-from-old-row", companyName: "Anthropic" };
    const got = hydrateWatchlistConfig({ config: JSON.stringify(staleStored), directoryKey: "Anthropic" });
    const anchorSlug = anchor.config.kind === "greenhouse" ? anchor.config.boardSlug : "";
    check(
        "directoryKey override returns directory config (not stored)",
        got.kind === "greenhouse" && got.kind === "greenhouse" && got.boardSlug === anchorSlug,
        `got slug=${got.kind === "greenhouse" ? got.boardSlug : "(non-greenhouse)"} expected=${anchorSlug}`,
    );
}

// 3. directoryKey set to a removed/invented entry → falls back to stored.
{
    const stored: WatchlistConfig = { kind: "ashby", boardSlug: "fallback-slug", companyName: "Removed Co" };
    const got = hydrateWatchlistConfig({ config: JSON.stringify(stored), directoryKey: "Definitely Not In Directory" });
    check(
        "missing-entry directoryKey falls back to stored snapshot",
        got.kind === "ashby" && got.kind === "ashby" && got.boardSlug === "fallback-slug",
    );
}

// 4. resolveCreatePayload — valid key overrides submitted config.
{
    const tampered: WatchlistConfig = { kind: "greenhouse", boardSlug: "fake-slug", companyName: "Anthropic" };
    const out = resolveCreatePayload(tampered, "Anthropic");
    const anchorSlug = anchor.config.kind === "greenhouse" ? anchor.config.boardSlug : "";
    check(
        "resolveCreatePayload uses directory config when key resolves",
        out.directoryKey === "Anthropic"
        && out.config.kind === "greenhouse"
        && out.config.kind === "greenhouse" && out.config.boardSlug === anchorSlug,
    );
}

// 5. resolveCreatePayload — invented key resets to null.
{
    const submitted: WatchlistConfig = { kind: "lever", boardSlug: "user-supplied", companyName: "Custom" };
    const out = resolveCreatePayload(submitted, "Fictional Entry");
    check(
        "resolveCreatePayload with unknown key sets directoryKey=null + keeps submitted",
        out.directoryKey === null
        && out.config.kind === "lever"
        && out.config.kind === "lever" && out.config.boardSlug === "user-supplied",
    );
}

// 6. resolveCreatePayload — null key passes through unchanged.
{
    const submitted: WatchlistConfig = { kind: "careers-page", rootUrl: "https://ex.com", linkPattern: "x", companyName: "Ex" };
    const out = resolveCreatePayload(submitted, null);
    check(
        "resolveCreatePayload with null key returns null + submitted config",
        out.directoryKey === null && out.config.kind === "careers-page",
    );
}

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
console.log("All checks passed.");
