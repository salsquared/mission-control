/**
 * Hermetic smoke: docs/apis.html must be in sync with the route code.
 *
 *   npx tsx scripts/tests/hermetic/api-docs-smoke.ts
 *
 * Delegates to the generator's --check mode (which compares a fresh render
 * against the committed docs/apis.html, ignoring the informational date line).
 * This is the gate that keeps the API reference from ever going stale: change
 * a route's methods / auth / cache / request schema and forget to run
 * `npm run gen:api-docs`, and this fails the push.
 *
 * Fully hermetic — the generator only reads files + imports pure Zod schema
 * modules; no network, no PM2, no DB.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
try {
  execFileSync('npx', ['tsx', 'scripts/gen-api-docs.ts', '--check'], { cwd: ROOT, stdio: 'inherit' });
  console.log('[PASS] docs/apis.html is in sync with app/api/**/route.ts');
} catch {
  console.error('[FAIL] docs/apis.html is stale — run: npm run gen:api-docs (then commit docs/apis.html)');
  process.exit(1);
}
