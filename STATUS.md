# Status

Last updated: 24 Nov 2026 · Current stage: **1 — working path from start to finish**

## Stage 1

### Works (verified)
- **Shared rules** (`packages/shared`): URL normalisation, IPv4/IPv6 private-range checks, robots.txt parser, 8 rule-based local SEO checks, error copy. 70 unit tests pass.
- **Worker** (`apps/worker`): job loop with heartbeat, stale-job recovery and graceful shutdown; fetch step with DNS + per-request SSRF checks, redirect checking, robots.txt, 30 s timeout, 10 MB limit, mobile/full-page/desktop screenshots; PageSpeed step with 3 retries and backoff; SEO step; partial/failed/cancelled handling. 14 unit tests pass. **5 integration tests pass against real Chrome** (good site, robots disallow, redirect to 169.254.169.254, timeout, HTTP 500). Production build (`tsup`) succeeds.
- **Web** (`apps/web`): magic-link sign-in, new-audit form with local validation, audit history with real statuses and reasons, live step progress over Realtime, basic results (Lighthouse scores, metrics and top issues, SEO table, first-screen screenshot via signed URL), 404 page. Typecheck, lint, unit test and production build pass; the client-bundle secret check passes.
- **Edge Function** `create-audit`: auth check, Zod body validation, shared URL/SSRF rules, quota, salted-hash per-IP limit, 24 h cache, all in one transaction (`enqueue_audit`).

### Written but not yet run (needs Docker / Supabase CLI — runs in CI)
- Migrations, RLS policies, queue functions and the pgTAP suite (`supabase/tests`, 14 assertions).
- The Edge Function itself (Deno) — needs `supabase functions serve` or a deployed project.

### Not done yet — Stage 1 "Done when" still open
- [ ] Deployed: needs a Supabase project, a Fly.io (or Railway) app for the worker and a Vercel project for the web app.
- [ ] A real audit of a real public URL on the deployed site, watched live.
- [ ] Robots-blocked site and private-IP URL producing the right errors on the deployed site (covered by tests locally).
- [ ] CI green on GitHub (workflow is in place; first run happens on push).

### Known limits (Stage 1)
- If robots.txt returns 5xx or can't be fetched, the audit continues and notes it (RFC 9309 says to treat 5xx as "disallow all"; revisit if a site complains).
- Sub-resource requests are checked per host with a cached DNS answer; Chromium resolves again itself. The main document and its redirects are fetched by us and checked, and private addresses are refused in every case seen in tests, but a sub-resource DNS-rebinding race is theoretically possible. Screenshots of such a request would only reveal the response to the page itself, never to us or the user, so impact is low.
- No overall score yet — weights and the enquiry checklist come in Stage 2.
- Data retention (90-day purge) and account deletion are Stage 3.

## Needed from Gabriel
1. **Supabase project** (free tier is fine): project URL, anon key, service role key. Run the commands in README → Deploy.
2. **PageSpeed Insights API key**: Google Cloud console → enable "PageSpeed Insights API" → create an API key, restricted to that API.
3. **Fly.io account** (or Railway) for the worker, and a **Vercel account** for the web app.
4. A random `IP_HASH_SALT` (e.g. `openssl rand -hex 32`).
5. Push the commits: `git push` from your Mac.

## Next
Finish Stage 1 deployment, then Stage 2: the 8-check enquiry checklist (rules + AI with Zod-validated output), marker boxes from the browser, scoring, fix library, summary, AI budget guard.
