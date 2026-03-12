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

### Personal To-Do
- [ ] Read up on pm2
  - [ ] Investigate whether pm2 or some other utility to prevent mac-mini software shutdown when specific services (like pulsar, personal website server or mission control are running)
 
### Feature Fixes
- Mission Control App
  - [ ] Fix issue where app was starting up but wouldnt load localhost; could be b/c ipv4 is used by node but chrome expects ipv6 (?)
    - [ ] Get to reason of this error and document it
  - [ ] Fix issue where externaly dependent apis arent loading; could it be that we are not exporting .env as we are when running dev through next js dev script
    - [ ] Get reason to why and document it
  - [ ] Fix issue where we dont get dark scroll bars in the chrome app as we do in safari in dev mode
    - [ ] Get reason to why and document it; my guess is that its bc the default scroll color uses a diff config on safari than on chrome
  - [ ] Find a way to make the API calls/card assets displaying data coming in async so they either pop in as soon as the payload comes back OR have the entire view show a loading wheel/graphic while all assets load in; pick which ever looks best

### New Feature List:
- [ ] Experiment with standard col width of having either p/3, p/4 or p/5 where p is the width of the page or available space for items
- [ ] Add youtube features
  - [ ] Make youtube card
  - [ ] Filter through new suggested videos and subscription videos into one auto-scrolling carousel based on subject/view
    - [ ] Create whitelist of channels for each view to make sure that their new videos are always shown. eg: Physics View/ Sabine Hossenfelder, PBS Space Time, Veritasium, etc.
- [ ] Set the "npm run start" script to setup startup logs in the first 1m after the app starts up to better diagnose prod issues
  - [ ] Use UNIX time to name logs that save to a new log folder; these are not build logs but startup logs. (Would this be written in bash or node process?)
- [ ] Create cards for research papers that filter through view sub-subjects. eg: Physics View - Quantum Physics, Particle Physics, Astrophysics, etc.
- [ ] Once prod server is fixed, broadcase the server on the local network and make it mobile-compatible so I can access it on my phone
- [ ] Integrate local LLM calls w/ Gemma 3.


### Completed Items:
- **Research papers**:
  - **Weekly recommended subject review paper**:
    - [x] Create scheduled task or API endpoint to query for highly cited review/survey papers matching current View topics.
    - [x] Add a UI card/section in Views to highlight the weekly targeted review paper.
  - **Daily roundup of newly released papers**:
    - [x] Create an API endpoint to fetch papers published within the last 24 hours matching specific view keywords.
    - [x] Use existing `ResearchPaperCard.tsx` component to list these papers (pass custom title and API endpoint).
    - [x] Implement caching to avoid querying external APIs on every page load.
  - **Weekly roundup of recently released papers**:
    - [x] Create an API endpoint to fetch top papers published within the last 7 days.
    - [x] Use existing `ResearchPaperCard.tsx` component highlighting top trending papers (pass custom title and API endpoint).
  - **Track seen/read papers**:
    - [x] Update Prisma schema: add a tracking model with fields for `paperId`, `readStatus`, and `viewedAt`.
    - [x] Implement an API route (`POST /api/research/track`) to log paper views from the UI.
    - [x] Update paper card components to visually indicate if a paper has already been read.
  - **Favoriting/saving papers (Read Later list)**:
    - [x] Update Prisma schema to support user `ReadingLists` and `SavedPapers`.
    - [x] Add a "Save for later" or "Favorite" button to research paper cards.
    - [x] Create a dedicated "Reading List" View or modal to browse saved papers.
  - **Historical paper of the week**:
    - [x] Create an algorithm to find impactful historical papers (e.g., > 5 years old, high citations) for specific View topics.
    - [x] Create a DB table/log of selected historical papers to prevent duplicate recommendations.
    - [x] Add a UI element to feature the "Historical Paper of the Week".
  - **Add papers manually via DOI/links**:
    - [x] Create an input modal to accept DOI numbers or paper URLs.
    - [x] Implement a backend API route to parse the DOI/URL and fetch paper metadata (e.g., via Crossref or Semantic Scholar API).
    - [x] Build a selection prompt to ask the user which View/reading list to add the paper to, including an option to create a new one.
    - [x] Setup a "Physics" View to track physics science news and papers, and save the fetched paper there.
- **Logs**:
  - **Route Request Logging**:
    - [x] Create a centralized logging utility module (e.g., `utils/logger.ts`).
    - [x] Update all API routes to log incoming requests (method, endpoint, timestamps).
    - [x] Add logging to distinguish the data source: DB, external API, or Cache.
  - **Cache Analytics**:
    - [x] Enhance generic caching layers to attach TTL (Time-To-Live) and expiration details to the log payload.
    - [x] Build a dashboard View or terminal output that visuals cache hit rates and remaining TTLs for cached data.

### API Integrations (Completed):
- **Arxiv API**: add the ability for any of the views or cards to fetch papers
- **Hugging face & Semantic Scholar Integration**:
  - [x] Research HF Daily Papers API (`https://huggingface.co/api/daily_papers`) & Semantic Scholar Graph API (`https://api.semanticscholar.org/graph/v1/paper/batch`).
  - [x] Update `app/api/arxiv/route.ts` (or create new `app/api/research/route.ts`) to fetch Hugging Face papers first.
  - [x] Extract ArXiv IDs from HF results, then batch query Semantic Scholar for `citationCount`, `authors`, and `abstract`.
  - [x] Map combined data into unified `Paper` objects (`id`, `title`, `summary`, `url`, `author`, `published_at`, `source`, `upvotes`, `citationCount`).
  - [x] Implement robust caching in the endpoint to avoid strict rate limits.
  - [x] Update `ResearchPaperCard.tsx` to display `citationCount` and `upvotes` visually.
  - [x] Update `AIView.tsx` to query new endpoints for "Top Yesterday" and "Top Last Week".
