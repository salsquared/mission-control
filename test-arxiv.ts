import Parser from 'rss-parser';

const parser = new Parser({
    customFields: {
        item: ['summary', 'author', 'dc:creator', 'content']
    }
});

async function run() {
    try {
        const feed = await parser.parseURL('http://export.arxiv.org/api/query?search_query=all:electron&start=0&max_results=1');
        console.log(JSON.stringify(feed, null, 2));
    } catch (e) {
        console.error(e);
    }
}
run();
