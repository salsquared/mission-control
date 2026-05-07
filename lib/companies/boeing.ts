import { snapiAdapter } from './factories';

// Note: Boeing does have a MediaRoom RSS but it covers ALL divisions not just space.
// SNAPI filters to space-relevant coverage automatically.
export default snapiAdapter({
    id: 'boeing',
    name: 'Boeing',
    view: 'space',
    category: 'Prime Contractors',
    snapiQuery: 'Boeing',
});
