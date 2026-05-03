// lib/companies/registry.ts — re-exports everything from the consolidated source.
// The full COMPANY_REGISTRY array + helpers live in lib/company-registry.ts while
// the migration is in progress. In a future cleanup that file will be removed and
// this one will become the canonical location.
export {
    COMPANY_REGISTRY,
    getCompanyConfig,
    getCompaniesByView,
    getCompaniesByCategory,
    getCategoriesForView,
    resolveCompanyId,
} from '../company-registry';

export { TTL_STANDARD, TTL_LOW_VOLUME, TTL_VERY_LOW } from './custom-fetchers';
export { fetchSpaceX, fetchOpenAI, fetchGroq, fetchCerebras, fetchMetaAI } from './custom-fetchers';
