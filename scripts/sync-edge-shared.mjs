// Edge Functions run on Deno and can only import files inside supabase/functions.
// This copies the shared validation code there (adding Deno's explicit .ts extensions)
// so the browser, the API and the worker all use exactly the same rules.
// Run with --check in CI to fail if the copies are out of date.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const files = ['ip.ts', 'url.ts', 'errors.ts'];
const check = process.argv.includes('--check');
let stale = [];
for (const f of files) {
  const src = readFileSync(`packages/shared/src/${f}`, 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.ts'");
  const out = `// GENERATED from packages/shared/src/${f} by scripts/sync-edge-shared.mjs. Do not edit.\n${src}`;
  const dest = `supabase/functions/_shared/${f}`;
  if (check) {
    if (!existsSync(dest) || readFileSync(dest, 'utf8') !== out) stale.push(dest);
  } else writeFileSync(dest, out);
}
if (check && stale.length) {
  console.error('Out of date, run "node scripts/sync-edge-shared.mjs":\n' + stale.join('\n'));
  process.exit(1);
}
console.log(check ? 'Edge shared files are up to date.' : 'Synced edge shared files.');
