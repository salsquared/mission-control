### Feature Fixes
<br>

---

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
- [ ] Add a new view for monitoring Github project progress.
  - [ ] Create todo list utility that shows the todo list from the project files.
    - [ ] Should be able to edit, add, delete todo items from a markdown file in the repo itself

- [ ] Create card that shows the background services running on the mac-mini using pm2 or some other service monitoring utility. Not the internal services that are for MS but the ones that it connects to like pulsar, personal website, etc.
  - [ ] Show the stats like:
    - [ ] CPU Usage
    - [ ] Memory Usage
    - [ ] Uptime

- [ ] Create a new view that shows and keeps track of job/internship/citizenship/school and other kinds of applications and their status.
  - [ ] Connect to Gmail and Gcal to get updates when new emails come in
    - [ ] **Integration Plan:**
      - **OAuth 2.0:** Set up a Google Cloud Project with Gmail API and Google Calendar API scopes. Use `next-auth` to easily authenticate and store the refresh token securely in Prisma without a custom dashboard.
      - **Gmail Syncing Strategy:** Use Cloudflare Tunnels (via `salsquared.xyz`) and Google Cloud Pub/Sub to receive live webhook push notifications. This provides a real-time sync while heavily conserving RAM and CPU on the Mac Mini compared to polling.
      - **Data Parsing:** Use an LLM or standard regex parser to extract application status updates, interview details, and next steps from incoming emails.
      - **Dashboard DB:** Store parsed application instances (Company/Institution, Status, Next Steps, Dates) in our internal db.
  - [ ] Create events in Gcal from emails for appointments,interviews, etc.
    - [ ] **Automation Plan:**
      - Expose a Next.js API route that the background worker or UI can hit to construct and push a Google Calendar event.
      - Auto-fill event details (title, description with email link, start/end time) based on the parsed email contents.

<br>

---

### Completed Items:
- **Mission Control App**:
  - **Internal Systems View**:
    - [x] Add feature that changes the display of ram allocated to the service based on the input variable we give in @package.json
      - Ex: For dev we give it 2GB but in prod mode its only 1GB.
  - **UI Design / CSS**:
    - [x] Add an edit button to the top right corner of the launchpad overlay that allows you to edit the order and name views.
      - [x] Allow view name change only when the editing option is active
      - [x] Add the three dots handle to move and drag the views around. 
    - [x] Add semi-live previews of the views in the launchpad overlay
    - [x] Fix issue where we dont get dark scroll bars in the chrome app as we do in safari in dev mode.
      - [x] **Root Cause & Fix**: Chrome and Safari have different default OS heuristics for rendering scrollbars even in a dark UI. We fixed this by strictly declaring `color-scheme: dark;` in `:root` and adding explicit `::-webkit-scrollbar` pseudo-element classes in `globals.css` to enforce a unified dark, glass-like scroll track layer across all Webkit-based browsers.
    - [x] Add a new dynamically rendered color toggle in internal views for new views.
      - [x] **Implementation**: Modified `InternalView.tsx` to construct color toggles by deriving the list directly from `dashOrder` and `defaultDashTitles` state, so new views automatically populate without touching UI code. Swapped browser `localStorage` persist middleware to a Prisma database table for `GlobalSettings`, making customizations persistent across distinct client devices.
    - [x] Fix how laggy the view tiles are when moving them around in the edit mode using the handles to drag them.
    - [x] Fix issue where view order is not saved and defaults to the original.
  - **Backend / Launch Script**:
  - [x] Fix issue where app was starting up but wouldnt load localhost; could be b/c ipv4 is used by node but chrome expects ipv6 (?)
    - [x] **Root Cause & Fix**: Node 17+ defaults to binding `localhost` to IPv6 (`::1`), while hardcoding `127.0.0.1` inside the launch script forces Chrome to strictly look for IPv4. By switching the launch script to call `http://localhost:$PORT`, Chrome resolves IPv6/IPv4 natively.
  - [x] Fix issue where externaly dependent apis arent loading; could it be that we are not exporting .env as we are when running dev through next js dev script
    - [x] **Root Cause & Fix**: In standalone bash script execution for production (`next start`), environment variables from `.env` are sometimes not loaded into `process.env` automatically as they are via `next dev`. We solved this by explicitly sourcing the variables using `set -a` and `source .env` directly in `launch-ms.sh` prior to starting the process.
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
