import { snapiAdapter } from './factories';

// CSA has RSS but SNAPI also covers them well with space-specific content.
export default snapiAdapter({
    id: 'csa',
    name: 'CSA',
    view: 'space',
    category: 'Government Agencies',
    snapiQuery: 'Canadian Space Agency',
});
