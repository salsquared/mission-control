import { customAdapter } from './factories';
import { fetchSpaceX } from './custom-fetchers';

export default customAdapter({
    id: 'spacex',
    name: 'SpaceX',
    view: 'space',
    category: 'Prime Contractors',
    fetcher: fetchSpaceX,
    upstreamHost: 'content.spacex.com',
});
