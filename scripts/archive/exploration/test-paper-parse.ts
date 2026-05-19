import { parse } from 'url';

// Run with npx ts-node, testing the parsing locally

function parseInput(input: string): { type: 'arxiv' | 'doi' | 'url' | 'unknown', value: string } {
    let cleanInput = input.trim();
    if (cleanInput.startsWith('https://doi.org/') || cleanInput.startsWith('http://doi.org/')) {
        cleanInput = cleanInput.replace(/^https?:\/\/doi\.org\//, '');
    }
    const arxivMatch = cleanInput.match(/(?:arxiv\.org\/abs\/|arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (arxivMatch) {
        return { type: 'arxiv', value: arxivMatch[1].replace(/v\d+$/, '') };
    }
    const doiMatch = cleanInput.match(/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
    if (doiMatch) {
        return { type: 'doi', value: doiMatch[1] };
    }
    if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
        return { type: 'url', value: cleanInput };
    }
    return { type: 'unknown', value: cleanInput };
}

console.log("TESTING PARSING");
console.log(parseInput("https://arxiv.org/abs/1706.03762"));
console.log(parseInput("1706.03762v5"));
console.log(parseInput("10.1038/nphys1170"));
console.log(parseInput("https://doi.org/10.1038/nphys1170"));
console.log(parseInput("https://example.com/some/paper"));
