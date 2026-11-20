# Second Look

Paste a local business's website and get a real audit of why it's losing enquiries. Made by GC Studio.

> **Status:** Stage 1 of 6 (end-to-end path, plain styling). See [STATUS.md](STATUS.md) for exactly what works.
> The full case study (architecture diagram, eval results, cost per audit, demo) is Stage 6.

## Repo layout

```
apps/web         React 18 + Vite + TS + Tailwind + React Router — the app (landing page: Stage 5)
apps/worker      Node 20 + TS + Playwright — the audit pipeline, a long-lived job worker in Docker
packages/shared  Zod schemas, URL/SSRF logic, SEO rules, error copy — shared by web, worker and functions
supabase/        migrations (schema, RLS, queue functions), Edge Functions, config
tests/db         RLS + queue tests against real Postgres
tests/functions  create-audit handler tests
evals/           (Stage 2) labelled fixture sites + eval runner
```

## How an audit flows

1. The browser calls `POST /functions/v1/create-audit` with the user's JWT.
2. The Edge Function validates the body (Zod), normalises the URL, resolves DNS and rejects any non-public address, hashes the client IP, then calls `reserve_audit()`. That one transaction checks the per-user and per-IP daily quotas, inserts the audit with its step rows, and adds a row to `jobs`.
3. A worker claims the job, runs **fetch → PageSpeed (performance + accessibility) → SEO rules**, and writes each step's status to `audit_steps`.
4. The Running page subscribes to `audit_steps` over Supabase Realtime, then redirects to the report.

## The job queue (Postgres, no extra infrastructure)

The queue is the `jobs` table. A worker claims work with:

```sql
with next as (
  select audit_id from jobs
  where locked_by is null and run_after <= now()
  order by run_after
  for update skip locked
  limit 1
)
update jobs set locked_by = $worker, locked_at = now(), heartbeat_at = now(), attempts = attempts + 1
from next where jobs.audit_id = next.audit_id
returning jobs.audit_id, jobs.attempts;
```

- **`FOR UPDATE SKIP LOCKED`**: if another worker is claiming a row, this worker skips it instead of waiting. Many workers can poll at once and no job is claimed twice (a test checks this with two concurrent connections).
- **Polling every 2s** while it's running fewer than 2 jobs.
- **Heartbeats every 15s.** `heartbeat_job` only succeeds for the worker that holds the lock. If it returns false, the worker has lost the job and stops working on it.
- **Stale-job recovery.** Every 30s any worker runs `requeue_stale_jobs`: a job whose heartbeat is more than 2 minutes old is unlocked and runs again. After 3 attempts the audit is marked failed instead, so one bad URL can't loop forever.
- **Graceful shutdown.** On SIGTERM the worker stops claiming and gives running jobs 20s to finish. Anything still running is aborted and handed back with `release_job` (which doesn't count as an attempt). Fly's `kill_timeout` is 30s.
- **Idempotent steps.** A re-run overwrites its outputs (upserts and `upsert: true` uploads), so running a job twice is safe.

Why not Redis or a hosted queue? Audits are a few per minute at most, the audit row and its job live in the same database, and claiming and enqueueing can happen in the same transaction as the quota check. It's one less service to run, secure and pay for.

## Security (Stage 1)

- **SSRF.** Only http/https on ports 80/443, and no credentials in the URL. Every address a host resolves to must be public unicast. That blocks private, loopback, link-local/metadata, CGNAT and reserved ranges, plus IPv6 forms that wrap IPv4 (mapped, 6to4, NAT64, Teredo). It is checked in the Edge Function, then again in the worker for every request.
- **No browser network.** Chromium starts with a dead proxy (`127.0.0.1:9`, no loopback bypass). Every request the page makes is intercepted and fetched by `safeFetch`, which resolves DNS itself, checks each address, and connects to the IP it checked, so DNS rebinding can't slip in between. Redirects are never followed by the browser, because Chromium doesn't send redirect hops back through interception. The worker follows each hop itself and checks it, up to 5.
- **Limits.** 30s navigation timeout, 10 MB HTML cap, 40 MB total page budget, GET only, no WebSockets, no service workers.
- **robots.txt** is respected for `SecondLookBot`.
- **RLS.** Users can only *read* their own rows. All writes go through the service role (worker, Edge Functions), so quotas can't be bypassed from the browser. Service-only SQL functions have `EXECUTE` revoked from `anon` and `authenticated`.
- **Secrets.** The web build reads only `SUPABASE_URL` and `SUPABASE_ANON_KEY`, through explicit `define`s rather than an env prefix. CI builds with decoy secrets in the environment and scans the bundle for key patterns and service-role JWTs.

## Running locally

Requirements: Node 20+, pnpm 9, the [Supabase CLI](https://supabase.com/docs/guides/cli), and Docker (for `supabase start`).

```bash
pnpm install
cp .env.example .env            # fill in PAGESPEED_API_KEY; Supabase values come from `supabase start`
supabase start                  # local Postgres, Auth, Realtime, Storage, Inbucket for emails
supabase db reset               # applies supabase/migrations
supabase functions serve --env-file .env
pnpm --filter @second-look/web dev          # http://localhost:5173
pnpm --filter @second-look/worker dev       # needs Chromium: `npx playwright install chromium` or CHROMIUM_PATH
```

Magic-link emails land in Inbucket at http://localhost:54324.

## Tests

```bash
pnpm typecheck
pnpm test:unit            # URL normalisation, SSRF ranges + rebinding, SEO rules, web helpers
pnpm test:functions       # create-audit: auth, validation, SSRF, quota → HTTP mapping
pnpm test:integration     # real Chromium against local fixture sites (good, bad, robots-blocked, slow, redirect-to-metadata-IP, redirect loop)
eval "$(scripts/pg-test.sh)" && pnpm test:db   # RLS + quota + queue against real Postgres
```

## Deploying

```bash
supabase link --project-ref <ref>
supabase db push
supabase secrets set PUBLIC_SITE_URL=https://<web-domain> IP_HASH_SALT=$(openssl rand -hex 32) AUDITS_PER_USER_PER_DAY=3 AUDITS_PER_IP_PER_DAY=10
supabase functions deploy create-audit
fly launch --no-deploy --config apps/worker/fly.toml
fly secrets set --config apps/worker/fly.toml SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... PAGESPEED_API_KEY=... PUBLIC_SITE_URL=...
fly deploy --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile .
# Vercel: import the repo, root directory apps/web, set SUPABASE_URL, SUPABASE_ANON_KEY, AUDITS_PER_USER_PER_DAY.
```
