// Client-safe metadata for every company in lib/companies/. No factory or
// fetcher imports — importing this file does NOT drag undici / open-graph-
// scraper / Node-only deps into client bundles.
//
// The adapter files (lib/companies/<id>.ts) and the index barrel
// (lib/companies/index.ts) are the source of truth for fetch logic and are
// **server-only** (anything that imports them transitively pulls in the
// fetchers and their `node:*` deps). Frontend code that only needs id /
// name / view / category for UI grouping imports `COMPANIES` here instead.
//
// **Adding a company**: in addition to `lib/companies/<id>.ts` and the
// alphabetical import in `lib/companies/index.ts`, append a matching entry
// here. Keep alphabetical by id.

export interface CompanyMeta {
    id: string;
    name: string;
    view: 'space' | 'ai' | 'both';
    category: string;
}

export const COMPANIES: CompanyMeta[] = [
    // ─── Space ─────────────────────────────────────────────────────────────
    { id: 'aerojet-rocketdyne', name: 'Aerojet Rocketdyne', view: 'space', category: 'Space Hardware' },
    { id: 'apex',               name: 'Apex Space',         view: 'space', category: 'Space Hardware' },
    { id: 'arianegroup',        name: 'ArianeGroup',        view: 'space', category: 'Prime Contractors' },
    { id: 'blue-canyon',        name: 'Blue Canyon Technologies', view: 'space', category: 'Space Hardware' },
    { id: 'blue-origin',        name: 'Blue Origin',        view: 'space', category: 'Prime Contractors' },
    { id: 'boeing',             name: 'Boeing',             view: 'space', category: 'Prime Contractors' },
    { id: 'cnsa',               name: 'CNSA',               view: 'space', category: 'Government Agencies' },
    { id: 'csa',                name: 'CSA',                view: 'space', category: 'Government Agencies' },
    { id: 'esa',                name: 'ESA',                view: 'space', category: 'Government Agencies' },
    { id: 'firefly',            name: 'Firefly Aerospace',  view: 'space', category: 'Upstart Launch Providers' },
    { id: 'hadrian',            name: 'Hadrian',            view: 'space', category: 'Space Hardware' },
    { id: 'isro',               name: 'ISRO',               view: 'space', category: 'Government Agencies' },
    { id: 'jaxa',               name: 'JAXA',               view: 'space', category: 'Government Agencies' },
    { id: 'lockheed-martin',    name: 'Lockheed Martin',    view: 'space', category: 'Prime Contractors' },
    { id: 'nasa',               name: 'NASA',               view: 'space', category: 'Government Agencies' },
    { id: 'northrop-grumman',   name: 'Northrop Grumman',   view: 'space', category: 'Prime Contractors' },
    { id: 'redwire',            name: 'Redwire',            view: 'space', category: 'Space Hardware' },
    { id: 'relativity',         name: 'Relativity Space',   view: 'space', category: 'Upstart Launch Providers' },
    { id: 'rfa',                name: 'Rocket Factory Augsburg', view: 'space', category: 'Upstart Launch Providers' },
    { id: 'rocketlab',          name: 'Rocket Lab',         view: 'space', category: 'Prime Contractors' },
    { id: 'roscosmos',          name: 'Roscosmos',          view: 'space', category: 'Government Agencies' },
    { id: 'spacex',             name: 'SpaceX',             view: 'space', category: 'Prime Contractors' },
    { id: 'stoke',              name: 'Stoke Space',        view: 'space', category: 'Upstart Launch Providers' },
    { id: 'ula',                name: 'ULA',                view: 'space', category: 'Prime Contractors' },
    { id: 'ursa-major',         name: 'Ursa Major',         view: 'space', category: 'Space Hardware' },
    { id: 'xona',               name: 'Xona Space Systems', view: 'space', category: 'Space Hardware' },

    // ─── AI ────────────────────────────────────────────────────────────────
    { id: 'amd',                name: 'AMD',                view: 'ai',    category: 'Fabless' },
    { id: 'anthropic',          name: 'Anthropic',          view: 'ai',    category: 'AI Model Developers' },
    { id: 'apple',              name: 'Apple ML',           view: 'ai',    category: 'Fabless' },
    { id: 'arm',                name: 'ARM',                view: 'ai',    category: 'IP/Architecture' },
    { id: 'baidu',              name: 'Baidu AI',           view: 'ai',    category: 'AI Model Developers' },
    { id: 'broadcom',           name: 'Broadcom',           view: 'ai',    category: 'Fabless' },
    { id: 'bytedance',          name: 'ByteDance',          view: 'ai',    category: 'AI Model Developers' },
    { id: 'cerebras',           name: 'Cerebras',           view: 'ai',    category: 'AI Accelerators' },
    { id: 'deepmind',           name: 'Google DeepMind',    view: 'ai',    category: 'AI Model Developers' },
    { id: 'deepseek',           name: 'Deepseek',           view: 'ai',    category: 'AI Model Developers' },
    { id: 'globalfoundries',    name: 'GlobalFoundries',    view: 'ai',    category: 'Foundries' },
    { id: 'google-ai',          name: 'Google AI',          view: 'ai',    category: 'Fabless' },
    { id: 'groq',               name: 'Groq',               view: 'ai',    category: 'AI Accelerators' },
    { id: 'huggingface',        name: 'Hugging Face',       view: 'ai',    category: 'AI Model Developers' },
    { id: 'intel',              name: 'Intel',              view: 'ai',    category: 'Fabless' },
    { id: 'intel-foundry',      name: 'Intel Foundry',      view: 'ai',    category: 'Foundries' },
    { id: 'meta',               name: 'Meta AI',            view: 'ai',    category: 'AI Model Developers' },
    { id: 'micron',             name: 'Micron',             view: 'ai',    category: 'Foundries' },
    { id: 'microsoft',          name: 'Microsoft AI',       view: 'ai',    category: 'AI Model Developers' },
    { id: 'mistral',            name: 'Mistral',            view: 'ai',    category: 'AI Model Developers' },
    { id: 'nvidia',             name: 'Nvidia AI',          view: 'ai',    category: 'Fabless' },
    { id: 'openai',             name: 'OpenAI',             view: 'ai',    category: 'AI Model Developers' },
    { id: 'qualcomm',           name: 'Qualcomm',           view: 'ai',    category: 'Fabless' },
    { id: 'samsung-foundries',  name: 'Samsung Foundries',  view: 'ai',    category: 'Foundries' },
    { id: 'semianalysis',       name: 'SemiAnalysis',       view: 'ai',    category: 'News Sources' },
    { id: 'smic',               name: 'SMIC',               view: 'ai',    category: 'Foundries' },
    { id: 'tsmc',               name: 'TSMC',               view: 'ai',    category: 'Foundries' },
    { id: 'umc',                name: 'UMC',                view: 'ai',    category: 'Foundries' },
    { id: 'xai',                name: 'xAI',                view: 'ai',    category: 'AI Model Developers' },
];

export function getCompaniesByView(view: 'space' | 'ai'): CompanyMeta[] {
    return COMPANIES.filter(c => c.view === view || c.view === 'both');
}

export function getCategoriesForView(view: 'space' | 'ai'): string[] {
    return [...new Set(getCompaniesByView(view).map(c => c.category))];
}
