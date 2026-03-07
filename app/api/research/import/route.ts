import { NextResponse } from 'next/server';
import Parser from 'rss-parser';

const parser = new Parser({
    customFields: {
        item: ['summary', 'author', 'dc:creator', 'content', 'id']
    }
});

// Helper to extract a usable ID or URL from the input
function parseInput(input: string): { type: 'arxiv' | 'doi' | 'url' | 'unknown', value: string } {
    let cleanInput = input.trim();

    // Remove HTTP prefix if it's just meant to be a DOI link
    if (cleanInput.startsWith('https://doi.org/') || cleanInput.startsWith('http://doi.org/')) {
        cleanInput = cleanInput.replace(/^https?:\/\/doi\.org\//, '');
    }

    // 1. ArXiv URL or ID
    // Supports formats like: https://arxiv.org/abs/1706.03762v5, 1706.03762, arxiv:1706.03762
    const arxivMatch = cleanInput.match(/(?:arxiv\.org\/abs\/|arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (arxivMatch) {
        return { type: 'arxiv', value: arxivMatch[1].replace(/v\d+$/, '') }; // Strip version for lookup
    }

    // 2. DOI
    // Basic DOI regex
    const doiMatch = cleanInput.match(/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
    if (doiMatch) {
        return { type: 'doi', value: doiMatch[1] };
    }

    // 3. Generic URL
    if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
        return { type: 'url', value: cleanInput };
    }

    return { type: 'unknown', value: cleanInput };
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { input } = body;

        if (!input) {
            return NextResponse.json({ error: "Missing input field" }, { status: 400 });
        }

        const parsed = parseInput(input);

        let ssQueryId = "";
        let paperIdFallback = "";

        if (parsed.type === 'arxiv') {
            ssQueryId = `ARXIV:${parsed.value}`;
            paperIdFallback = parsed.value;
        } else if (parsed.type === 'doi') {
            ssQueryId = `DOI:${parsed.value}`;
        } else if (parsed.type === 'url') {
            ssQueryId = `URL:${parsed.value}`;
        } else {
            return NextResponse.json({ error: "Unrecognized format. Please provide a DOI, ArXiv ID, or full paper URL." }, { status: 400 });
        }

        let paperMetadata: any = null;

        // Try Semantic Scholar first for comprehensive metadata
        console.info(`[EXTERNAL API] Fetching from Semantic Scholar for ${ssQueryId}`);
        const ssRes = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${ssQueryId}?fields=title,authors,abstract,citationCount,year,url,externalIds`, {
            cache: 'no-store'
        });

        if (ssRes.ok) {
            const ssData = await ssRes.json();

            // Extract ArXiv ID if available from Semantic Scholar
            let paperId = ssData.externalIds?.ArXiv || paperIdFallback;
            if (!paperId) {
                if (ssData.externalIds?.DOI) paperId = `DOI:${ssData.externalIds.DOI}`;
                else if (parsed.type === 'doi') paperId = `DOI:${parsed.value}`;
                else paperId = `SS:${ssData.paperId}`;
            }

            paperMetadata = {
                id: ssData.paperId,
                title: ssData.title,
                summary: ssData.abstract || "No abstract available.",
                url: ssData.url || (ssData.externalIds?.ArXiv ? `https://arxiv.org/abs/${ssData.externalIds.ArXiv}` : ""),
                author: ssData.authors?.length > 0 ? ssData.authors.map((a: any) => a.name).join(', ') : "Unknown",
                published_at: ssData.year ? new Date(ssData.year, 0, 1).toISOString() : new Date().toISOString(), // Fallback if no exact date
                source: "Semantic Scholar",
                paperId: paperId,
                citationCount: ssData.citationCount || 0
            };
        }

        // Fallback to ArXiv API if Semantic Scholar failed OR if it didn't return an abstract for an ArXiv paper
        if ((!ssRes.ok || !paperMetadata?.summary || paperMetadata.summary === "No abstract available.") && paperIdFallback) {
            console.info(`[EXTERNAL API] Fetching fallback from arXiv for ${paperIdFallback}`);
            try {
                const arxivApiUrl = `http://export.arxiv.org/api/query?id_list=${paperIdFallback}`;
                const feed = await parser.parseURL(arxivApiUrl);

                if (feed.items && feed.items.length > 0) {
                    const item = feed.items[0];
                    const rawId = item.id || item.link || "";
                    const arxivId = (rawId.split('/abs/')[1] || rawId).replace(/v\d+$/, '');

                    paperMetadata = {
                        id: rawId,
                        title: item.title?.replace(/\n/g, ' ').replace(/\s+/g, ' ') || paperMetadata?.title || "arXiv Paper",
                        summary: item.summary?.replace(/\n/g, ' ').trim() || paperMetadata?.summary || "",
                        url: item.link || paperMetadata?.url || `https://arxiv.org/abs/${arxivId}`,
                        author: item.author || item['dc:creator'] || paperMetadata?.author || 'Unknown',
                        published_at: item.isoDate || item.pubDate || paperMetadata?.published_at || new Date().toISOString(),
                        source: 'arXiv',
                        paperId: arxivId,
                        // Preserve citation count from SS if we had it, even if abstract was missing
                        citationCount: paperMetadata?.citationCount || 0
                    };
                }
            } catch (arxivErr) {
                console.error("Error fetching arxiv fallback:", arxivErr);
            }
        }

        if (!paperMetadata) {
            console.warn(`Failed to fetch metadata for ${input}`);

            if (!ssRes.ok) {
                const ssErr = await ssRes.text().catch(() => "");
                console.error("Semantic Scholar Error:", ssRes.status, ssErr);
            }

            return NextResponse.json({ error: "Failed to fetch paper metadata. It might not be indexed or the provided link is unsupported." }, { status: 404 });
        }

        return NextResponse.json(paperMetadata);

    } catch (error) {
        console.error("Error processing paper import:", error);
        return NextResponse.json({ error: "Internal server error while importing paper" }, { status: 500 });
    }
}
