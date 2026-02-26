import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';
import Parser from 'rss-parser';

const parser = new Parser({
    customFields: {
        item: ['summary', 'author', 'dc:creator', 'content', 'id']
    }
});

async function getHandler(request: Request) {
    try {
        const { searchParams } = new URL(request.url);

        let searchQueryParts: string[] = [];

        // Parameter parsing
        const subject = searchParams.get('subject'); // e.g. cs.AI
        if (subject) {
            searchQueryParts.push(`cat:${subject}`);
        }

        const all = searchParams.get('all'); // Search all fields
        if (all) {
            // Encode the string and escape spaces if needed, but arxiv expects + for spaces in url
            // URL encoding handles spaces as %20, which is also generally fine, but we'll try to stick to arxiv's format if it's strictly +
            searchQueryParts.push(`all:${encodeURIComponent(all)}`);
        }

        const author = searchParams.get('author');
        if (author) {
            searchQueryParts.push(`au:${encodeURIComponent(author)}`);
        }

        const title = searchParams.get('title');
        if (title) {
            searchQueryParts.push(`ti:${encodeURIComponent(title)}`);
        }

        // Time window format for arXiv: submittedDate:[YYYYMMDDTTTT+TO+YYYYMMDDTTTT]
        // Allow passing dateFrom and dateTo as YYYYMMDDHHMM (24-hour time to the minute in GMT)
        const dateFrom = searchParams.get('dateFrom');
        const dateTo = searchParams.get('dateTo');
        if (dateFrom && dateTo) {
            searchQueryParts.push(`submittedDate:[${dateFrom}+TO+${dateTo}]`);
        }

        const maxResults = searchParams.get('max_results') || '10';
        const start = searchParams.get('start') || '0';

        // sorting params: sortBy can be "relevance", "lastUpdatedDate", "submittedDate"
        // sortOrder can be "ascending", "descending"
        const sortBy = searchParams.get('sortBy') || 'submittedDate';
        const sortOrder = searchParams.get('sortOrder') || 'descending';

        // If no query parameters are provided, fallback to a general subject (e.g., Computer Science AI)
        const searchQuery = searchQueryParts.length > 0 ? searchQueryParts.join('+AND+') : 'cat:cs.AI';

        // Construct the final URL
        const arxivUrl = `http://export.arxiv.org/api/query?search_query=${searchQuery}&start=${start}&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

        console.log("Fetching arXiv data from:", arxivUrl);

        const feed = await parser.parseURL(arxivUrl);

        const articles = feed.items.map(item => ({
            id: item.id || item.link || Math.random().toString(),
            title: item.title?.replace(/\n/g, ' ').replace(/\s+/g, ' ') || "arXiv Paper",
            summary: item.summary?.replace(/\n/g, ' ').trim() || "",
            url: item.link || "",
            author: item.author || item['dc:creator'] || 'Unknown',
            published_at: item.isoDate || item.pubDate || new Date().toISOString(),
            source: 'arXiv'
        }));

        return NextResponse.json(articles);
    } catch (error) {
        console.error(`Error fetching arXiv papers:`, error);
        return NextResponse.json({ error: 'Failed to fetch arXiv papers' }, { status: 500 });
    }
}

// Cache results for 1 hour to prevent hitting arXiv API rate limits
export const GET = withCache(getHandler, 3600);
