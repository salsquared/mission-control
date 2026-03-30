/**
 * Test script: Validate Cerebras blog scraping strategy
 * 
 * Fetches the Cerebras blog page and tests regex extraction of
 * individual card blocks (slug, title, date, image).
 */

import * as fs from 'fs';

const html = fs.readFileSync('/tmp/cerebras_blog.html', 'utf8');

// Strategy: find each <a> ... </a> that contains href=/blog/SLUG AND a date
const aRegex = /<a[^>]*href="(\/blog\/[a-zA-Z0-9][a-zA-Z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g;

const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
const dateRe = new RegExp(`text-disabled-foreground">((?:${months})\\s+\\d{1,2},\\s+\\d{4})<\\/p>`);
const titleRe = /<(?:h2|h3)[^>]*>([\s\S]*?)<\/(?:h2|h3)>/;
const imgRe = /<img[^>]*\ssrc="([^"]+)"/;

let match;
let count = 0;
const seen = new Set<string>();

while ((match = aRegex.exec(html)) !== null) {
    const [, slug, inner] = match;
    if (seen.has(slug)) continue;

    const dateMatch = inner.match(dateRe);
    const titleMatch = inner.match(titleRe);
    if (!dateMatch || !titleMatch) continue;

    seen.add(slug);
    const imgMatch = inner.match(imgRe);

    if (count < 10) {
        console.log({
            slug,
            title: titleMatch[1].trim().substring(0, 70),
            date: dateMatch[1],
            hasImg: !!imgMatch,
            imgUrl: imgMatch ? imgMatch[1].substring(0, 80) + '...' : 'none'
        });
    }
    count++;
}
console.log(`\nTotal unique cards with dates: ${count}`);
