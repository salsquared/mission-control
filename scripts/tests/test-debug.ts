import ogs from 'open-graph-scraper';
import Parser from 'rss-parser';

async function testFetchMeta() {
    console.info('[EXTERNAL API] Fetching from Meta AI News...');
    const res = await fetch('https://ai.meta.com/blog/');
    const html = await res.text();

    const articleRegex = /href="(?:https:\/\/ai\.meta\.com)?(\/blog\/[a-zA-Z0-9-]+\/?)"/g;
    let match;
    const articles: any[] = [];

    while ((match = articleRegex.exec(html)) !== null) {
        const slug = match[1];
        if (slug === '/blog/' || slug === '/blog') continue; // skip main blog link

        const url = `https://ai.meta.com${slug}`;
        if (!articles.find(a => a.url === url)) {
            articles.push({
                url
            });
        }
    }
    console.log("META AI ARTICLES FOUND:", articles.length);
    if(articles.length > 0) {
        console.log("First meta article:", articles[0]);
    }
}

async function testOGSOnGeneric() {
    console.info('[EXTERNAL API] Fetching Generic RSS from: https://deepmind.google/blog/rss.xml');
    const parser = new Parser();
    const feed = await parser.parseURL('https://deepmind.google/blog/rss.xml');
    const items = feed.items.slice(0, 1);
    
    for (const item of items) {
        const url = item.link || "";
        console.log(`Testing OGS on Deepmind URL: ${url}`);
        try {
            const { result } = await ogs({ url, timeout: 4000 });
            console.log("OGS Result Image:", result.ogImage?.[0]?.url);
        } catch(e: any) {
            console.error("OGS Failed", e.message);
        }
    }
}

async function main() {
    await testFetchMeta();
    await testOGSOnGeneric();
}

main();
