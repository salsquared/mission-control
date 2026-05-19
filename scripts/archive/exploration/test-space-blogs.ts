import { load } from 'cheerio';

async function testSpacexApi() {
    console.log("Testing SpaceX API...");
    try {
        const res = await fetch('https://content.spacex.com/api/spacex-website/updates');
        const data = await res.json();
        console.log("SpaceX API length:", data.length);
        console.log("SpaceX API sample:", data.slice(0, 2).map((i: any) => ({ title: i.title, id: i.updateId, date: i.date })));
    } catch (e) {
        console.error("SpaceX API failed:", e);
    }
}

async function testBlueOriginFetch() {
    console.log("Testing Blue Origin Fetch with headers...");
    try {
        const res = await fetch("https://www.blueorigin.com/news", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Cache-Control": "max-age=0",
                "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                "Sec-Ch-Ua-Mobile": "?0",
                "Sec-Ch-Ua-Platform": '"macOS"',
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
                "Upgrade-Insecure-Requests": "1"
            }
        });
        const html = await res.text();
        if (html.includes("Vercel Security Checkpoint")) {
            console.log("Blue Origin blocked by Vercel!");
        } else {
            console.log("Blue Origin fetched successfully! Length:", html.length);
            const matches = [...html.matchAll(/href="(\/news\/([^"]+))"/g)];
            const unique = [...new Set(matches.map(m => m[1]))];
            console.log("Blue Origin news links:", unique.slice(0, 5));
        }
    } catch (e) {
        console.error("Blue Origin fetch failed:", e);
    }
}

async function run() {
    await testSpacexApi();
    await testBlueOriginFetch();
}

run().catch(console.error);
