## Frontend Terminology & Composition

This document defines the core structural terminology and composition hierarchy for the frontend of Mission Control. This ensures consistency in file naming, component structure, and layout design.

### Hierarchy (Bottom-Up)

`UI` / `Widgets` < `Cards` / `Windows` < `Grids` < `Sections` < `Views` < `Dashboard`

---

### Component Definitions

1. **UI Components (`UI`)**
   - Base-level primitives (buttons, inputs, typographies).
   - Entirely generic and do not own structural layout responsibilities beyond their own box.

2. **Widgets (`Widgets`)**
   - Stand-alone, dynamic components.
   - They handle specific data display or interactions (e.g., a dynamic chart, a live countdown).
   - They do not dictate their container's structure, but they act as the "content payload".

3. **Cards (`Cards`)**
   - The parent containers for widgets and text.
   - Cards define the aesthetic and structural boundaries of a specific chunk of content.
   - They wrap widgets, provide padding, titles, actions, and consistent styling (like borders or backgrounds).

4. **Windows (`Windows`)**
   - Specialized, floating overlay Cards (e.g., AI Companion dialog).
   - They break out of the normal grid flow to provide draggable, maximizable, interactive overlays or floating content.
   - Like Cards, they serve as boundary wrappers that can contain Widgets and UI elements.

5. **Grids (`Grids`)**
   - The layout managers for cards.
   - Grids determine how multiple cards are arranged (e.g., responsive columns, CSS Grid layouts).
   - They do not contain intrinsic content or styling other than structural spacing/alignment.

6. **Sections (`Sections`)**
   - Thematic aggregations superimposed onto the dashboard.
   - A grid is placed within a section.
   - A section groups a specific domain or feature set (e.g., "Financial Overview Section", "Upcoming Launches Section").
   - Many dash sections can be placed in one view.

7. **Views (`Views`)**
   - The primary top-level entry point (the main "Card" or screen) where all information for a specific page resides.
   - A view aggregates multiple sections and manages top-level page state or context.
   - Examples: Space View, Finance View, AI View.

8. **Dashboard (`Dashboard`)**
   - The top-level Host Application Layer (the "Monitor").
   - Responsible for mounting global application state, animating/switching between Views, and managing global floating overlays (Windows).
   - Holds persistent root UI elements such as the unified navigation bar, launchpad, and background ambient glow.
