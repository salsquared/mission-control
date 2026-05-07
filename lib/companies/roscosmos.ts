import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

// TODO: Add translation layer
export default googleNewsAdapter({
    id: 'roscosmos',
    name: 'Roscosmos',
    view: 'space',
    category: 'Government Agencies',
    googleNewsQuery: 'Roscosmos',
    ttlSeconds: TTL_LOW_VOLUME,
});
