import { snapiAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default snapiAdapter({
    id: 'relativity',
    name: 'Relativity Space',
    view: 'space',
    category: 'Upstart Launch Providers',
    snapiQuery: 'Relativity Space',
    ttlSeconds: TTL_LOW_VOLUME,
});
