export class ScraperBrokenError extends Error {
    constructor(public source: string, public sampleLength: number) {
        super(`[SCRAPER BROKEN] ${source} returned 0 items (sample HTML length: ${sampleLength})`);
        this.name = 'ScraperBrokenError';
    }
}
