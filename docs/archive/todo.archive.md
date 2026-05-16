# Archived task list — frozen snapshot

> The `Task` DB table is now the source of truth for tasks (see `CLAUDE.md` and `docs/architecture.md`). This file was the previous source-of-truth and is kept as a read-only snapshot for historical reference. Editing it has no effect on the running app — `lib/tasks/parser.ts` and the file watcher were removed in the cutover. All task IDs below are still present in the `Task` table.

## Feature Fixes
### Company News API
- [x] 🔵 **Medium** - Fix issue where meta ai news is not showing up at all. <!-- id: 590c2382-a7d1-4a5b-8a55-f9f67039d379 -->
- [ ] 🔵 Fix issue where deepmind, meta, microsoft and nvidia images arent showing. @due(2026-04-22) <!-- id: f35561df-b510-4b9f-ae56-f659fef8aeb2 -->
- [ ] 🔵 **Medium** - Get rid of Hackernews in the AI company feed.  <!-- id: 1fee4ac4-934b-4a1c-8954-69709e1858e5 -->
  - [ ] 🔵 Create a new section for general AI news.  <!-- id: 465d0077-7fea-4f0f-8d24-7417acf6cfb9 -->
    - [ ] 🔵 404media <!-- id: fbf829b4-7922-4f82-8033-041dfa251b76 -->
    - [ ] 🔵 YC Forums (?) <!-- id: d2cf2881-bcde-40d0-86f3-7cc153212996 -->
    - [ ] 🔵 Hacker News (?) <!-- id: d6f2e7fb-2f42-47c8-8076-ccca6482c79c -->
    - [ ] 🔵 The Verge <!-- id: 5d5fac8b-2f4e-4c5a-8ca6-b23d039a4d42 -->
    - [ ] 🔵 WIRED <!-- id: 05ebc8d9-2b74-46b4-80e0-de5ce299533e -->
    - [ ] 🔵 TechCrunch <!-- id: 78dfab40-4e6e-47e8-ab81-56f466a90e51 -->
    - [ ] 🔵 MIT Technology Review <!-- id: d75fef00-4910-4ea4-8935-37eee3b6d46d -->
- [ ] 🟡 **High** - Fix issue where middleware.js is no longer supported and needs to be updated to fit new pattern. <!-- id: 138effbb-680d-42fa-8a8e-58daec5cc4a1 -->

## New Feature List:
### General Features
- [ ] 🟢 **Low** - Experiment with standard col width of having either p/3, p/4 or p/5 where p is the width of the page or available space for items <!-- id: 2c266a3a-d6a9-4f7e-9d0e-058848cb3ca7 -->
- [ ] 🟢 **Low** - Set the "npm run start" script to setup startup logs in the first 1m after the app starts up to better diagnose prod issues <!-- id: e56d8750-8588-4667-942b-a7507b3604d1 -->
  - [ ] 🔵 Use UNIX time to name logs that save to a new log folder; these are not build logs but startup logs. (Would this be written in bash or node process?) <!-- id: 5c2fbc6f-6941-4891-a13c-d290c23c3143 -->
- [ ] 🟢 **Low** - Create cards for research papers that filter through view sub-subjects. eg: Physics View - Quantum Physics, Particle Physics, Astrophysics, etc. <!-- id: 42885bec-cd1f-454e-bf3e-2c97e94bc812 -->
- [ ] 🟢 **Low** - Once prod server is fixed, broadcase the server on the local network and make it mobile-compatible so I can access it on my phone <!-- id: b4e38321-b089-454a-a8dd-a72c9a732911 -->

### Mobile Remote Access
- [ ] 🔴 **Blocker** - Setup Openclaw <!-- id: cb22ddbf-05b2-4f91-9d59-edd4daeb2325 -->
  - Notes: Openclaw cannot use Antigravity as i thought. instead it runs its own server that communicates to cli and other low-level apps/ai-agents but not high-level apps like antigravity with UI. Have to develop or use custom tool. 
    - Options:
      - https://github.com/krishnakanthb13/antigravity_phone_chat
      - https://github.com/L1M80/porta
  - [ ] 🔵 Create a new discord app to manage convos and tasks. <!-- id: 546e6c5a-2174-485f-b9a5-70a71374e37f -->

### New View: Planning & Strategy
- [ ] 🔴 **Blocker** - Create a new view that is a planning and strategy board for the user.  <!-- id: 29a51c77-dcf0-455d-9ed9-f662b9635dcf -->
  - [ ] 🔵 **Architecture Note**: Prioritize reusing existing components, cards, ui elements, and widgets from `mission-control/components`. <!-- id: baff7fec-eb0d-410a-be87-a08b5114b8fa -->
  - [ ] 🔵 Todo Section <!-- id: 8afe96cb-9e1e-4a48-978a-a0e2ead3e1e4 -->
    - [ ] 🔵 Create a section that handles todo lists for the user. <!-- id: 16502cb3-7c40-4868-a60a-fed7a5e8a0c8 -->
- [ ] 🔵 Create todo list component that can be reuesd. <!-- id: 91923ba9-0b60-457f-9041-f113f618ba43 -->
  - [ ] 🔵 Create system to add, edit, delete, and reorder todo list items. <!-- id: e29352e8-7421-48db-a162-f9dec8f092ee -->
  - [ ] 🔵 Create system to parse todo list items and priority + other potential metadata from markdown files. <!-- id: 3893710e-ef68-4c98-8166-7b336fa90e1d -->
  - [ ] 🔵 Implement todo list for all projects and general todos. <!-- id: 4558af6b-4186-4b38-a180-f10057e90d85 -->
  - [ ] 🔵 Implement todo list for each project that handles project specific things. <!-- id: a061aae3-c0e0-459b-97fb-bf53641ef601 -->
    - [x] 🔵 Create set of procedures for how to handle todo lists. <!-- id: f200e149-1144-40d6-b69b-9758e52edc50 -->
      - [x] 🔵 Priority System <!-- id: d8d994a6-2078-4085-a082-34463bdc5efa -->
        - [x] 🔵 Copy priority system from mission control to here. <!-- id: 5264dc7c-a3b1-4da3-9a28-a587f2170868 -->
  - [ ] 🔵 Visual Board Layouts <!-- id: 4fa145ca-8dd8-46f8-8fab-ac801479db56 -->
    - [ ] 🔵 Implement a Kanban board layout (To Do, In Progress, Done) as an alternative to the flat list. <!-- id: db8980a8-dfae-4236-8188-067dede85845 -->
    - [ ] 🔵 Add drag-and-drop functionality for moving tasks between lists, statuses, or priorities. <!-- id: c877cfd6-461b-4d08-8950-4cd7be07d87d -->
  - [ ] 🔵 Advanced Task Management <!-- id: 9c4f2604-baf5-4bfa-a13f-76d25a3c4f7c -->
    - [ ] 🔵 System for assigning and parsing due dates from markdown. <!-- id: 587e9bc9-d741-4512-ad71-d13a4b154e51 -->
    - [ ] 🔵 Task filtering (filter by priority, project, or status). <!-- id: 8bd8492c-390f-4627-b7be-f6cd61ba4172 -->
    - [ ] 🔵 Task sorting (sort by due date, priority, or creation date). <!-- id: f5203417-c9d0-47eb-8c06-b81368de148a -->
  - [ ] 🔵 Bi-directional Sync <!-- id: 8b9991b7-65e7-4195-819b-389413355b58 -->
    - [ ] 🔵 Ensure that completing or editing a task in the UI updates the underlying `.md` file in real-time. <!-- id: f01086b2-cc86-40c4-bf1d-6ea974217693 -->
  - [ ] 🔵 High-Level Strategy & Goal Tracking <!-- id: 1ae27335-f4d5-47d7-8007-60fe738bc154 -->
    - [ ] 🔵 Create a "Milestones" or "Goals" tracker that groups smaller todo items into larger objectives. <!-- id: 61941aca-56b2-4ec0-a045-5091e8344f2a -->
    - [ ] 🔵 Add visual progress indicators (e.g., progress bars) for projects based on the ratio of completed vs. uncompleted tasks. <!-- id: d39b02c7-c6e1-4254-8638-7b1a886bf0ee -->
    - [ ] 🔵 Create an "Icebox/Backlog" area for long-term ideas that aren't ready for the active todo list. <!-- id: b045f9f3-4661-4e66-b7fb-496d4d9e833d -->
  - [ ] 🔵 Calendar & Events <!-- id: c1e4c2a8-6ac6-4996-a01b-6bddaeb665d1 -->
    - [ ] 🔵 Add a calendar widget to the board to keep track of events and task due dates visually. <!-- id: b0a8e89e-9ae2-4131-a538-88d58af80737 -->

### Space View
- [ ] 🔵 **Medium** - Create Artemis mission section that tracks items specifically about the Artemis missions: <!-- id: 78b6924d-b856-4d6d-9c6b-43f43cbcd367 -->
  - [ ] 🔵 Add a visual diagram of where the craft is based on the mission current stage.  <!-- id: 75685c93-71e7-414d-9dd0-6af45382f4ac -->
    - [ ] 🔵 Launch & Earth Orbit <!-- id: 18830299-3ea9-4767-bf5f-1bc1bb6c92b7 -->
    - [ ] 🔵 Trans Lunar Voyage <!-- id: 0e0278b3-c487-439f-bbe0-d18993964a91 -->
      - [ ] 🔵 Distance to Moon <!-- id: bbe1efcc-6e99-4b4f-921c-7905e6c92b82 -->
    - [ ] 🔵 Lunar Orbit <!-- id: 18e7884b-94c9-48ef-95c5-b64f5038cb49 -->
    - [ ] 🔵 Landing <!-- id: 1ddd9a43-a6c1-4228-bc39-7a57c15c29e9 -->
    - [ ] 🔵 Trans Lunar Return Voyage <!-- id: 9a0f495d-a6db-487b-af00-d68938ef83d0 -->
      - [ ] 🔵 Distance to Earth <!-- id: 4c444050-9ab1-4867-a4f3-c4a40068322e -->
    - [ ] 🔵 Earth Orbit & Recovery <!-- id: a4de8144-018b-42b8-97bf-5acada94f14b -->
  - [ ] 🔵 Create a countdown to different stages <!-- id: 57fd2432-8635-4fc5-abbe-ffd0e949c754 -->
    - [ ] 🔵 Create a countdown for between missions to next rocket launch as well. <!-- id: 0680b475-5d26-4f54-a293-1935006062bc -->
  - [ ] 🔵 Get mission itinerary <!-- id: 6dc22c07-6332-49c2-b666-ea09b7fb391f -->
  - [ ] 🔵 Add Livestream card to section to always have the stream running during missions. (BLOCKED by YouTube features not yet added)  <!-- id: b7929122-95e3-4ffb-bd2f-b7d2ae53de82 -->

### Notification Service
- [ ] 🔵 **Medium** - Create a notification service that can be used to send notifications to the user. <!-- id: 7a9299f7-6c50-47d9-bd3e-a08aad3a8f2f -->
  - [ ] 🔵 Allow application to send in-browser notifications. <!-- id: 9649c74a-806b-49ed-b53d-70ecdbf4ff06 -->
  - [ ] 🔵 Allow application to send notifications to the user's phone through: <!-- id: d86edde2-af6f-42f9-a582-c5f445225e11 -->
    - [ ] 🔵 Phone Number <!-- id: 0ee9eb33-42c6-455f-ab84-e5a1d9069821 -->
    - [ ] 🔵 Email <!-- id: 5495ee8b-ba03-4792-8598-0d4a9f908498 -->
    - [ ] 🔵 Push Notifications <!-- id: 065e6a13-8c8b-4f3b-b2bd-23456464c779 -->
  - Create list of notification types and what they are for.
    - [ ] 🔵 Rocket Launches <!-- id: 1ac872cb-2e55-429f-b821-f808907be8f3 -->
    - [ ] 🔵 Company Blog Updates <!-- id: a03084f9-2d9c-400c-9d75-843e79ae1a28 -->
    - [ ] 🔵 Research Paper Updates <!-- id: 3cc7ffb9-0d01-44da-a556-040c685dbee7 -->
      - [ ] 🔵 New Papers based on specific: <!-- id: 4477e910-07d4-41fe-a1bc-60a688b22048 -->
        - [ ] 🔵 New Papers based on specific authors <!-- id: 71cf63ae-b0ae-4ebb-9e90-40478196ce98 -->
        - [ ] 🔵 New Papers based on specific sub-topics <!-- id: 04283a7d-35f9-4dea-b602-b37f22452839 -->
    - [ ] 🔵 Application Updates <!-- id: 7eb1f5b1-1cf7-4211-bf2e-258d25fdfbe2 -->

### Youtube Features
- [ ] 🟢 **Low** - Add youtube features <!-- id: 4b6fdec0-0f5b-483c-983e-57c0696575a4 -->
  - [ ] 🔵 Make youtube card <!-- id: 1247cf3c-08e1-4c69-bcdb-92c9c2f2c965 -->
  - [ ] 🔵 Filter through new suggested videos and subscription videos into one auto-scrolling carousel based on subject/view <!-- id: 65c1cf95-750d-42aa-b048-d18d2fb38f1a -->
    - [ ] 🔵 Create whitelist of channels for each view to make sure that their new videos are always shown. eg: Physics View/ Sabine Hossenfelder, PBS Space Time, Veritasium, etc. <!-- id: aa4902e6-ab57-4875-82f8-e5fd63bb5d05 -->

### Service Monitoring
- [ ] 🔵 **Medium** - Create card that shows the background services running on the mac-mini using pm2 or some other service monitoring utility. Not the internal services that are for MS but the ones that it connects to like pulsar, personal website, etc. <!-- id: 604f9e31-d46a-445a-a666-3c4be752386d -->
  - [ ] 🔵 Show process stats like: <!-- id: bf813d68-1222-4696-a5d2-e3688aaea2ff -->
    - [ ] 🔵 CPU Usage <!-- id: 05e65fab-c558-4559-b03b-7da54ac73469 -->
    - [ ] 🔵 Memory Usage <!-- id: ad589326-13b5-4e10-ae4b-536c8e8091b2 -->
    - [ ] 🔵 Uptime <!-- id: 12b208da-380d-4591-84a8-c48928a63147 -->
    - [ ] 🔵 PID <!-- id: 1fee8be7-3c85-43d3-ae07-8a75c1f6e5be -->
    - [ ] 🔵 Port <!-- id: ccc6f9e3-851f-4e8a-809c-4373ab76cf64 -->
    - [ ] 🔵 Status (Running, Stopped, etc.) <!-- id: 5b7a0528-15ce-4b9b-bb75-4ff01bdc63a1 -->

### Node Relationship Graph (Research Papers, etc.)
- [ ] 🟢 **Low** - Create a new widget that allows relationships between nodes to be shown. (eg: family tree, company org chart, research paper/idea relationships, etc.) <!-- id: a663751e-d102-4419-b9e4-2d976a469b2b -->
  - [ ] 🔵 Create a specific kind of graph that details the relationships between research papers.  <!-- id: 8b011c7f-2c38-49ee-a413-60db5dbd71d8 -->
    - [ ] 🔵 Decide how to visually represent higher dimensional relationships between papers in 2D. <!-- id: f1cfd99a-3b1f-495c-a3f3-0d77f32ebb48 -->
      - [ ] 🔵 Idea 1: Use columns to represent different topics and rows to represent the date relative to each other. This would make the whole thing 2D. <!-- id: 68ee777a-587f-4fca-9d9d-f894ad81c60d -->
      - [ ] 🔵 Idea 2: Take a slice of a higher dimensional object containing all papers where the slice is a 2D representation of the single topic with nothing else being shown. This would make the relationship between ideas easier to navigate. For example if a research paper uses a mathematical technique developed in another paper, we can easily navigate between slices where the nodes in each slice are connected through a higher dimensions not shown in the slices. This would be a high dimensional graph where the axies are time and the topics as we continue to add more papers and topics. <!-- id: 86a69123-cc6d-4307-84db-df84b2f80588 -->
    - [ ] 🔵 Make the x coord the paper topic in relation to other papers. <!-- id: 9f31d4a5-9577-4637-b7da-551063f64bfb -->
    - [ ] 🔵 Make the y coord the date of the paper so we can see the progression of time. <!-- id: 2d59964e-4a59-4ca8-b96d-34709ab8b173 -->
    - [ ] 🔵 Create a search utility to find research papers by author, title, date, or keywords. <!-- id: 5ab9e49e-1279-4ddc-8f7c-56562f20d487 -->
  - [ ] 🔵 Choose a readable text file format to store the relationships in. (csv, .md, mermaid?) <!-- id: 82b89f72-9d46-4cc8-b5b1-4175fb29702d -->
  - [ ] 🔵 Create a way to add new relationships to the graph.  <!-- id: f3b70299-9900-4774-a71a-b83614a4302e -->

### Company Blog Feeds
- [ ] 🟢 **Low** - Add feeds for these companies blogs in their respective views.  <!-- id: 1e28f59a-0fe1-415c-a69f-ea0938a075d4 -->
  - [ ] 🔵 Space View <!-- id: c79ce0f8-3ba7-42a5-bfa9-c5185dbd301e -->
    - [ ] 🔵 Prime Contractors/Launch Providers <!-- id: 9e5df05b-2184-4dfa-80dd-830b7d0f62ec -->
      - [x] 🔵 SpaceX <!-- id: 0fe98c1f-5b0b-4879-a715-1585a09ad7a0 -->
      - [x] 🔵 RocketLab <!-- id: bb541996-dc21-49d7-97f8-9cf1dcd2e41b -->
      - [ ] 🔵 Blue Origin <!-- id: 9d055d40-cf78-46f0-af6c-f19300410a5c -->
      - [ ] 🔵 Northrop Grumman <!-- id: 87a20c21-ca74-40e9-b101-ce1907e0cd55 -->
      - [ ] 🔵 Boeing <!-- id: 5510dbd8-c280-411c-8672-6a40682c437e -->
      - [ ] 🔵 Lockheed Martin <!-- id: e3d03270-f36e-431f-84e3-d7819038cbda -->
      - [ ] 🔵 ArianeGroup <!-- id: c3f572c9-1a6d-4c62-abf6-cac5c1927a3f -->
      - [ ] 🔵 ULA <!-- id: f6b2b4ff-add5-487b-8811-0299bb618b16 -->
    - [ ] 🔵 Upstart Launch Providers <!-- id: 193f626a-33b3-4043-b4e7-1ef015d65d94 -->
      - [ ] 🔵 Relativity <!-- id: 7b0ceedf-11bf-4e6e-8144-019912bd9602 -->
      - [ ] 🔵 Firefly <!-- id: 2bea64d1-89d6-45f1-9f0c-a49dfc2266ba -->
      - [ ] 🔵 Stoke <!-- id: b962bf32-8bcd-483b-be52-cd7ddd6ae089 -->
      - [ ] 🔵 Rocket Factory Augsburg <!-- id: 4c0c9496-a707-47eb-be3c-d7573d98ce18 -->
    - [ ] 🔵 Space Hardware/Component Manufacturers <!-- id: f8dd1903-aa6c-44eb-a181-f4c4f7bb3894 -->
      - [ ] 🔵 Redwire <!-- id: 0397bd8d-c268-411b-8da6-ceac3b9ebb32 -->
      - [ ] 🔵 Aerojet Rocketdyne <!-- id: fe238365-0481-4b43-953f-21b7277582cc -->
      - [ ] 🔵 Ursa Major <!-- id: 67b5c3a5-e43f-4d6d-9372-dbab08d444b3 -->
      - [ ] 🔵 Xona Space Systems <!-- id: 65dec16a-901c-40b0-aab7-1761cbae72da -->
      - [ ] 🔵 Blue Canyon Technologies <!-- id: c548900d-82d3-4068-9557-2706ad716a10 -->
      - [ ] 🔵 Hadrian <!-- id: 0aab7902-59fb-4e08-b7e8-314e00c60752 -->
      - [ ] 🔵 Apex <!-- id: 465596d9-cb1e-4866-830e-66ebbf8cb9d0 -->
    - [ ] 🔵 Government Space Agencies (NASA, ESA, etc.) <!-- id: 857777f1-3baa-49eb-851c-f8303b678e74 -->
      - [ ] 🔵 NASA <!-- id: c27ccf5d-b02d-46ed-86ef-9c5b4b8eb25f -->
      - [ ] 🔵 ESA <!-- id: 9b96ca9e-6d2e-41c7-9600-5694641b1c2c -->
      - [ ] 🔵 JAXA <!-- id: 80c71944-7765-4561-be4b-68cc53babf8a -->
      - [ ] 🔵 CNSA <!-- id: fb327dd1-d902-4a28-b4f9-2eb2a549ddfc -->
      - [ ] 🔵 Roscosmos <!-- id: de6271c2-e6a6-4fd4-9dd9-1d236f51a4f2 -->
      - [ ] 🔵 ISRO <!-- id: 160e5d02-6306-4ae1-ae0c-882d868a167b -->
      - [ ] 🔵 CSA <!-- id: bf00563c-54df-4742-9fcb-3c75deac6c44 -->
- [ ] 🔵 AI View <!-- id: 29d6a2a1-a7a3-495e-80eb-d88f3a32556a -->
  - [ ] 🔵 Computation <!-- id: 85352766-574b-4834-a937-09da3adfb325 -->
    - [ ] 🔵 Fabless <!-- id: 94cf2255-af42-4877-9f2e-a59a5480415b -->
      - [x] 🔵 Nvidia <!-- id: 10f2cef5-03d8-42a3-ba35-422c6c730391 -->
      - [ ] 🔵 AMD <!-- id: 6422152c-e47c-4b49-a8ce-890907421b00 -->
        - [ ] 🔵 Notes: Internserver error. <!-- id: 21a2c174-96b8-405b-92bd-1e466b73c73d -->
      - [ ] 🔵 Intel  <!-- id: 23fd422f-4458-48c0-b95d-19b63a12584c -->
      - [ ] 🔵 Qualcomm <!-- id: d737c40a-cdc4-448b-99a6-521ffc83f8a6 -->
      - [ ] 🔵 Broadcom <!-- id: b2a7ae77-ec62-4f98-862f-37d4083ddf58 -->
        - [ ] 🔵 Notes: Getting stories about but not from the actual blog/news site <!-- id: c1a2f2d9-890b-4f23-887a-c05aaa4573ac -->
      - [ ] 🔵 Apple <!-- id: b9ccf14c-d009-49bb-b642-d39c28e30cec -->
      - [ ] 🔵 Google <!-- id: 60d80959-ec1a-49a4-b50b-bc5f5a716254 -->
    - [ ] 🔵 AI Accelerators <!-- id: 49c32947-cf82-4fd5-8f2c-3ff4a85e71f0 -->
      - [x] 🔵 Groq <!-- id: 8e8d7821-6009-42e8-baa2-318a72afd983 -->
        - [x] 🔵 Notes: Seems to be getting blog posts but only retrieved 2 from 2025 when there are much more recent ones. https://groq.com/blog.  <!-- id: b92e1c81-f5e3-488f-9a05-d5bd829b8bf0 -->
      - [x] 🔵 Cerebras <!-- id: 8f322fba-597f-4049-8875-5a110739f5b6 -->
        - [x] 🔵 Notes: Same problem as with Meta AI blog where they do have a dedicated blog page, the blog includes a date for each post but it is not being picked up.  <!-- id: 47bf6494-0842-4f49-8c52-eeb0e6bc90ef -->
  - [ ] 🔵 IP/Architecture <!-- id: b0ab6b98-8933-4f1b-af16-2363d05674e5 -->
    - [ ] 🔵 arm <!-- id: 7dd594c3-acb9-4ba7-a096-949bc6ff2ded -->
  - [ ] 🔵 Foundries <!-- id: 6432ade4-c8a3-40c6-bb5e-21387eadcd22 -->
    - [ ] 🔵 Samsung Foundries <!-- id: 001fb324-09f0-4d7f-9f75-f585247599bf -->
    - [ ] 🔵 TSMC <!-- id: 2b8f57c3-27d8-48fc-b283-7c0fbec4ac30 -->
    - [ ] 🔵 Global Foundries <!-- id: 6a32b084-8d75-406d-aa13-a248fc827103 -->
    - [ ] 🔵 UMC <!-- id: 91020178-475a-4a4c-a4fd-f0fd654cacab -->
    - [ ] 🔵 SMIC <!-- id: e458dd01-21df-42db-99ce-7759ba767e7c -->
    - [ ] 🔵 Intel Foundry <!-- id: 46aeab0e-edf5-4dda-9213-cbe285c010a5 -->
    - [ ] 🔵 Micron <!-- id: 1194ca6a-710f-4c90-a121-b1fa3aab31c3 -->
  - [ ] 🔵 AI Software/Model Developers <!-- id: 7677d118-da37-4ed6-9123-93f990f84a24 -->
    - [x] 🔵 Google DeepMind/AI <!-- id: 6b7e46c2-6141-4801-8dc3-9a2aa1264a36 -->
    - [x] 🔵 Meta AI <!-- id: 2e660cb3-8645-4000-b3b7-a4fb05bff5e4 -->
      - [x] 🔵 Notes: Custom fetcher scrapes ai.meta.com/blog/ listing page. Dates extracted from positional proximity to blog URLs. Titles from aria-label/anchor text with OGS fallback for impact story cards. <!-- id: 1bfd8062-4763-4900-95d3-b4c91edb296c -->
    - [x] 🔵 Microsoft AI <!-- id: 9c0906c0-3c03-4ab2-84f4-e46cc31266a4 -->
      - [x] 🔵 Notes: Old RSS feed (blogs.microsoft.com/ai/feed/) was abandoned in 2022. Swapped to active Microsoft Research blog feed (microsoft.com/en-us/research/feed/). <!-- id: a0fd96a2-67e2-49c1-acb5-77b6fbcd8e52 -->
    - [ ] 🔵 xAI <!-- id: ce5f0ced-2b4c-4f11-b65a-82eb3cb29016 -->
    - [ ] 🔵 Mistral <!-- id: 24f45422-19c4-4867-8105-38c0bb9c9d3f -->
      - [ ] 🔵 Appears to only get the blog on the hero card not a list of the 10 most recent. https://mistral.ai/news. <!-- id: 520158a5-739a-4c8c-9810-9dfc7213015c -->
    - [ ] 🔵 Hugging Face <!-- id: d4af0222-2930-437b-b4d3-d671c5ec7432 -->
    - [ ] 🔵 Deepseek <!-- id: 946a3650-3569-4574-8a7a-5a3f51ee1c1f -->
      - [ ] 🔵 Notes: Same issue as with Meta AI, we are getting stories about deepseek not the actual deepseek release blogs <!-- id: f0a10946-731f-414c-867c-8b577183d006 -->
    - [ ] 🟢 Baidu <!-- id: 8afb320b-07db-42e5-83e7-f191dea70bdf -->
      - [ ] 🔵 Notes: Same issue as with Deepseek. Seems like chinese companies are harder to get info from.  <!-- id: 22e1bcfb-3c65-474b-a062-702a26967a7b -->
    - [ ] 🟢 Bytedance <!-- id: 335af835-18d7-441b-9e3e-c9546777859a -->
    - [x] 🔵 OpenAI blogs <!-- id: bf3ddf06-995f-4ee4-bb45-1a0650b9ec5f -->
    - [x] 🔵 Anthropic blogs <!-- id: ffdd3fb9-08b4-42cf-b76d-fde5915e9cc9 -->
- [ ] 🟢 **Low** - Add feeds for news sources for computation and AI.  <!-- id: 68663f55-5fe6-4c62-8dc4-dea5e0bf6e1b -->
  - [ ] 🔵 Tech Tech Potato <!-- id: a0f82abe-2938-4cc1-8177-9aa8e9bb4137 -->
  - [ ] 🔵 Semi Analysis <!-- id: 908e9c89-7b33-4611-942b-a9d553238299 -->

### New View: Applications
- [ ] 🟡 **High** - Create a new view that shows and keeps track of job/internship/citizenship/school and other kinds of applications and their status. <!-- id: 9a6ffd20-b4f4-43d4-9489-a8f599724473 -->
  - [ ] 🔵 Connect to Gmail and Gcal to get updates when new emails come in <!-- id: d912b95d-c98a-4fbd-b9a5-1cccd4b106d3 -->
    - [ ] 🔵 **Integration Plan:** <!-- id: 90efab01-e27c-4841-9df2-f7119e794e93 -->
      - **OAuth 2.0:** Set up a Google Cloud Project with Gmail API and Google Calendar API scopes. Use `next-auth` to easily authenticate and store the refresh token securely in Prisma without a custom dashboard.
      - **Gmail Syncing Strategy:** Use Cloudflare Tunnels (via `salsquared.xyz`) and Google Cloud Pub/Sub to receive live webhook push notifications. This provides a real-time sync while heavily conserving RAM and CPU on the Mac Mini compared to polling.
      - **Data Parsing:** Use an LLM or standard regex parser to extract application status updates, interview details, and next steps from incoming emails.
      - **Dashboard DB:** Store parsed application instances (Company/Institution, Status, Next Steps, Dates) in our internal db.
    - [ ] 🔵 Create front-end component that shows gcal events from personal gmail account.  <!-- id: a6c825c5-8936-4d1d-b9fb-07719964fe81 -->
      - [ ] 🔵 Allow the editing of events, adding new events, deleting events, etc. <!-- id: c3069d41-efb4-43e3-ab08-ab677b948279 -->
- [/] 🔵 Create events in Gcal from emails for appointments,interviews, etc. <!---- id: 66e432b7-b57c-4c30-987a-e82a50da1800 -->
    - [ ] 🔵 **Automation Plan:** <!-- id: a2554018-152e-47d9-894c-14f44337d4b3 -->
      - Expose a Next.js API route that the background worker or UI can hit to construct and push a Google Calendar event.
      - Auto-fill event details (title, description with email link, start/end time) based on the parsed email contents.
<br>

## Completed Items:
- **Mission Control App**:
  - **Internal Systems View**:
    - [x] 🔵 Add feature that changes the display of ram allocated to the service based on the input variable we give in @package.json <!-- id: d0825e98-0253-4c48-b25a-d1d384fb128c -->
      - Ex: For dev we give it 2GB but in prod mode its only 1GB.
  - **UI Design / CSS**:
    - [x] 🔵 Add an edit button to the top right corner of the launchpad overlay that allows you to edit the order and name views. <!-- id: 58ec424d-bdf2-4845-8578-de7358dd6672 -->
      - [x] 🔵 Allow view name change only when the editing option is active <!-- id: 720530f1-cc73-4f4c-ba4e-110d9fdfa337 -->
      - [x] 🔵 Add the three dots handle to move and drag the views around.  <!-- id: e6dc028b-aaa9-40ab-8477-4c37116afe75 -->
    - [x] 🔵 Add semi-live previews of the views in the launchpad overlay <!-- id: 8881ad93-d36e-431f-8c84-2b1d58825d80 -->
    - [x] 🔵 Fix issue where we dont get dark scroll bars in the chrome app as we do in safari in dev mode. <!-- id: 1959ff9d-e281-4746-97b6-bc646d1ef08d -->
      - [x] 🔵 **Root Cause & Fix**: Chrome and Safari have different default OS heuristics for rendering scrollbars even in a dark UI. We fixed this by strictly declaring `color-scheme: dark;` in `:root` and adding explicit `::-webkit-scrollbar` pseudo-element classes in `globals.css` to enforce a unified dark, glass-like scroll track layer across all Webkit-based browsers. <!-- id: b915b081-3f91-48af-ba0d-015d488aec1a -->
    - [x] 🔵 Add a new dynamically rendered color toggle in internal views for new views. <!-- id: 74bc2c22-1fea-4893-970e-0f2c7e625625 -->
      - [x] 🔵 **Implementation**: Modified `InternalView.tsx` to construct color toggles by deriving the list directly from `dashOrder` and `defaultDashTitles` state, so new views automatically populate without touching UI code. Swapped browser `localStorage` persist middleware to a Prisma database table for `GlobalSettings`, making customizations persistent across distinct client devices. <!-- id: f826d7cb-ecc2-4f14-9eee-441658697e05 -->
    - [x] 🔵 Fix how laggy the view tiles are when moving them around in the edit mode using the handles to drag them. <!-- id: fe009f47-d9e1-47bc-95fb-05bd854340a9 -->
    - [x] 🔵 Fix issue where view order is not saved and defaults to the original. <!-- id: 1dad217c-9d0e-485d-8987-81f201644586 -->
  - **Backend / Launch Script**:
  - [x] 🔵 Fix issue where app was starting up but wouldnt load localhost; could be b/c ipv4 is used by node but chrome expects ipv6 (?) <!-- id: 12a7b279-6159-41c4-9734-1ef527354d38 -->
    - [x] 🔵 **Root Cause & Fix**: Node 17+ defaults to binding `localhost` to IPv6 (`::1`), while hardcoding `127.0.0.1` inside the launch script forces Chrome to strictly look for IPv4. By switching the launch script to call `http://localhost:$PORT`, Chrome resolves IPv6/IPv4 natively. <!-- id: a8365c1f-da97-4d03-99df-bdb57046c010 -->
  - [x] 🔵 Fix issue where externaly dependent apis arent loading; could it be that we are not exporting .env as we are when running dev through next js dev script <!-- id: b49b5404-1102-4e5b-b05b-b908c53b8f20 -->
    - [x] 🔵 **Root Cause & Fix**: In standalone bash script execution for production (`next start`), environment variables from `.env` are sometimes not loaded into `process.env` automatically as they are via `next dev`. We solved this by explicitly sourcing the variables using `set -a` and `source .env` directly in `launch-ms.sh` prior to starting the process. <!-- id: 180f050b-3dce-4bc3-ab84-38ed4e6c387b -->
- **Research papers**:
  - **Weekly recommended subject review paper**:
    - [x] 🔵 Create scheduled task or API endpoint to query for highly cited review/survey papers matching current View topics. <!-- id: 56e9805c-819a-405c-a796-ae8a17e85a42 -->
    - [x] 🔵 Add a UI card/section in Views to highlight the weekly targeted review paper. <!-- id: e6096621-946c-4a8d-944b-92326f067727 -->
  - **Daily roundup of newly released papers**:
    - [x] 🔵 Create an API endpoint to fetch papers published within the last 24 hours matching specific view keywords. <!-- id: 7aeb9937-328a-4515-8ea1-03c920ecaea8 -->
    - [x] 🔵 Use existing `ResearchPaperCard.tsx` component to list these papers (pass custom title and API endpoint). <!-- id: 3310168b-fa53-4d2b-86af-2bb2a1c097c8 -->
    - [x] 🔵 Implement caching to avoid querying external APIs on every page load. <!-- id: 214805c5-a290-406f-ad76-26f12759876c -->
  - **Weekly roundup of recently released papers**:
    - [x] 🔵 Create an API endpoint to fetch top papers published within the last 7 days. <!-- id: 9620296f-53dc-458f-ace7-6e14dc480037 -->
    - [x] 🔵 Use existing `ResearchPaperCard.tsx` component highlighting top trending papers (pass custom title and API endpoint). <!-- id: aa07a27c-57d4-453f-a84c-96a60b152a92 -->
  - **Track seen/read papers**:
    - [x] 🔵 Update Prisma schema: add a tracking model with fields for `paperId`, `readStatus`, and `viewedAt`. <!-- id: 78f29b2e-2dc9-4c97-995b-5e9814038151 -->
    - [x] 🔵 Implement an API route (`POST /api/research/track`) to log paper views from the UI. <!-- id: aab17001-a218-4ef8-8c07-e61815f0c271 -->
    - [x] 🔵 Update paper card components to visually indicate if a paper has already been read. <!-- id: 02c40d02-3d7e-4bce-ac41-ce148c801714 -->
  - **Favoriting/saving papers (Read Later list)**:
    - [x] 🔵 Update Prisma schema to support user `ReadingLists` and `SavedPapers`. <!-- id: bd14182b-3331-4bba-9faa-62f8c1b0d1bd -->
    - [x] 🔵 Add a "Save for later" or "Favorite" button to research paper cards. <!-- id: 16694222-e44c-4969-8efe-b5705a5f9cc1 -->
    - [x] 🔵 Create a dedicated "Reading List" View or modal to browse saved papers. <!-- id: 4ddcc594-0f03-4247-8e3a-7e8135c134fd -->
  - **Historical paper of the week**:
    - [x] 🔵 Create an algorithm to find impactful historical papers (e.g., > 5 years old, high citations) for specific View topics. <!-- id: 0e653d9d-73ff-41fd-9c55-89e9ac75ef09 -->
    - [x] 🔵 Create a DB table/log of selected historical papers to prevent duplicate recommendations. <!-- id: 2ce2a764-664a-4357-92f6-3dc284db146f -->
    - [x] 🔵 Add a UI element to feature the "Historical Paper of the Week". <!-- id: 216a9052-a2c4-47b5-b694-9772b20dad00 -->
  - **Add papers manually via DOI/links**:
    - [x] 🔵 Create an input modal to accept DOI numbers or paper URLs. <!-- id: 94927551-d26e-40ee-bccf-d69a51d9f205 -->
    - [x] 🔵 Implement a backend API route to parse the DOI/URL and fetch paper metadata (e.g., via Crossref or Semantic Scholar API). <!-- id: 076885e1-b959-4a39-9c89-7166edb28da1 -->
    - [x] 🔵 Build a selection prompt to ask the user which View/reading list to add the paper to, including an option to create a new one. <!-- id: 2e580b11-cf66-4da7-bc9d-b97dd867ff08 -->
    - [x] 🔵 Setup a "Physics" View to track physics science news and papers, and save the fetched paper there. <!-- id: ba712512-ecf3-41c0-9bb3-85a18cf9cdd1 -->
- **Logs**:
  - **Route Request Logging**:
    - [x] 🔵 Create a centralized logging utility module (e.g., `utils/logger.ts`). <!-- id: c30a4867-6a6a-46fb-aefe-0c1353288a1d -->
    - [x] 🔵 Update all API routes to log incoming requests (method, endpoint, timestamps). <!-- id: 941c96de-46f6-45d0-bf49-1bcc1f34ac3a -->
    - [x] 🔵 Add logging to distinguish the data source: DB, external API, or Cache. <!-- id: e4161d0a-e86d-454c-b4a3-80df9610462d -->
  - **Cache Analytics**:
    - [x] 🔵 Enhance generic caching layers to attach TTL (Time-To-Live) and expiration details to the log payload. <!-- id: 1050941b-fb75-40d6-a839-9a220c7318fa -->
    - [x] 🔵 Build a dashboard View or terminal output that visuals cache hit rates and remaining TTLs for cached data. <!-- id: 7d5381fb-f12f-4b39-aa2d-6888d450791f -->

### API Integrations:
- **Arxiv API**: add the ability for any of the views or cards to fetch papers
- **Hugging face & Semantic Scholar Integration**:
  - [x] 🔵 Research HF Daily Papers API (`https://huggingface.co/api/daily_papers`) & Semantic Scholar Graph API (`https://api.semanticscholar.org/graph/v1/paper/batch`). <!-- id: 4a6f9de6-5678-4eca-bbf2-bb0c899b0e49 -->
  - [x] 🔵 Update `app/api/arxiv/route.ts` (or create new `app/api/research/route.ts`) to fetch Hugging Face papers first. <!-- id: e016a2c5-c06b-4238-ac33-7777eaddf58e -->
  - [x] 🔵 Extract ArXiv IDs from HF results, then batch query Semantic Scholar for `citationCount`, `authors`, and `abstract`. <!-- id: 66de0a39-ac04-4d5d-8afa-d08f1aa02c3e -->
  - [x] 🔵 Map combined data into unified `Paper` objects (`id`, `title`, `summary`, `url`, `author`, `published_at`, `source`, `upvotes`, `citationCount`). <!-- id: 10012bab-ec98-4635-81b5-0ce96dd2f035 -->
  - [x] 🔵 Implement robust caching in the endpoint to avoid strict rate limits. <!-- id: 010053b9-fc3d-4e82-b8fc-da3ca0673630 -->
  - [x] 🔵 Update `ResearchPaperCard.tsx` to display `citationCount` and `upvotes` visually. <!-- id: 30563d3c-79af-477b-806b-c9b99acfd565 -->
  - [x] 🔵 Update `AIView.tsx` to query new endpoints for "Top Yesterday" and "Top Last Week". <!-- id: aa895f42-8650-4b3c-b05f-f42fa9c32165 -->

- [ ] 🟡 Fix issue where two different frontend sessions interfere with each other <!-- id: 3b5d8d11-3b99-4291-b322-53601ef1bb1a -->