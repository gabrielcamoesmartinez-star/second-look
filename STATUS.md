# STATUS

Last updated: 2026-11-27

## Stage 1 — working path from start to finish · DONE (2026-11-27)

Live: https://second-look-pink.vercel.app (web on Vercel) · worker on Railway (EU West) · Supabase `zxogxazkzumsxpwwqlfx` (eu-west-3).

### "Done when", checked on the deployed environment
- [x] A signed-in user pastes a real public URL on the deployed site, watches the real steps progress, and sees real PageSpeed and SEO results. `gabrielmartinezdev.com`: complete in 19.3s; Performance 96, Accessibility 95 (real Google PageSpeed), search basics 57 (4/7 rules pass), mobile screenshot stored and shown.
- [x] A robots-blocked site produces the right error. `https://second-look-pink.vercel.app/robots-test` (our own robots.txt disallows SecondLookBot on that path) → failed with `blocked_by_robots` and the spec's copy.
- [x] A private IP produces the right error. `http://169.254.169.254` → refused by `create-audit` with "That address isn't a public website." No audit created, no quota used.
- [x] CI runs the unit, integration and RLS tests, and they pass (GitHub Actions green on `119040c`).

### Bugs found by the live run (fixed)
- **`__name is not defined` in the page.** tsx (production) compiles functions with esbuild's keepNames, which injects `__name()` calls. The candidate collector is sent into the browser as source, where that helper doesn't exist. Fixed by sending it inside a scope that defines a no-op `__name`. Regression test `test/tsxCollector.test.ts` runs the collector through tsx itself; it fails on the old code with the production error.
- **Worker image build.** The Node in Playwright 1.65's image has no corepack; pnpm is now installed with npm.

### Open follow-ups (small; not blocking)
- The report shows "0" for some PageSpeed rows that have no value (e.g. accessibility audits). It should show nothing. The design stage replaces this table anyway.
- The h1 evidence can be cut short when the page animates its heading (the screenshot and HTML are taken after load, mid-animation). Consider a short settle wait in Stage 2.
- Railway starts the worker with `pnpm start` rather than the Dockerfile CMD. Check that SIGTERM reaches node through pnpm (graceful-shutdown test on Railway), or set the start command to `node --import tsx src/main.ts`.
- Railway is on the free trial (30 days / $5 credit, 1 GB RAM), so `WORKER_CONCURRENCY=1`. Move to Hobby before the trial ends.
- Magic-link emails land in Gmail spam while the new sending domain warms up.

### What works (verified locally, against real software, not mocks)

| Piece | Evidence |
|---|---|
| Monorepo (pnpm workspaces, TS strict, `noUncheckedIndexedAccess`, no `any`) | `pnpm typecheck` passes for every package, the Edge Function handler and the tests |
| Schema, RLS, quota, job queue (`supabase/migrations/…_init.sql`) | 14 DB tests on real Postgres 16: A can't read B; anon sees nothing; users can't insert or update audits or call service functions; a share token exposes one report without `user_id`; per-user and per-IP quotas (and rollback when the IP limit is hit); `SKIP LOCKED` never double-claims across two connections; heartbeat ownership; stale re-queue; fail after 3 attempts; release on shutdown |
| `create-audit` Edge Function | 9 handler tests: 401 without or with a bad JWT; Zod body validation; URL normalisation; SSRF rejection (IP literals and DNS names that resolve private); salted IP hash from `x-forwarded-for`; quota and IP limit → 429 with the spec's copy; CORS |
| URL normalisation + SSRF IP checks | 76 shared unit tests, including IPv4/IPv6 private ranges, mapped/6to4/NAT64/Teredo, metadata IPs, and DNS rebinding on a second lookup |
| SEO rules (title, description, one h1, lang, LocalBusiness JSON-LD incl. `@graph` and subtypes, phone, address) | Unit tests against good and bad fixture HTML |
| Worker pipeline (fetch → PageSpeed → SEO) with real Chromium | 10 integration tests on local fixture sites: good site complete; bad site's SEO fails and its `169.254.169.254` image is refused; robots disallow → `blocked_by_robots`; slow site → `fetch_timeout`; redirect to metadata IP → `ssrf_blocked`; redirect loop → `too_many_redirects`; PageSpeed down → 3 attempts with `retrying` steps → `partial`, API key scrubbed from the stored error |
| Job runner | 4 tests: concurrency cap of 2; SIGTERM grace then release; abort on lost lock; crash → audit failed + job removed |
| Web app (magic-link login with sent/error/expired states; new-audit form with inline validation, https notice and quota; history with real status and failure reason; live Running page over Realtime with `attempt n of 3`, `aria-live` and screenshot; basic report with PageSpeed and SEO results) | Typechecks and builds. **Not exercised against a real Supabase project yet.** |
| No secrets in the client | CI builds with decoy service-role JWT, Anthropic and Google keys in the env, then scans `dist/`. Verified the scan catches a planted key. |
| Dependency audit | `pnpm audit --prod`: no known vulnerabilities (upgraded Playwright 1.49→1.65.1, Zod 3→4.6.7, React Router 6→7.18.6 to clear advisories) |

### Security bug found and fixed during testing
Chromium does **not** send redirect hops of an intercepted response back through Playwright's `route()`. A page that redirected to `169.254.169.254` was fetched by the browser directly. Fixed in two ways: (1) the worker follows every redirect itself and checks each hop; (2) Chromium starts with a dead proxy, so anything that slips past interception has no network at all. Covered by the redirect-to-metadata-IP and redirect-loop tests.

### Deployed setup
- **Supabase** `second-look` (ref `zxogxazkzumsxpwwqlfx`, eu-west-3). Both migrations applied. Checked live: RLS on all 9 tables, users can't insert audits or call queue functions, Realtime on `audits` and `audit_steps`, private `audit-artifacts` bucket. The security advisor's remaining notes are intentional (service-only tables with no policies; `get_shared_report` is the public share path). Auth Site URL and redirect point at the Vercel site.
- **Magic-link email:** custom SMTP through Resend from `login@mail.gabrielmartinezdev.com` (DNS on Hostinger).
- **`create-audit` Edge Function:** JWT verification on; secrets `IP_HASH_SALT` and `PUBLIC_SITE_URL=https://second-look-pink.vercel.app`. Runs under Deno in production.
- **Worker:** Railway, EU West, Dockerfile builder (settings live in the Railway dashboard; Railway no longer accepts config-as-code for new services). Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAGESPEED_API_KEY`, `PUBLIC_SITE_URL`, `WORKER_CONCURRENCY=1`.
- **Web:** Vercel project `second-look`, root `apps/web`, builds on push to `main`. Env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `AUDITS_PER_USER_PER_DAY=3`.

### Still not covered
- The integration tests still use `apps/worker/test/fixtures/psi-synthetic.json`, a hand-built response in the real API shape. Replace it with a recorded real response.
- There's no E2E (Playwright) test of the web app yet. That's Stage 3's "Done when".

### Known limits
- Robots.txt returning 5xx or unreachable is treated as **allowed** (RFC 9309 says disallow). This is deliberate for small-business sites and noted in `robots.ts`.
- The 10 MB cap applies to the HTML document. The whole page is capped at 40 MB.
- Sub-resource redirects are followed server-side, so a CSS file that redirects resolves its relative URLs against the original URL. This is cosmetic.
- Phone and address detection are regex heuristics (PT, UK and US formats).
- LocalBusiness subtype matching uses a fixed list of schema.org types. Unknown custom types fail the check.
- Realtime has a 10s polling fallback if the socket drops.
- The landing page is Stage 5. Until then `/` redirects to `/audits`.

### Next step
Stage 2: the 8-check enquiry checklist (rules + AI), Zod-validated model output with the retry path, marker boxes from the browser, scoring, the fix library, the summary, the AI budget guard and caching.

### Needed from Gabriel for Stage 2
1. **Anthropic API key**, plus a monthly **spending limit** set in the Anthropic Console (costs money).
2. **`DAILY_AI_BUDGET_USD`**: the daily cap for AI spend (e.g. $1–2).
3. Later, for evals: hand labels for the 15–20 snapshot sites (the label files will be left for you to fill in).

## Stage 2 — checklist, AI and scoring · NOT STARTED
## Stage 3 — product features · NOT STARTED
## Stage 4 — full design · NOT STARTED
## Stage 5 — landing page and launch · NOT STARTED
## Stage 6 — README and case study · NOT STARTED
