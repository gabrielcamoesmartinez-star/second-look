// Fails if anything that looks like a server secret ends up in the web build.
// Run after `pnpm --filter @second-look/web build`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'apps/web/dist');
const patterns = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic API key'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key (PageSpeed)'],
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/"role"\s*:\s*"service_role"/, 'Supabase service_role JWT payload'],
  [/SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY|PAGESPEED_API_KEY|IP_HASH_SALT/, 'secret variable name'],
];
// Also decode any JWTs in the bundle and reject a service_role one.
const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
let failures = [];
for (const file of walk(dist)) {
  const text = readFileSync(file, 'utf8');
  for (const [re, label] of patterns) if (re.test(text)) failures.push(`${file}: ${label}`);
  for (const jwt of text.match(jwtRe) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
      if (payload.role === 'service_role') failures.push(`${file}: service_role JWT`);
    } catch {}
  }
}
if (failures.length) {
  console.error('Secrets found in client bundle:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('No secrets found in apps/web/dist');
