#!/usr/bin/env tsx
/**
 * API-doc generator — emits `docs/apis.html` from code truth.
 *
 *   npx tsx scripts/gen-api-docs.ts          # write docs/apis.html
 *   npx tsx scripts/gen-api-docs.ts --check  # exit 1 if the file is stale (CI)
 *
 * WHY: the hand-maintained `docs/apis.md` drifted from reality on every route
 * change. This reads the structural facts straight from `app/api/**\/route.ts`
 * so they can never be stale, and pulls only the un-inferable INTENT prose from
 * a colocated `export const apiMeta` (see `lib/api-docs/meta.ts`).
 *
 * Everything is STATIC AST analysis (routes are never executed — they import
 * Prisma/auth/etc. and have import-time side effects). The single exception is
 * Zod schemas: those modules are pure (`import { z } from 'zod'`) so we import
 * them standalone and call `z.toJSONSchema()` to render the request shape.
 */
import * as ts from 'typescript';
import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const ROOT = resolve(__dirname, '..');
const API_DIR = join(ROOT, 'app', 'api');
const OUT = join(ROOT, 'docs', 'apis.html');
const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
type Method = (typeof HTTP_METHODS)[number];

// ── Section grouping ─────────────────────────────────────────────────────────
// Routes group by their first path segment under /api. Nicer titles here;
// anything unlisted falls back to Title Case of the segment.
const SECTION_TITLES: Record<string, string> = {
  auth: 'Auth', events: 'Realtime / Events', tasks: 'Planning', goals: 'Planning',
  calendar: 'Planning', applications: 'Job Tracker', postings: 'Job Tracker',
  watchlists: 'Job Tracker', blacklist: 'Job Tracker', discovery: 'Job Tracker',
  profile: 'Profile / Resumes', resumes: 'Profile / Resumes', settings: 'Settings',
  gmail: 'Gmail Integration', notifications: 'Notifications', ai: 'AI Dashboard',
  research: 'AI Dashboard', 'company-news': 'News', finance: 'Finance Dashboard',
  space: 'Space Dashboard', system: 'Internal Systems',
};
const SECTION_ORDER = ['Auth', 'Realtime / Events', 'Planning', 'Job Tracker',
  'Profile / Resumes', 'Settings', 'Gmail Integration', 'Notifications',
  'AI Dashboard', 'News', 'Finance Dashboard', 'Space Dashboard', 'Internal Systems'];

// ── Types ────────────────────────────────────────────────────────────────────
interface SchemaRef { local: string; module: string | null } // module = resolved import specifier
interface MethodInfo {
  method: Method;
  guard: string | null;        // requireSession | requireLocalOrSession | getServerSession | null
  cache: { ttlSeconds: number | null; upstreamHost: string | null } | null;
  schemas: SchemaRef[];        // Zod schemas .parse/.safeParse'd in this method's body
}
interface RouteInfo {
  routePath: string;           // /api/foo/{id}
  file: string;                // repo-relative
  section: string;
  methods: MethodInfo[];
  meta: ApiMetaLiteral | null;
}
interface ApiMetaLiteral {
  purpose?: string;
  external?: string[];
  notes?: string;
  methods?: Record<string, { purpose?: string; external?: string[] }>;
}

// ── File discovery ───────────────────────────────────────────────────────────
function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findRouteFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

function routePathFromFile(file: string): string {
  const rel = relative(API_DIR, file).replace(/\/route\.ts$/, '').replace(/route\.ts$/, '');
  const segs = rel.split('/').filter(Boolean).map((s) =>
    s.replace(/^\[\.\.\.(.+)\]$/, '{...$1}').replace(/^\[(.+)\]$/, '{$1}'));
  return '/api' + (segs.length ? '/' + segs.join('/') : '');
}

function sectionFor(routePath: string): string {
  const seg = routePath.split('/').filter(Boolean)[1] ?? 'misc';
  return SECTION_TITLES[seg] ?? seg.replace(/(^|[-/])(\w)/g, (_, b, c) => (b === '-' ? ' ' : b) + c.toUpperCase());
}

// ── Static evaluation of an `apiMeta` object literal ─────────────────────────
type Resolver = (name: string) => ts.Expression | undefined;
function evalLiteral(node: ts.Expression, resolve?: Resolver): unknown {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => evalLiteral(e, resolve));
  if (ts.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null;
        if (key) obj[key] = evalLiteral(p.initializer, resolve);
      }
    }
    return obj;
  }
  // Resolve a top-level `const X = <literal>` reference (e.g. cache TTL consts).
  if (ts.isIdentifier(node) && resolve) { const r = resolve(node.text); if (r) return evalLiteral(r, resolve); }
  // Template with no substitutions, or anything else: best-effort raw text.
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

// Read the colocated `meta.ts` (sibling of route.ts) and statically evaluate
// its `export const apiMeta = {...}` literal. Returns null if absent.
function readSidecarMeta(routeFile: string): ApiMetaLiteral | null {
  const metaFile = join(dirname(routeFile), 'meta.ts');
  let text: string;
  try { text = readFileSync(metaFile, 'utf8'); } catch { return null; }
  const sf = ts.createSourceFile(metaFile, text, ts.ScriptTarget.Latest, true);
  let init: ts.Expression | undefined;
  sf.forEachChild((n) => {
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.name.text === 'apiMeta' && d.initializer) init = d.initializer;
  });
  return init ? ((evalLiteral(init) as ApiMetaLiteral) ?? null) : null;
}

// ── Per-file AST analysis ────────────────────────────────────────────────────
function analyzeFile(file: string): RouteInfo {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  // import map: local identifier -> module specifier
  const imports = new Map<string, string>();
  src.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = n.moduleSpecifier.text;
      const b = n.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) for (const el of b.elements) imports.set(el.name.text, mod);
      if (n.importClause?.name) imports.set(n.importClause.name.text, mod);
    }
  });

  // top-level const initializers, so `export const GET = ...` and the
  // `cachedGET = withCache(...)` indirection can be resolved.
  const topConsts = new Map<string, ts.Expression>();
  src.forEachChild((n) => {
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer) topConsts.set(d.name.text, d.initializer);
  });

  // Find a withCache(handler, opts) / withSharedCache(handler, opts) call anywhere
  // and extract its config. Both take the same { ttlSeconds, upstreamHost } shape;
  // withSharedCache (lib/research/shared-cache.ts) is the cross-tier variant used
  // by the research routes. (Cached routes only ever wrap GET.)
  let cache: MethodInfo['cache'] = null;
  const visitForCache = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'withCache' || n.expression.text === 'withSharedCache')) {
      const arg = n.arguments[1];
      const resolver: Resolver = (name) => topConsts.get(name);
      if (arg && (ts.isNumericLiteral(arg) || ts.isIdentifier(arg))) {
        const v = evalLiteral(arg, resolver);
        cache = { ttlSeconds: typeof v === 'number' ? v : null, upstreamHost: null };
      } else if (arg && ts.isObjectLiteralExpression(arg)) {
        const o = evalLiteral(arg, resolver) as Record<string, unknown>;
        cache = {
          ttlSeconds: typeof o.ttlSeconds === 'number' ? o.ttlSeconds : null,
          upstreamHost: typeof o.upstreamHost === 'string' ? o.upstreamHost : null, // dynamic host fns -> null
        };
      }
    }
    n.forEachChild(visitForCache);
  };
  visitForCache(src);

  // apiMeta literal — lives in a sibling `meta.ts` (NOT route.ts: Next.js
  // validates route module exports, so an `apiMeta` export there is a build
  // error; the sidecar escapes that while staying colocated).
  const meta = readSidecarMeta(file);

  // Analyze one method body for guard + schema usage.
  const analyzeBody = (body: ts.Node | undefined): Pick<MethodInfo, 'guard' | 'schemas'> => {
    const schemas: SchemaRef[] = [];
    let guard: string | null = null;
    const seen = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        // guard: any identifier imported from lib/auth-guards that's invoked
        // (requireSession, requireLocalOrSession, requireSessionOrService, …),
        // plus the inline getServerSession escape hatch.
        if (ts.isIdentifier(n.expression)) {
          const g = n.expression.text;
          if (g === 'getServerSession' || /auth-guards/.test(imports.get(g) ?? '')) guard ??= g;
        }
        // schema: X.safeParse(...) / X.parse(...) where X is an imported Schema id
        if (ts.isPropertyAccessExpression(n.expression) &&
            (n.expression.name.text === 'safeParse' || n.expression.name.text === 'parse') &&
            ts.isIdentifier(n.expression.expression)) {
          const local = n.expression.expression.text;
          const mod = imports.get(local) ?? null;
          // only treat as a Zod schema if it's imported from a schemas module or named *Schema
          if ((mod && /schemas/.test(mod)) || /Schema$/.test(local)) {
            if (!seen.has(local)) { seen.add(local); schemas.push({ local, module: mod }); }
          }
        }
      }
      n.forEachChild(visit);
    };
    if (body) visit(body);
    return { guard, schemas };
  };

  // Resolve a method export to its underlying function body, following one
  // level of `export const GET = cachedGET`-style indirection if needed.
  const bodyFor = (init: ts.Node): ts.Node | undefined => {
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
    if (ts.isIdentifier(init)) { const t = topConsts.get(init.text); return t ? bodyFor(t) : undefined; }
    return undefined;
  };

  const methods: MethodInfo[] = [];
  src.forEachChild((n) => {
    const isExported = (mods?: ts.NodeArray<ts.ModifierLike>) =>
      mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    // export [async] function GET() {}
    if (ts.isFunctionDeclaration(n) && n.name && isExported(n.modifiers) &&
        (HTTP_METHODS as readonly string[]).includes(n.name.text)) {
      const m = n.name.text as Method;
      methods.push({ method: m, cache: m === 'GET' ? cache : null, ...analyzeBody(n.body) });
    }
    // export const GET = ...
    if (ts.isVariableStatement(n) && isExported(n.modifiers)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && (HTTP_METHODS as readonly string[]).includes(d.name.text) && d.initializer) {
          const m = d.name.text as Method;
          methods.push({ method: m, cache: m === 'GET' ? cache : null, ...analyzeBody(bodyFor(d.initializer)) });
        }
      }
    }
  });

  const routePath = routePathFromFile(file);
  methods.sort((a, b) => HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method));
  return { routePath, file: relative(ROOT, file), section: sectionFor(routePath), methods, meta };
}

// ── Zod schema → JSON Schema (the one place we import code) ───────────────────
async function resolveSchemas(routes: RouteInfo[]): Promise<Map<string, unknown>> {
  const wanted = new Map<string, SchemaRef>(); // key `${module}#${local}`
  for (const r of routes) for (const m of r.methods) for (const s of m.schemas)
    if (s.module) wanted.set(`${s.module}#${s.local}`, s);

  // group by module so each is imported once
  const byModule = new Map<string, string[]>();
  for (const { local, module } of wanted.values())
    if (module) byModule.set(module, [...(byModule.get(module) ?? []), local]);

  const out = new Map<string, unknown>();
  for (const [module, names] of byModule) {
    const spec = module.startsWith('@/') ? join(ROOT, module.slice(2))
      : module.startsWith('.') ? null  // relative imports resolved per-route below
      : module;
    if (!spec) continue;
    let mod: Record<string, unknown>;
    try { mod = await import(spec); } catch (e) { console.warn(`  ⚠ import failed: ${module} (${(e as Error).message})`); continue; }
    for (const name of names) {
      const schema = mod[name];
      if (!schema || !(schema instanceof z.ZodType)) continue;
      // io:'input' = the shape a CLIENT sends (pre-transform/coerce) — exactly
      // what a request-body doc wants, and it survives .transform()/.coerce.
      try { out.set(`${module}#${name}`, z.toJSONSchema(schema as z.ZodType, { io: 'input' })); }
      catch (e) { console.warn(`  ⚠ toJSONSchema failed: ${name} (${(e as Error).message})`); }
    }
  }
  return out;
}

// Relative-import schemas (`../../../lib/schemas/x`) resolved against the route file.
async function resolveRelativeSchemas(routes: RouteInfo[], jsonSchemas: Map<string, unknown>) {
  for (const r of routes) {
    for (const m of r.methods) for (const s of m.schemas) {
      if (!s.module || !s.module.startsWith('.')) continue;
      const key = `${s.module}#${s.local}`;
      if (jsonSchemas.has(key)) continue;
      const abs = resolve(ROOT, r.file, '..', s.module);
      try {
        const mod = await import(abs);
        const schema = mod[s.local];
        if (schema instanceof z.ZodType) jsonSchemas.set(key, z.toJSONSchema(schema as z.ZodType, { io: 'input' }));
      } catch { /* skip — surfaced as "schema unavailable" in output */ }
    }
  }
}

// ── HTML rendering ───────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const METHOD_CLASS: Record<Method, string> = { GET: 'get', POST: 'post', PATCH: 'patch', PUT: 'put', DELETE: 'delete' };

function renderRoute(r: RouteInfo, jsonSchemas: Map<string, unknown>): string {
  const badges = r.methods.map((m) => `<span class="api-method ${METHOD_CLASS[m.method]}">${m.method}</span>`).join('');
  const purpose = r.meta?.purpose;
  const external = r.meta?.external ?? [];

  // chips: auth (union across methods) + cache
  const guards = [...new Set(r.methods.map((m) => m.guard).filter(Boolean))] as string[];
  const cache = r.methods.find((m) => m.cache)?.cache ?? null;
  const chips: string[] = [];
  for (const g of guards) chips.push(`<span class="api-chip auth">${esc(g)}</span>`);
  if (cache) chips.push(`<span class="api-chip cache">cache ${cache.ttlSeconds ?? '?'}s${cache.upstreamHost ? ` · ${esc(cache.upstreamHost)}` : ''}</span>`);
  for (const x of external) chips.push(`<span class="api-chip ext">${esc(x)}</span>`);

  // request schemas
  const schemaBlocks: string[] = [];
  const seen = new Set<string>();
  for (const m of r.methods) for (const s of m.schemas) {
    const key = `${s.module}#${s.local}`;
    if (seen.has(s.local)) continue;
    seen.add(s.local);
    const js = jsonSchemas.get(key);
    if (js) schemaBlocks.push(
      `<p class="api-schema-label">${m.method} body — <code>${esc(s.local)}</code></p>` +
      `<pre><code class="language-json">${esc(JSON.stringify(js, null, 2))}</code></pre>`);
    else schemaBlocks.push(`<p class="api-schema-label">${m.method} body — <code>${esc(s.local)}</code> <span class="api-muted">(schema unavailable)</span></p>`);
  }

  return [
    `<div class="api-route" id="${esc(r.routePath)}">`,
    `  <div class="api-route-head">${badges}<code class="api-path">${esc(r.routePath)}</code></div>`,
    chips.length ? `  <div class="api-chips">${chips.join('')}</div>` : '',
    purpose ? `  <p class="api-purpose">${esc(purpose)}</p>`
            : `  <p class="api-purpose api-muted">⚠ No <code>apiMeta</code> — add a sibling <code>${esc(r.file.replace(/route\.ts$/, 'meta.ts'))}</code></p>`,
    r.meta?.notes ? `  <p class="api-notes">${esc(r.meta.notes)}</p>` : '',
    ...schemaBlocks.map((b) => '  ' + b),
    `  <p class="api-src"><code>${esc(r.file)}</code></p>`,
    `</div>`,
  ].filter(Boolean).join('\n');
}

function renderHtml(routes: RouteInfo[], jsonSchemas: Map<string, unknown>, generatedAt: string): string {
  const bySection = new Map<string, RouteInfo[]>();
  for (const r of routes) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  const sections = [...bySection.keys()].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a), ib = SECTION_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

  const total = routes.length;
  const documented = routes.filter((r) => r.meta?.purpose).length;

  const toc = sections.map((s) => `      <li><a href="#sec-${esc(s.replace(/\W+/g, '-'))}">${esc(s)}</a></li>`).join('\n');

  const body = sections.map((s) => {
    const rs = bySection.get(s)!.sort((a, b) => a.routePath.localeCompare(b.routePath));
    return [
      `  <details class="section" open>`,
      `    <summary><h2 id="sec-${esc(s.replace(/\W+/g, '-'))}">${esc(s)}</h2></summary>`,
      `    <div class="section-body">`,
      rs.map((r) => renderRoute(r, jsonSchemas)).join('\n\n'),
      `    </div>`,
      `  </details>`,
    ].join('\n');
  }).join('\n\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>API Reference</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./assets/style.css">
</head>
<body>

  <h4 class="kicker">mission-control</h4>
  <h1>API Reference</h1>
  <p class="subtitle"><strong>Generated — do not edit by hand.</strong> Run <code>npm run gen:api-docs</code> to regenerate from <code>app/api/**/route.ts</code>. Structural facts (methods, auth, cache, request schema) are read from the code; the one-line purpose + external-service list come from each route's <code>export const apiMeta</code> (see <code>lib/api-docs/meta.ts</code>). Generated ${esc(generatedAt)} · ${documented}/${total} routes documented.</p>

  <details class="section no-count toc" open>
    <summary><h3>Contents</h3></summary>
    <ol class="toc-list">
${toc}
    </ol>
  </details>

${body}

  <footer class="doc-footer">
    &copy; <span id="copyright-year">2026</span> salsquared. All rights reserved.
  </footer>

<script type="module">
  import hljs from 'https://cdn.jsdelivr.net/npm/highlight.js@11/+esm';
  hljs.highlightAll();
  document.getElementById('copyright-year').textContent = new Date().getFullYear();
</script>
</body>
</html>
`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const check = process.argv.includes('--check');
  const files = findRouteFiles(API_DIR).sort();
  const routes = files.map(analyzeFile);

  const jsonSchemas = await resolveSchemas(routes);
  await resolveRelativeSchemas(routes, jsonSchemas);

  // Deterministic timestamp source: git is unavailable here; use a fixed
  // placeholder so --check doesn't churn on the date. The date is informational.
  const generatedAt = new Date().toISOString().slice(0, 10);
  const html = renderHtml(routes, jsonSchemas, generatedAt);

  const documented = routes.filter((r) => r.meta?.purpose).length;
  const undocumented = routes.filter((r) => !r.meta?.purpose);

  if (check) {
    let current = '';
    try { current = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    // Compare ignoring the date line (informational, changes daily).
    const strip = (s: string) => s.replace(/Generated \d{4}-\d{2}-\d{2}/, 'Generated <date>');
    if (strip(current) !== strip(html)) {
      console.error('✗ docs/apis.html is stale. Run: npm run gen:api-docs');
      process.exit(1);
    }
    console.log('✓ docs/apis.html is up to date.');
    return;
  }

  writeFileSync(OUT, html);
  console.log(`✓ Wrote ${relative(ROOT, OUT)} — ${routes.length} routes, ${documented} documented.`);
  if (undocumented.length) {
    console.log(`\n  ${undocumented.length} route(s) missing apiMeta (add export const apiMeta):`);
    for (const r of undocumented) console.log(`    ${r.routePath}  (${r.file})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
