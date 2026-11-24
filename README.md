# Second Look

**Your website, checked by AI, judged by people.** Paste a local business's website and Second Look shows why it may be losing enquiries, with evidence for every answer. Built by [GC Studio](https://gabrielmartinezdev.com).

> Status: **Stage 1 of 6** — the core audit pipeline works end to end (fetch, Lighthouse, local SEO rules, live progress). The AI checklist, scoring and the full design arrive in later stages. See [`STATUS.md`](STATUS.md) for exactly what works today.

## How it works

```
Browser (React)  ──POST /create-audit──▶  Supabase Edge Function
     ▲                                     │ validates URL, SSRF host checks,
     │ Realtime (audits, audit_steps)      │ quota + per-IP limit, cache
     │                                     ▼
     │                               Postgres: audits, audit_steps, jobs
     │                                     ▲ claim_job() … FOR UPDATE SKIP LOCKED
     │                                     │
     └──────── step updates ◀────── Worker (Node + Playwright, Docker on Fly.io)
                                     fetch → robots.txt → Chromium (mobile + desktop)
                                     PageSpeed Insights (performance, accessibility)
                                     rule-based local SEO checks
                                     screenshots + HTML → private Storage
```

- **Job queue in Postgres.** `claim_job()` uses `FOR UPDATE SKIP LOCKED` so several workers never take the same job. Workers send a heartbeat every 20 s; a job with no heartbeat for 2 minutes is picked up again, and after 3 crashed attempts the audit is failed with a clear message. On SIGTERM the worker stops claiming, gives running audits 25 s, then puts unfinished jobs back in the queue.
- **SSRF protection in three layers.** (1) The API only accepts http(s) URLs on ports 80/443 and rejects private IP literals and internal host names. (2) The worker resolves DNS and refuses the host if *any* address is private, loopback, link-local, CGNAT, multicast or reserved (IPv4 and IPv6, including IPv4-mapped and NAT64). (3) Inside Chromium every request is routed through the same check, and main-document redirects are fetched with redirects off so each `Location` is checked before it's followed. robots.txt is fetched through an HTTP agent that validates the IP at connect time, which defeats DNS rebinding.
- **Rules before AI.** Anything a rule can decide (structured data, tel: links, headings) is decided by a rule. AI is used only for judgment calls, from Stage 2.
- **Same validation everywhere.** URL and IP rules live in `packages/shared` and are used by the browser, the worker and (via a generated copy checked in CI) the Deno Edge Function.

## Repo layout

```
apps/web          React 18 + Vite + TypeScript + Tailwind
apps/worker       Node 20 + Playwright audit worker (Dockerfile, fly.toml)
packages/shared   Zod schemas, URL/IP/robots/SEO rules, error copy
supabase/         migrations, RLS, Edge Functions, pgTAP tests
scripts/          shared-code sync for Edge Functions, client-bundle secret check
```

## Run it locally

Requirements: Node 20+, pnpm 9, Docker (for local Supabase), the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
pnpm install
supabase start                      # local Postgres, Auth, Storage, Realtime
supabase functions serve --env-file .env   # create-audit Edge Function
cp .env.example .env                # fill SUPABASE_SERVICE_ROLE_KEY (from `supabase status`) and PAGESPEED_API_KEY
cp apps/web/.env.example apps/web/.env.local   # fill VITE_SUPABASE_ANON_KEY from `supabase status`
pnpm --filter @second-look/worker exec playwright install chromium
pnpm dev                            # web on http://localhost:5173 + worker
```

Magic-link emails from local Supabase appear in Mailpit at http://127.0.0.1:54324.

## Tests

| Command | What it covers |
|---|---|
| `pnpm test` | Unit tests: URL normalisation, SSRF IP ranges, robots.txt, SEO rules, PageSpeed parsing and retries, pipeline status logic, UI step list |
| `pnpm test:integration` | Real Chromium against local fixture sites: good page, robots.txt disallow, redirect to a private IP, timeout, HTTP 500 |
| `supabase test db` | pgTAP: RLS isolation between users, quota, per-IP limit, cache, job claiming |
| `pnpm check:secrets` | Fails if a server key ends up in the web bundle |

All of these run in GitHub Actions on every push.

## Deploy

- **Database/Auth/Storage/Functions:** a Supabase project. `supabase link`, `supabase db push`, `supabase functions deploy create-audit`, then `supabase secrets set AUDITS_PER_USER_PER_DAY=3 AUDITS_PER_IP_PER_DAY=10 IP_HASH_SALT=… ALLOWED_ORIGINS=https://your-domain`.
- **Worker:** from the repo root, `fly deploy --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile`, with secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAGESPEED_API_KEY`, `BOT_INFO_URL`.
- **Web:** Vercel, root `apps/web`, env `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. In Supabase Auth settings, set the site URL and add `https://your-domain/auth/callback` as a redirect URL.
