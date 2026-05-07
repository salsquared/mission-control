import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

// TODO: Add translation layer
export default googleNewsAdapter({
    id: 'cnsa',
    name: 'CNSA',
    view: 'space',
    category: 'Government Agencies',
    googleNewsQuery: 'CNSA China space',
    ttlSeconds: TTL_LOW_VOLUME,
});
