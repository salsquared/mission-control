/**
 * Hermetic smoke for lib/news/latest.ts (2026-07-31).
 *
 * `selectLatestArticles` feeds the hero carousel at the top of the AI dash's
 * Company News section: flatten every per-company feed into ONE newest-first,
 * deduped, capped list.
 *
 *   npx tsx scripts/tests/hermetic/news-latest-smoke.ts
 *
 * Pure function — no DB, no network, no env needed. Every date below is a
 * literal, so this never depends on the clock.
 */
import { selectLatestArticles, type FeedArticle } from "@/lib/news/latest";

let passed = 0;
let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name} — got ${g}, want ${w}`); failed++; }
}

const art = (title: string, published_at?: string, extra: Partial<FeedArticle> = {}): FeedArticle => ({
    title,
    url: extra.url ?? `https://example.com/${title.toLowerCase().replace(/\s+/g, '-')}`,
    published_at,
    ...extra,
});

// ── Ordering across feeds ──────────────────────────────────────────────────
{
    const picked = selectLatestArticles({
        Anthropic: [art("Older claude post", "2026-07-01T00:00:00Z")],
        NVIDIA: [art("Newest gpu post", "2026-07-30T00:00:00Z")],
        OpenAI: [art("Middle post", "2026-07-15T00:00:00Z")],
    });
    eq("newest first across feeds", picked.map(a => a.title), ["Newest gpu post", "Middle post", "Older claude post"]);
    eq("feed tag is the map key", picked.map(a => a.feed), ["NVIDIA", "OpenAI", "Anthropic"]);
}

// ── The cap ────────────────────────────────────────────────────────────────
{
    const many: Record<string, FeedArticle[]> = {
        A: Array.from({ length: 8 }, (_, i) => art(`a${i}`, `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`)),
        B: Array.from({ length: 8 }, (_, i) => art(`b${i}`, `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`)),
    };
    eq("defaults to 10", selectLatestArticles(many).length, 10);
    eq("honours an explicit limit", selectLatestArticles(many, 3).length, 3);
    eq("limit takes the newest, not the first feed", selectLatestArticles(many, 2).map(a => a.title), ["a7", "a6"]);
    eq("limit larger than corpus is fine", selectLatestArticles({ A: [art("solo", "2026-07-01T00:00:00Z")] }, 10).length, 1);
}

// ── Dedupe ─────────────────────────────────────────────────────────────────
{
    const sameStory = selectLatestArticles({
        OpenAI: [art("Model ships", "2026-07-30T00:00:00Z", { url: "https://openai.com/blog/model-ships" })],
        "AI News": [art("Model ships", "2026-07-29T00:00:00Z", { url: "https://openai.com/blog/model-ships?utm_source=rss" })],
    });
    eq("same url modulo utm dedupes", sameStory.length, 1);
    eq("dedupe keeps the freshest copy", sameStory[0]?.feed, "OpenAI");

    eq("trailing slash + www + case dedupe",
        selectLatestArticles({
            A: [art("x", "2026-07-30T00:00:00Z", { url: "https://www.Example.com/Post/" })],
            B: [art("x2", "2026-07-29T00:00:00Z", { url: "https://example.com/post" })],
        }).length, 1);

    eq("same title at different urls dedupes",
        selectLatestArticles({
            A: [art("Nvidia announces Rubin", "2026-07-30T00:00:00Z", { url: "https://a.com/1" })],
            B: [art("nvidia   announces rubin", "2026-07-29T00:00:00Z", { url: "https://b.com/2" })],
        }).length, 1);

    eq("distinct stories are NOT merged",
        selectLatestArticles({
            A: [art("Story one", "2026-07-30T00:00:00Z", { url: "https://a.com/1" })],
            B: [art("Story two", "2026-07-29T00:00:00Z", { url: "https://b.com/2" })],
        }).length, 2);

    // A feed that repeats an item within its own list must not eat two slots.
    eq("within-feed repeat dedupes",
        selectLatestArticles({
            A: [
                art("dupe", "2026-07-30T00:00:00Z", { url: "https://a.com/d" }),
                art("dupe", "2026-07-30T00:00:00Z", { url: "https://a.com/d" }),
                art("other", "2026-07-29T00:00:00Z", { url: "https://a.com/o" }),
            ],
        }).map(a => a.title), ["dupe", "other"]);
}

// ── Dates ──────────────────────────────────────────────────────────────────
{
    const mixed = selectLatestArticles({
        Scraped: [art("undated", undefined, { url: "https://s.com/u" })],
        Rss: [art("dated", "2026-07-30T00:00:00Z", { url: "https://r.com/d" })],
    });
    eq("undated sorts last but is kept", mixed.map(a => a.title), ["dated", "undated"]);
    eq("undated exposes null publishedMs", mixed[1]?.publishedMs, null);
    eq("dated exposes parsed ms", mixed[0]?.publishedMs, Date.parse("2026-07-30T00:00:00Z"));

    eq("unparseable date treated as undated",
        selectLatestArticles({ A: [art("junk", "not a date", { url: "https://a.com/j" })] })[0]?.publishedMs, null);

    // The client-side shape uses publishedAt; the fetcher shape uses published_at.
    eq("publishedAt alias parses",
        selectLatestArticles({ A: [{ title: "camel", url: "https://a.com/c", publishedAt: "2026-07-30T00:00:00Z" }] })[0]?.publishedMs,
        Date.parse("2026-07-30T00:00:00Z"));
}

// ── Garbage in ─────────────────────────────────────────────────────────────
{
    eq("empty map → empty list", selectLatestArticles({}), []);
    eq("undefined feed value skipped", selectLatestArticles({ A: undefined, B: [art("ok", "2026-07-30T00:00:00Z")] }).length, 1);
    eq("non-array feed value skipped", selectLatestArticles({ A: "boom" as any, B: [art("ok", "2026-07-30T00:00:00Z")] }).length, 1);
    eq("titleless article dropped",
        selectLatestArticles({ A: [{ url: "https://a.com/x", published_at: "2026-07-30T00:00:00Z" }] }).length, 0);
    eq("urlless article dropped",
        selectLatestArticles({ A: [{ title: "no url", published_at: "2026-07-30T00:00:00Z" }] }).length, 0);
    eq("malformed url still usable", selectLatestArticles({ A: [art("rel", "2026-07-30T00:00:00Z", { url: "/relative/path" })] }).length, 1);
}

// ── Passthrough of display fields ──────────────────────────────────────────
{
    const [only] = selectLatestArticles({
        NVIDIA: [art("With image", "2026-07-30T00:00:00Z", { image_url: "https://img.example/x.jpg", news_site: "Reuters" })],
    });
    eq("image_url preserved", only?.image_url, "https://img.example/x.jpg");
    eq("news_site preserved", only?.news_site, "Reuters");
}

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
