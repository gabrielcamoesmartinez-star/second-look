// Fails if anything that looks like a server-side secret ends up in the web build.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'apps/web/dist';
if (!existsSync(dir)) {
  console.error(`No build found at ${dir}. Run "pnpm --filter @second-look/web build" first.`);
  process.exit(1);
}
const patterns = [
  /sk-ant-[A-Za-z0-9_-]{10,}/, // Anthropic keys
  /service_role/, // Supabase service role JWT claim
  /SUPABASE_SERVICE_ROLE_KEY/,
  /ANTHROPIC_API_KEY/,
  /PAGESPEED_API_KEY/,
  /AIza[0-9A-Za-z_-]{30,}/, // Google API keys
];
const hits = [];
const walk = (p) => {
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    if (statSync(full).isDirectory()) walk(full);
    else {
      const text = readFileSync(full, 'utf8');
      for (const re of patterns) if (re.test(text)) hits.push(`${full}: ${re}`);
    }
  }
};
walk(dir);
if (hits.length) {
  console.error('Possible secrets in the client bundle:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('No secrets found in the client bundle.');
