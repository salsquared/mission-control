import { parseStringPromise } from 'xml2js'; // Will try to parse xml or just use regex

async function checkSitemap(name: string, url: string) {
    console.log(`Checking ${name} sitemap at ${url}...`);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await res.text();
        const urls = [...text.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
        console.log(`${name} total URLs:`, urls.length);
        
        // Filter for news/updates
        let newsUrls = urls.filter(u => u.includes('/updates/') || u.includes('/news/'));
        if (name === 'SpaceX') {
            newsUrls = urls.filter(u => u.includes('/updates'));
        } else if (name === 'Blue Origin') {
            newsUrls = urls.filter(u => u.includes('/news'));
        }
        
        console.log(`${name} news URLs (first 5):`, newsUrls.slice(0, 5));
    } catch (e) {
        console.error(`${name} failed:`, e);
    }
}

async function run() {
    await checkSitemap('SpaceX', 'https://www.spacex.com/sitemap.xml');
    await checkSitemap('Blue Origin', 'https://www.blueorigin.com/sitemap.xml');
    await checkSitemap('RocketLab', 'https://www.rocketlabusa.com/sitemap.xml');
}

run().catch(console.error);
