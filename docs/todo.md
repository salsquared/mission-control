### Questions
- how to best orgnaize the db?
  - we have financial information
- what schema format does prisma use?
- how does cloudflare expose the different servers to the open internet?
- what credentials and keys do i need in order to:
  - sign into my antigravity/vscode instance through ssh so i canrun all my code on the mac but access it from my windows machine?
  - have my db talk to my backend and ftonend on the mac's local network?
  - access the frontend from my phone as a PWA?
- how can i setup a notification system function that sends emails and/or push notifications to my phone, mac or laptop?
- could i use the laptop to run a local inference server when it is on the same network as the mac-mini for summaries and local app specific queries?
  - compare latency, tok/s, effectiveness and price of gemini 3 flash with other open models such as:
    - deepseek
    - qwen
    - gemma
    - mini max
    - kimi
  - run a container specifcally for inference using WSL2 or VM on the windows laptop


### Broad To-Do:
- host prisma db on mac-mini
- host historical price data and ingestion on hte mac-mini
- host personal website on mac-mini


### Feature List:
- Research papers:
  - Have a weekly recommnended subject review paper on View page topics
  - Have a daily roundup of papers released the previous day on View page topics
  - Have a weekly roundup of papers released the previous week on View page topics
  - Keep track of what papers have been seen/read
  - Allow for favoriting/saving papers and creation of a read later list
  - Pick a historical paper on View page topic to review each week.
    - Keep a list so that we don't pick the same paper twice.
- Logs
  - Log everytime a route is called and whether it is hitting the cache, db or external api.
  - in the log keep track if its from cahce how long until the info expires and will be refetched.

### API Integrations:
- **Arxiv API**: add the ability for any of the views or cards to fetch papers
- **Hugging face & Semantic Scholar Integration**:
  - [ ] Research HF Daily Papers API (`https://huggingface.co/api/daily_papers`) & Semantic Scholar Graph API (`https://api.semanticscholar.org/graph/v1/paper/batch`).
  - [ ] Update `app/api/arxiv/route.ts` (or create new `app/api/research/route.ts`) to fetch Hugging Face papers first.
  - [ ] Extract ArXiv IDs from HF results, then batch query Semantic Scholar for `citationCount`, `authors`, and `abstract`.
  - [ ] Map combined data into unified `Paper` objects (`id`, `title`, `summary`, `url`, `author`, `published_at`, `source`, `upvotes`, `citationCount`).
  - [ ] Implement robust caching in the endpoint to avoid strict rate limits.
  - [ ] Update `ResearchPaperCard.tsx` to display `citationCount` and `upvotes` visually.
  - [ ] Update `AIView.tsx` to query new endpoints for "Top Yesterday" and "Top Last Week".
- **Social Media**: find a free way to pull in posts/comments from X, Bluesky, from established researchers and field practitioners on certain papers/products/services/blogs.
