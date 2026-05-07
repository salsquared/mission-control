import { rssAdapter } from './factories';

export default rssAdapter({
    id: 'huggingface',
    name: 'Hugging Face',
    view: 'ai',
    category: 'AI Model Developers',
    rssUrl: 'https://huggingface.co/blog/feed.xml',
});
