import { snapiAdapter } from './factories';

// Note: LM has RSS at lockheedmartin.com/news/rss.html but covers all divisions.
// SNAPI filters to space-relevant coverage. Could swap to RSS with keyword filtering later.
export default snapiAdapter({
    id: 'lockheed-martin',
    name: 'Lockheed Martin',
    view: 'space',
    category: 'Prime Contractors',
    snapiQuery: 'Lockheed Martin',
});
