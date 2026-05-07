import { snapiAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default snapiAdapter({
    id: 'aerojet-rocketdyne',
    name: 'Aerojet Rocketdyne',
    view: 'space',
    category: 'Space Hardware',
    snapiQuery: 'Rocketdyne',
    ttlSeconds: TTL_LOW_VOLUME,
});
