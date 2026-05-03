# DB as Source of Truth — Implementation Plan

> **Goal:** Solve the cross-device desync permanently. The DB becomes the ground truth for tasks; the markdown file becomes a read/write *view* of the DB; every connected client (phone, Mac mini, any browser tab) reflects mutations in near-real-time via server-pushed events.

---

## The Inversion

Today's data flow:

```
Markdown file ──parse──▶ DB ──read──▶ Dashboard
Dashboard ──PATCH──▶ Markdown file ──re-parse──▶ DB
```

Every mutation writes the **file first**, then the DB catches up. Two clients polling at different times see different snapshots, and the optimistic UI on each tab makes it worse.

**New model:**

```
Dashboard ──PATCH──▶ DB ──SSE event──▶ All clients
                       │
                       └──▶ Markdown file (async regenerate)

Markdown file ──fs.watch──▶ DB ──SSE event──▶ All clients
```

The DB is the single source of truth. The markdown file is regenerated from the DB after every mutation (so you can still view/edit in your editor). When you edit the markdown directly, `fs.watch` picks up the change, diffs it against the DB, and syncs the deltas back — which then triggers an SSE event to all clients.

---

## Architecture: Three Components

### 1. SSE Event Bus (`lib/events.ts`)

A simple in-process pub/sub, identical in spirit to your existing logger ring buffer pattern. No new dependencies.

```typescript
// lib/events.ts
type EventListener = (event: ServerEvent) => void;

interface ServerEvent {
  model: 'Task' | 'Setting' | 'Goal' | 'Application';
  action: 'invalidate' | 'upsert' | 'delete';
  id?: string;
  timestamp: number;
}

const listeners = new Set<EventListener>();

export function broadcastEvent(event: ServerEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribe(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
```

**SSE endpoint:** `app/api/events/route.ts`

```typescript
// app/api/events/route.ts
export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const unsub = subscribe((event) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      });
      // Heartbeat every 30s to keep the connection alive
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 30_000);
      // Cleanup on close
      controller.enqueue(encoder.encode(': connected\n\n'));
      // Store cleanup refs for when the connection closes
      (controller as any).__cleanup = () => {
        unsub();
        clearInterval(heartbeat);
      };
    },
    cancel(controller: any) {
      controller.__cleanup?.();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

This follows the exact same pattern as `/api/system/logs` — it's the system you already know.

### 2. Mutation Routes Become DB-First

**Current `PATCH /api/tasks`:**
1. Find task in DB
2. Rewrite the markdown file line
3. Update the DB

**New `PATCH /api/tasks`:**
1. Update the DB (this is now the commit point)
2. Broadcast `{ model: 'Task', action: 'upsert', id }` via the event bus
3. Trigger an async markdown regeneration (non-blocking)

```typescript
// Simplified new PATCH handler
export async function PATCH(req: Request) {
  const unlock = await writeMutex.lock();
  try {
    const { id, status, text, dueDate, priority } = await req.json();

    // 1. DB is the commit — this is the source of truth now
    const updatedTask = await prisma.task.update({
      where: { id },
      data: { status, text, dueDate, priority },
    });

    // 2. Tell every connected client
    broadcastEvent({ model: 'Task', action: 'upsert', id, timestamp: Date.now() });

    // 3. Async: regenerate the markdown file from DB state
    regenerateMarkdownFromDB().catch(console.error);

    return NextResponse.json({ task: updatedTask });
  } finally {
    unlock();
  }
}
```

The `POST` (create task) handler follows the same pattern: insert into DB first, broadcast, regenerate markdown.

### 3. File Watcher for Editor-Side Changes (`lib/tasks/watcher.ts`)

This is the piece that makes editing `docs/todo.md` in VS Code or Vim still work. It runs inside your existing Next.js process — **no separate service needed**.

```typescript
// lib/tasks/watcher.ts
import { watch } from 'fs';
import { debounce } from './utils'; // or inline a 500ms debounce
import { syncFileChangesToDB } from './parser';
import { broadcastEvent } from '@/lib/events';

let ignoreNextChange = false;

// Called by regenerateMarkdownFromDB() to suppress the echo
export function suppressNextFileChange() {
  ignoreNextChange = true;
}

export function startFileWatcher(filePath: string) {
  const handler = debounce(async () => {
    if (ignoreNextChange) {
      ignoreNextChange = false;
      return;
    }
    console.info('[FILE WATCHER] docs/todo.md changed externally, syncing to DB');
    await syncFileChangesToDB(filePath);
    broadcastEvent({ model: 'Task', action: 'invalidate', timestamp: Date.now() });
  }, 500);

  watch(filePath, { persistent: false }, handler);
  console.info('[FILE WATCHER] Watching docs/todo.md for external edits');
}
```

Started from `instrumentation.ts`:

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initLogger } = await import('./lib/logger');
    initLogger();

    const { startFileWatcher } = await import('./lib/tasks/watcher');
    startFileWatcher(path.join(process.cwd(), 'docs', 'todo.md'));
  }
}
```

> [!IMPORTANT]
> **No separate service needed.** `fs.watch` is a kernel-level file notification (FSEvents on macOS). It uses zero CPU when idle and fires within ~100ms of a file save. It lives inside the same Node process that already runs your server. This is the right tool — `chokidar` or `fs.watchFile` (polling) would be heavier alternatives you don't need.

---

## The Markdown Regeneration Function

This is the inverse of your current parser. Instead of **parsing** the markdown into DB rows, it **renders** DB rows back into markdown, preserving the file's section structure.

Two strategies, in order of simplicity:

### Strategy A: Line-level patching (recommended to start)

Keep the existing `todo.md` structure. When the DB changes, read the file, find the line with `<!-- id: XYZ -->`, and rewrite just that line to match the DB state. This preserves headers, notes, and formatting.

```typescript
async function regenerateMarkdownFromDB() {
  suppressNextFileChange(); // prevent echo
  const tasks = await prisma.task.findMany();
  const content = await fs.readFile(TODO_FILE, 'utf8');
  const lines = content.split('\n');

  for (const task of tasks) {
    const idx = lines.findIndex(l => l.includes(`<!-- id: ${task.id} -->`));
    if (idx !== -1) {
      lines[idx] = renderTaskLine(task, lines[idx]); // preserve indent
    }
  }

  await fs.writeFile(TODO_FILE, lines.join('\n'));
}
```

This is essentially what your current `PATCH` handler already does — the code in [route.ts lines 73–136](file:///Users/sal/salsquared/mission-control/app/api/tasks/route.ts#L73-L136). You'd extract it into a reusable function.

### Strategy B: Full file regeneration (future option)

If you later want the DB to fully own the structure (reordering tasks, adding/removing sections), you'd write a full renderer that produces the entire markdown from DB state. More powerful, but you lose manually-added formatting.

---

## Frontend: SSE Client Hook

A small hook that every view can use to know when to refetch:

```typescript
// hooks/useServerEvents.ts
import { useEffect } from 'react';

type Model = 'Task' | 'Setting' | 'Goal' | 'Application';

export function useServerEvents(model: Model, onInvalidate: () => void) {
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data);
      if (event.model === model) {
        onInvalidate();
      }
    };
    return () => es.close();
  }, [model, onInvalidate]);
}
```

Usage in PlanningView:

```tsx
const [refreshKey, setRefreshKey] = useState(0);

useServerEvents('Task', () => setRefreshKey(k => k + 1));

// existing fetch logic uses refreshKey as a dependency
```

If you later adopt SWR (critique option 5.1a), this becomes even cleaner:

```tsx
const { data, mutate } = useSWR('/api/tasks', fetcher);
useServerEvents('Task', () => mutate()); // refetch on server event
```

---

## What Changes, What Doesn't

| Component | Today | After |
|---|---|---|
| **`GET /api/tasks`** | Checks file mtime, re-parses if changed, returns DB rows | Just returns DB rows (file watcher handles sync) |
| **`PATCH /api/tasks`** | Writes file → updates DB | Updates DB → broadcasts SSE → async file regen |
| **`POST /api/tasks`** | Writes file → re-syncs DB | Inserts DB → broadcasts SSE → async file regen |
| **`docs/todo.md`** | Source of truth | Derived view; still editable, changes sync back via watcher |
| **Task IDs** | Injected as `<!-- id: ... -->` in markdown | Still injected, still the link between file lines and DB rows |
| **`lib/tasks/parser.ts`** | Called on every GET when mtime changes | Called by the file watcher when the file is edited externally |
| **Frontend (PlanningView)** | `useEffect` + `fetch` on mount + manual reload | Same fetch, but also listens to SSE for automatic refresh |
| **Phone / second device** | Desyncs, loses changes | Gets SSE events, stays in sync |
| **`instrumentation.ts`** | Just inits the logger | Also starts the file watcher |

---

## Answering Your Question: Separate Service or Server Routine?

**Server routine. No separate service.**

Here's why it works within your existing process:

1. **`fs.watch`** uses macOS FSEvents — it's a kernel callback, not a polling loop. Zero CPU cost when idle.
2. **The SSE event bus** is an in-memory `Set<listener>`, exactly like your existing logger subscriber pattern.
3. **The file regeneration** is a small async write that already happens today (your PATCH handler already rewrites the file).
4. **The Mutex** you already have serializes file writes, preventing the watcher and the regenerator from racing.

The only scenario where a separate service would make sense is if you wanted the watcher to survive a Next.js crash/restart independently — but PM2 already restarts the process, and the watcher re-initializes on startup.

---

## Implementation Order

1. **`lib/events.ts`** — the event bus (~20 lines)
2. **`app/api/events/route.ts`** — the SSE endpoint (~30 lines)
3. **Flip `PATCH /api/tasks`** — DB-first, then broadcast, then async file regen
4. **Flip `POST /api/tasks`** — same pattern
5. **Flip `GET /api/tasks`** — remove the mtime check, just read DB
6. **`lib/tasks/watcher.ts`** — file watcher for editor changes (~30 lines)
7. **Wire into `instrumentation.ts`** — start the watcher on boot
8. **`hooks/useServerEvents.ts`** — frontend SSE hook
9. **Wire into PlanningView** — listen for Task invalidations

Steps 1–5 are the core flip. Steps 6–7 restore the "edit in VS Code" workflow. Steps 8–9 give you live cross-device sync.

> [!TIP]
> This pairs naturally with critique options **5.1a/b** (SWR or TanStack Query) and **5.3b** (SSE invalidation). Once the event bus exists, extending it to `Setting`, `Goal`, and `Application` models is trivial — just add `broadcastEvent()` calls to those routes.
