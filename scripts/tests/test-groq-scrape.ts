/**
 * Test script to verify Groq's dual-source (blog + newsroom) card extraction.
 * Simulates the custom fetchGroq() logic from company-registry.ts.
 *
 * Usage: npx tsx scripts/tests/test-groq-scrape.ts
 */

const MAX_NEWS_ARTICLES = 10;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const cardRegex = /<time\s+dateTime="([^"]+)"[^>]*>[^<]*<\/time>[\s\S]*?<img\s+src="([^"]+)"[\s\S]*?<a\s+href="(\/(blog|newsroom)\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*)"[^>]*>([^<]+)<\/a>/g;

const pages = [
    'https://groq.com/blog',
    'https://groq.com/newsroom',
];

interface Article {
    slug: string;
    url: string;
    title: string;
    date: string;
    image: string;
    source: string;
}

async function main() {
    const seen = new Set<string>();
    const allArticles: Article[] = [];

    for (const pageUrl of pages) {
        console.log(`\n🔍 Fetching: ${pageUrl}`);
        const res = await fetch(pageUrl, { headers: { 'User-Agent': UA } });

        if (!res.ok) {
            console.error(`  ❌ Failed: ${res.status} ${res.statusText}`);
            continue;
        }

        const html = await res.text();
        console.log(`  📄 ${html.length} chars of HTML`);

        const re = new RegExp(cardRegex.source, cardRegex.flags);
        let match;
        let count = 0;

        while ((match = re.exec(html)) !== null) {
            const [, dateTime, imgSrc, slug, section, title] = match;
            if (!slug || slug.length < 15) continue;
            const fullUrl = `https://groq.com${slug}`;
            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);
            count++;
            allArticles.push({
                slug,
                url: fullUrl,
                title: title.replace(/&amp;/g, '&').trim(),
                date: dateTime,
                image: imgSrc ? '✅' : '❌',
                source: section === 'blog' ? '📝 Blog' : '📰 Newsroom',
            });
        }
        console.log(`  ✅ ${count} articles extracted with dates, titles, and images`);
    }

    // Sort by date descending (same as fetchGroq)
    allArticles.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    console.log(`\n━━━ MERGED & SORTED: ${allArticles.length} total articles ━━━\n`);
    allArticles.forEach((a, i) => {
        const dateStr = new Date(a.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
        const marker = i < MAX_NEWS_ARTICLES ? '→' : ' ';
        console.log(`  ${marker} ${(i + 1).toString().padStart(2)}. [${dateStr}] ${a.source} ${a.image} ${a.title}`);
    });

    console.log(`\n🎯 Top ${MAX_NEWS_ARTICLES} most recent articles would be served (marked with →).`);
}

main().catch(console.error);
