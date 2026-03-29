import * as cheerio from 'cheerio';

async function testMetaScraping() {
    console.log("Fetching Meta AI Blog...");
    const res = await fetch('https://ai.meta.com/blog/');
    const html = await res.text();
    const $ = cheerio.load(html);
    
    const articles: any[] = [];
    
    // We need to find the links to the blog posts.
    // Usually they are under certain classes or just checking links that start with /blog/ and don't equal /blog/
    $('a[href^="/blog/"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href !== '/blog/' && href !== '/blog') {
            const title = $(el).text().trim();
            if (title && title.length > 10 && !title.includes('FEATURED')) {
                // Deduplicate
                if (!articles.find(a => a.url === `https://ai.meta.com${href}`)) {
                    articles.push({
                        title,
                        url: `https://ai.meta.com${href}`
                    });
                }
            }
        }
    });

    console.log(`Found ${articles.length} articles.`);
    console.log(articles.slice(0, 5));
}

testMetaScraping();
