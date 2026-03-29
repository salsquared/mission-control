import Parser from 'rss-parser';

const parser = new Parser();

async function testRSS(url: string) {
    try {
        const feed = await parser.parseURL(url);
        console.log(`\n✅ Success for ${url}`);
        console.log(`Title: ${feed.title}`);
        if (feed.items.length > 0) {
            console.log(`First item: ${feed.items[0]?.title}`);
            console.log(`Link: ${feed.items[0]?.link}`);
            // Check for image enclosure or within content
            let image = feed.items[0]?.enclosure?.url;
            if (!image) {
                const content = feed.items[0]?.['content:encoded'] || feed.items[0]?.content || '';
                const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
                if (imgMatch) image = imgMatch[1];
            }
            console.log(`Image: ${image || 'no image'}`);
        } else {
            console.log(`0 items found in feed.`);
        }
    } catch (e: any) {
        console.error(`\n❌ Failed for ${url}: ${e.message}`);
    }
}

async function main() {
    await testRSS('https://deepmind.google/blog/rss.xml');
    await testRSS('https://ai.meta.com/blog/rss/');
    await testRSS('https://blogs.microsoft.com/ai/feed/');
    await testRSS('https://blogs.nvidia.com/feed/');
    await testRSS('https://blogs.nvidia.com/category/artificial-intelligence/feed/');
}

main();
