# STATUS

Last updated: 2026-11-20

## Stage 1 — working path from start to finish · NOT DONE (code complete and tested locally; not deployed)

Stage 1's "Done when" requires the deployed site. Nothing is deployed yet, so this stage is **not done**.

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

### Deployed so far (2026-11-25)
- **Supabase project** `second-look` (ref `zxogxazkzumsxpwwqlfx`, eu-west-3). Both migrations applied. Checked live: RLS on all 9 tables, users can't insert audits or call queue functions, Realtime on `audits` and `audit_steps`, private `audit-artifacts` bucket. The security advisor's remaining notes are all intentional (service-only tables with no policies; `get_shared_report` is the public share path).
- **Magic-link email:** custom SMTP through Resend from `login@mail.gabrielmartinezdev.com`. Test invite delivered (landed in spam; the new domain is still warming up).
- **Worker host:** Railway (EU West, Dockerfile builder; settings configured in the Railway dashboard because Railway no longer accepts config-as-code for new services).
- **`create-audit` Edge Function** deployed (v1, JWT verification on). Secrets `IP_HASH_SALT` and `PUBLIC_SITE_URL` are set. `PUBLIC_SITE_URL` is temporarily `http://localhost:5173` and changes when the web app is deployed. Live check: a call with the anon key returns 401 `unauthorized`, as it should.
- **PageSpeed API key** created (restricted to PageSpeed Insights API). Not yet set anywhere; it goes into the worker's env.

### What doesn't work yet, and why
- **Not deployed** (Supabase, Vercel, Fly): accounts and keys are needed from Gabriel (see below).
- **PageSpeed has not been called for real.** No API key yet. The integration tests use `apps/worker/test/fixtures/psi-synthetic.json`, a hand-built response in the real API shape. It is not a recorded response. Once a key exists, replace it with a real recorded one.
- **The Edge Function has not run under Deno.** Deno can't be installed in this build environment. The handler is runtime-agnostic and tested under Node; `index.ts` (the Deno wiring with `Deno.resolveDns`) is untested until `supabase functions serve`.
- **The Docker image hasn't been built.** No Docker daemon here. The Dockerfile uses the official `mcr.microsoft.com/playwright:v1.65.1-noble` image.
- **CI hasn't run on GitHub.** There's no repo yet. The workflow mirrors the commands that pass locally.
- **No E2E (Playwright) test of the web app.** That's Stage 3's "Done when". It needs a running Supabase.

### Known limits
- Robots.txt returning 5xx or unreachable is treated as **allowed** (RFC 9309 says disallow). This is deliberate for small-business sites and noted in `robots.ts`.
- The 10 MB cap applies to the HTML document. The whole page is capped at 40 MB.
- Sub-resource redirects are followed server-side, so a CSS file that redirects resolves its relative URLs against the original URL. This is cosmetic.
- Phone and address detection are regex heuristics (PT, UK and US formats).
- LocalBusiness subtype matching uses a fixed list of schema.org types. Unknown custom types fail the check.
- Realtime has a 10s polling fallback if the socket drops.
- Supabase's built-in email sender only delivers to your project team's addresses and is heavily rate-limited, so **public magic links need custom SMTP** (see below).
- The landing page is Stage 5. Until then `/` redirects to `/audits`.

### Next step
Gabriel provides the items below → `supabase db push` + deploy the function → deploy the worker to Fly → Vercel → run a real public URL on the deployed site, check a robots-blocked site and a private IP, record a real PageSpeed response for the fixtures, push to GitHub and get CI green. Then Stage 1 is done and Stage 2 starts.

### Needed from Gabriel
1. **Supabase project** (free tier is enough): project ref, URL, anon key, service-role key. Or run the deploy commands in the README yourself.
2. **Google PageSpeed Insights API key** (free): Google Cloud console → enable "PageSpeed Insights API" → create an API key, restricted to that API.
3. **SMTP for magic links**, so interviewers can sign in. For example, Resend's free tier: verify a domain and paste its SMTP settings into Supabase → Auth → SMTP.
4. **Worker hosting (costs money).** Fly.io (2 GB shared VM, billed monthly; check current pricing) or Railway. Which one, and approval for the spend.
5. **GitHub repo** to push to, so CI runs.
6. **Domain decision.** It's used in the bot user agent (`SecondLookBot/1.0 (+https://<domain>/bot)`) and the CORS origin. A `*.vercel.app` URL works until you pick one.

## Stage 2 — checklist, AI and scoring · NOT STARTED
## Stage 3 — product features · NOT STARTED
## Stage 4 — full design · NOT STARTED
## Stage 5 — landing page and launch · NOT STARTED
## Stage 6 — README and case study · NOT STARTED
