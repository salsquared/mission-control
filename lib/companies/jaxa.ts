import { snapiAdapter } from './factories';

// JAXA English press page exists but no RSS. SNAPI coverage is decent.
export default snapiAdapter({
    id: 'jaxa',
    name: 'JAXA',
    view: 'space',
    category: 'Government Agencies',
    snapiQuery: 'JAXA',
});
