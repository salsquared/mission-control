/**
 * Fetcher barrel export — re-exports all fetcher functions and types.
 */

export type { NewsArticle, FetchStrategy, CompanyFeedConfig } from './types';
export { fetchRSS } from './rss-fetcher';
export { fetchScrape } from './scrape-fetcher';
export { fetchSNAPI } from './snapi-fetcher';
export { fetchGoogleNews } from './google-news-fetcher';
