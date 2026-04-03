# Mission Control TODO
### Priority Legend (Copy & Paste)
- [ ] 🔴 **Blocker** / Critical
- [ ] 🟡 **High** Priority / First Order
- [ ] 🔵 **Medium** Priority
- [ ] 🟢 **Low** Priority / Backlog


## Feature Fixes
### Company News API
- [x] 🔵 **Medium** - Fix issue where meta ai news is not showing up at all.
- [ ] 🔵 **Medium** - Fix issue where deepmind, meta, microsoft and nvidia images arent showing.
- [ ] 🔵 **Medium** - Get rid of Hackernews in the AI company feed. 
  - [ ] Create a new section for general AI news. 
    - [ ] 404media
    - [ ] YC Forums (?)
    - [ ] Hacker News (?)
    - [ ] The Verge
    - [ ] WIRED
    - [ ] TechCrunch
    - [ ] MIT Technology Review
- [ ] 🟡 **High** - Fix issue where middleware.js is no longer supported and needs to be updated to fit new pattern.

<br>

## New Feature List:
### General Features
- [ ] 🟢 **Low** - Experiment with standard col width of having either p/3, p/4 or p/5 where p is the width of the page or available space for items
- [ ] 🟢 **Low** - Set the "npm run start" script to setup startup logs in the first 1m after the app starts up to better diagnose prod issues
  - [ ] Use UNIX time to name logs that save to a new log folder; these are not build logs but startup logs. (Would this be written in bash or node process?)
- [ ] 🟢 **Low** - Create cards for research papers that filter through view sub-subjects. eg: Physics View - Quantum Physics, Particle Physics, Astrophysics, etc.
- [ ] 🟢 **Low** - Once prod server is fixed, broadcase the server on the local network and make it mobile-compatible so I can access it on my phone

### Mobile Remote Access
- [ ] 🔴 **Blocker** - Setup Openclaw
  - Notes: Openclaw cannot use Antigravity as i thought. instead it runs its own server that communicates to cli and other low-level apps/ai-agents but not high-level apps like antigravity with UI. Have to develop or use custom tool. 
    - [ ] Options:
      - [ ] https://github.com/krishnakanthb13/antigravity_phone_chat
      - [ ] https://github.com/L1M80/porta
      - [ ] 
  - [ ] Create a new discord app to manage convos and tasks.

### Space View
- [ ] 🔵 **Medium** - Create Artemis mission section that tracks items specifically about the Artemis missions:
  - [ ] Add a visual diagram of where the craft is based on the mission current stage. 
    - [ ] Launch & Earth Orbit
    - [ ] Trans Lunar Voyage
      - [ ] Distance to Moon
    - [ ] Lunar Orbit
    - [ ] Landing
    - [ ] Trans Lunar Return Voyage
      - [ ] Distance to Earth
    - [ ] Earth Orbit & Recovery
  - [ ] Create a countdown to different stages
    - [ ] Create a countdown for between missions to next rocket launch as well.
  - [ ] Get mission itinerary
  - [ ] Add Livestream card to section to always have the stream running during missions. (BLOCKED by YouTube features not yet added) 

### Notification Service
- [ ] 🔵 **Medium** - Create a notification service that can be used to send notifications to the user.
  - [ ] Allow application to send in-browser notifications.
  - [ ] Allow application to send notifications to the user's phone through:
    - [ ] Phone Number
    - [ ] Email
    - [ ] Push Notifications
  - Create list of notification types and what they are for.
    - [ ] Rocket Launches
    - [ ] Company Blog Updates
    - [ ] Research Paper Updates
      - [ ] New Papers based on specific:
        - [ ] New Papers based on specific authors
        - [ ] New Papers based on specific sub-topics
    - [ ] Application Updates

### Project Tracking
- [ ] 🟢 **Low** - Add a new card/widget for monitoring Github project progress.
- [ ] 🟡 **High** - Create todo list utility that shows the todo list from the project files.
  - [ ] Should be able to edit, add, delete todo items from a markdown file in the repo itself

### Youtube Features
- [ ] 🟢 **Low** - Add youtube features
  - [ ] Make youtube card
  - [ ] Filter through new suggested videos and subscription videos into one auto-scrolling carousel based on subject/view
    - [ ] Create whitelist of channels for each view to make sure that their new videos are always shown. eg: Physics View/ Sabine Hossenfelder, PBS Space Time, Veritasium, etc.

### Service Monitoring
- [ ] 🔵 **Medium** - Create card that shows the background services running on the mac-mini using pm2 or some other service monitoring utility. Not the internal services that are for MS but the ones that it connects to like pulsar, personal website, etc.
  - [ ] Show the stats like:
    - [ ] CPU Usage
    - [ ] Memory Usage
    - [ ] Uptime

### Node Relationship Graph (Research Papers, etc.)
- [ ] 🟢 **Low** - Create a new widget that allows relationships between nodes to be shown. (eg: family tree, company org chart, research paper/idea relationships, etc.)
  - [ ] Create a specific kind of graph that details the relationships between research papers. 
    - [ ] Decide how to visually represent higher dimensional relationships between papers in 2D.
      - [ ] Idea 1: Use columns to represent different topics and rows to represent the date relative to each other. This would make the whole thing 2D.
      - [ ] Idea 2: Take a slice of a higher dimensional object containing all papers where the slice is a 2D representation of the single topic with nothing else being shown. This would make the relationship between ideas easier to navigate. For example if a research paper uses a mathematical technique developed in another paper, we can easily navigate between slices where the nodes in each slice are connected through a higher dimensions not shown in the slices. This would be a high dimensional graph where the axies are time and the topics as we continue to add more papers and topics.
    - [ ] Make the x coord the paper topic in relation to other papers.
    - [ ] Make the y coord the date of the paper so we can see the progression of time.
    - [ ] Create a search utility to find research papers by author, title, date, or keywords.
  - [ ] Choose a readable text file format to store the relationships in. (csv, .md, mermaid?)
  - [ ] Create a way to add new relationships to the graph. 

### Company Blog Feeds
- [ ] 🟢 **Low** - Add feeds for these companies blogs in their respective views. 
  - [ ] Space View
    - [ ] Prime Contractors/Launch Providers
      - [x] SpaceX
      - [x] RocketLab
      - [ ] Blue Origin
      - [ ] Northrop Grumman
      - [ ] Boeing
      - [ ] Lockheed Martin
      - [ ] ArianeGroup
      - [ ] ULA
    - [ ] Upstart Launch Providers
      - [ ] Relativity
      - [ ] Firefly
      - [ ] Stoke
      - [ ] Rocket Factory Augsburg
    - [ ] Space Hardware/Component Manufacturers
      - [ ] Redwire
      - [ ] Aerojet Rocketdyne
      - [ ] Ursa Major
      - [ ] Xona Space Systems
      - [ ] Blue Canyon Technologies
      - [ ] Hadrian
      - [ ] Apex
    - [ ] Government Space Agencies (NASA, ESA, etc.)
      - [ ] NASA
      - [ ] ESA
      - [ ] JAXA
      - [ ] CNSA
      - [ ] Roscosmos
      - [ ] ISRO
      - [ ] CSA
    - [ ] 
  - [ ] AI View
    - [ ] Computation
      - [ ] Fabless
        - [x] Nvidia
        - [ ] AMD
          - [ ] Notes: Internal server error.
        - [ ] Intel 
        - [ ] Qualcomm
        - [ ] Broadcom
          - [ ] Notes: Getting stories about but not from the actual blog/news site. 
        - [ ] Apple
        - [ ] Google
      - [ ] AI Accelerators
        - [x] Groq
          - [x] Notes: Seems to be getting blog posts but only retrieved 2 from 2025 when there are much more recent ones. https://groq.com/blog. 
        - [x] Cerebras
          - [x] Notes: Same problem as with Meta AI blog where they do have a dedicated blog page, the blog includes a date for each post but it is not being picked up. 
      - [ ] IP/Architecture
        - [ ] arm
      - [ ] Foundries
        - [ ] Samsung Foundries
        - [ ] TSMC
        - [ ] Global Foundries
        - [ ] UMC
        - [ ] SMIC
        - [ ] Intel Foundry
        - [ ] Micron
    - [ ] AI Software/Model Developers
      - [x] Google DeepMind/AI
      - [x] Meta AI
        - [x] Notes: Custom fetcher scrapes ai.meta.com/blog/ listing page. Dates extracted from positional proximity to blog URLs. Titles from aria-label/anchor text with OGS fallback for impact story cards.
      - [x] Microsoft AI
        - [x] Notes: Old RSS feed (blogs.microsoft.com/ai/feed/) was abandoned in 2022. Swapped to active Microsoft Research blog feed (microsoft.com/en-us/research/feed/).
      - [ ] xAI
      - [ ] Mistral
        - [ ] Appears to only get the blog on the hero card not a list of the 10 most recent. https://mistral.ai/news.
      - [ ] Hugging Face
      - [ ] Deepseek
        - [ ] Notes: Same issue as with Meta AI, we are getting stories about deepseek not the actual deepseek release blogs
      - [ ] Baidu
        - [ ] Notes: Same issue as with Deepseek. Seems like chinese companies are harder to get info from. 
      - [ ] Bytedance
      - [x] OpenAI blogs
      - [x] Anthropic blogs
- [ ] 🟢 **Low** - Add feeds for news sources for computation and AI. 
  - [ ] Tech Tech Potato
  - [ ] Semi Analysis

### New View: Applications
- [ ] 🟡 **High** - Create a new view that shows and keeps track of job/internship/citizenship/school and other kinds of applications and their status.
  - [ ] Connect to Gmail and Gcal to get updates when new emails come in
    - [ ] **Integration Plan:**
      - **OAuth 2.0:** Set up a Google Cloud Project with Gmail API and Google Calendar API scopes. Use `next-auth` to easily authenticate and store the refresh token securely in Prisma without a custom dashboard.
      - **Gmail Syncing Strategy:** Use Cloudflare Tunnels (via `salsquared.xyz`) and Google Cloud Pub/Sub to receive live webhook push notifications. This provides a real-time sync while heavily conserving RAM and CPU on the Mac Mini compared to polling.
      - **Data Parsing:** Use an LLM or standard regex parser to extract application status updates, interview details, and next steps from incoming emails.
      - **Dashboard DB:** Store parsed application instances (Company/Institution, Status, Next Steps, Dates) in our internal db.
    - [ ] Create front-end component that shows gcal events from personal gmail account. 
      - [ ] Allow the editing of events, adding new events, deleting events, etc.
  - [ ] Create events in Gcal from emails for appointments,interviews, etc.
    - [ ] **Automation Plan:**
      - Expose a Next.js API route that the background worker or UI can hit to construct and push a Google Calendar event.
      - Auto-fill event details (title, description with email link, start/end time) based on the parsed email contents.
<br>

## Completed Items:
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

### API Integrations:
- **Arxiv API**: add the ability for any of the views or cards to fetch papers
- **Hugging face & Semantic Scholar Integration**:
  - [x] Research HF Daily Papers API (`https://huggingface.co/api/daily_papers`) & Semantic Scholar Graph API (`https://api.semanticscholar.org/graph/v1/paper/batch`).
  - [x] Update `app/api/arxiv/route.ts` (or create new `app/api/research/route.ts`) to fetch Hugging Face papers first.
  - [x] Extract ArXiv IDs from HF results, then batch query Semantic Scholar for `citationCount`, `authors`, and `abstract`.
  - [x] Map combined data into unified `Paper` objects (`id`, `title`, `summary`, `url`, `author`, `published_at`, `source`, `upvotes`, `citationCount`).
  - [x] Implement robust caching in the endpoint to avoid strict rate limits.
  - [x] Update `ResearchPaperCard.tsx` to display `citationCount` and `upvotes` visually.
  - [x] Update `AIView.tsx` to query new endpoints for "Top Yesterday" and "Top Last Week".
