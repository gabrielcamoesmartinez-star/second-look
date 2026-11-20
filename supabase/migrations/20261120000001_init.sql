-- Second Look — initial schema, RLS and job-queue functions.
-- Conventions:
--   * Users can only READ their own rows. Every write goes through an Edge
--     Function or the worker using the service role, so quotas and
--     validation can't be bypassed from the browser.
--   * Service-only functions have EXECUTE revoked from public/anon/authenticated.

create extension if not exists pgcrypto;

-- ---------- Types ----------
create type public.audit_status as enum ('queued', 'running', 'complete', 'partial', 'failed', 'cancelled');
create type public.audit_step_name as enum ('fetch', 'accessibility', 'performance', 'seo', 'checklist_ai', 'summary');
create type public.step_status as enum ('queued', 'running', 'retrying', 'done', 'failed', 'skipped');
create type public.check_outcome as enum ('pass', 'fail', 'unsure');
create type public.check_source as enum ('rule', 'ai', 'rule+ai');
create type public.fix_impact as enum ('high', 'medium', 'low');

-- ---------- Tables ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  audits_today integer not null default 0 check (audits_today >= 0),
  quota_reset_at timestamptz not null default (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 day'
);

create table public.audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  input_url text not null check (char_length(input_url) <= 2048),
  final_url text,
  checklist text not null default 'local_service',
  status public.audit_status not null default 'queued',
  error_code text,
  error_message text,
  score numeric(5, 2) check (score between 0 and 100),
  category_scores jsonb,
  summary text,
  screenshot_path text,
  html_path text,
  pdf_path text,
  share_token text unique,
  duration_ms integer,
  ai_input_tokens integer,
  ai_output_tokens integer,
  ai_cost_usd numeric(10, 6),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index audits_user_created_idx on public.audits (user_id, created_at desc);
create index audits_url_created_idx on public.audits (input_url, created_at desc);

create table public.audit_steps (
  audit_id uuid not null references public.audits (id) on delete cascade,
  step public.audit_step_name not null,
  status public.step_status not null default 'queued',
  attempt integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  detail text,
  primary key (audit_id, step)
);

create table public.check_results (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits (id) on delete cascade,
  check_id text not null,
  result public.check_outcome not null,
  confidence numeric(3, 2) not null check (confidence between 0 and 1),
  evidence text not null default '',
  evidence_selector text,
  box jsonb,
  source public.check_source not null,
  unique (audit_id, check_id)
);

create table public.fixes (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits (id) on delete cascade,
  rank integer not null,
  title text not null,
  why text not null,
  evidence text not null,
  impact public.fix_impact not null,
  effort integer not null check (effort between 1 and 5),
  category text not null,
  check_ids text[] not null default '{}',
  unique (audit_id, rank)
);

create table public.flags (
  id uuid primary key default gen_random_uuid(),
  check_result_id uuid not null references public.check_results (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  note text check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  unique (check_result_id, user_id)
);

create table public.jobs (
  audit_id uuid primary key references public.audits (id) on delete cascade,
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  attempts integer not null default 0,
  run_after timestamptz not null default now()
);
create index jobs_claimable_idx on public.jobs (run_after) where locked_by is null;

create table public.ai_spend (
  day date primary key,
  total_usd numeric(12, 6) not null default 0
);

-- Per-IP daily counter. Stores a salted hash, never the raw IP.
create table public.ip_usage (
  ip_hash text not null,
  day date not null,
  count integer not null default 0,
  primary key (ip_hash, day)
);

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.audits enable row level security;
alter table public.audit_steps enable row level security;
alter table public.check_results enable row level security;
alter table public.fixes enable row level security;
alter table public.flags enable row level security;
alter table public.jobs enable row level security;
alter table public.ai_spend enable row level security;
alter table public.ip_usage enable row level security;

create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "own audits" on public.audits for select to authenticated using (user_id = auth.uid());
create policy "own audit steps" on public.audit_steps for select to authenticated
  using (exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid()));
create policy "own check results" on public.check_results for select to authenticated
  using (exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid()));
create policy "own fixes" on public.fixes for select to authenticated
  using (exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid()));
create policy "own flags" on public.flags for select to authenticated using (user_id = auth.uid());
-- jobs, ai_spend, ip_usage: no policies → only the service role can touch them.

-- Belt and braces: browsers never write directly.
revoke insert, update, delete on public.profiles, public.audits, public.audit_steps, public.check_results,
  public.fixes, public.flags from anon, authenticated;
revoke all on public.jobs, public.ai_spend, public.ip_usage from anon, authenticated;

-- ---------- Profile on sign-up ----------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Quota + enqueue (atomic) ----------
-- Raises with a machine-readable error code in MESSAGE: quota_exceeded / ip_rate_limited.
create function public.reserve_audit(
  p_user uuid, p_ip_hash text, p_input_url text, p_user_limit integer, p_ip_limit integer
) returns table (audit_id uuid, remaining integer)
language plpgsql security definer set search_path = public as $$
declare
  v_profile public.profiles;
  v_ip_count integer;
  v_audit uuid;
  v_today date := (now() at time zone 'utc')::date;
begin
  insert into public.profiles (id) values (p_user) on conflict do nothing;
  select * into v_profile from public.profiles where id = p_user for update;

  if v_profile.quota_reset_at <= now() then
    update public.profiles
      set audits_today = 0,
          quota_reset_at = (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 day'
      where id = p_user
      returning * into v_profile;
  end if;

  if v_profile.audits_today >= p_user_limit then
    raise exception 'quota_exceeded' using errcode = 'P0001';
  end if;

  insert into public.ip_usage (ip_hash, day, count) values (p_ip_hash, v_today, 1)
    on conflict (ip_hash, day) do update set count = public.ip_usage.count + 1
    returning count into v_ip_count;
  if v_ip_count > p_ip_limit then
    raise exception 'ip_rate_limited' using errcode = 'P0001';  -- rolls back the increment
  end if;

  update public.profiles set audits_today = audits_today + 1 where id = p_user;

  insert into public.audits (user_id, input_url) values (p_user, p_input_url) returning id into v_audit;
  insert into public.audit_steps (audit_id, step)
    select v_audit, s from unnest(array['fetch', 'performance', 'accessibility', 'seo']::public.audit_step_name[]) s;
  insert into public.jobs (audit_id) values (v_audit);

  return query select v_audit, p_user_limit - v_profile.audits_today - 1;
end $$;

create function public.quota_remaining(p_user_limit integer) returns integer
language sql stable security definer set search_path = public as $$
  select case
    when p.quota_reset_at <= now() then p_user_limit
    else greatest(p_user_limit - p.audits_today, 0)
  end
  from public.profiles p where p.id = auth.uid();
$$;

-- ---------- Job queue ----------
-- Claim one job. SKIP LOCKED lets many workers poll without blocking each other
-- or double-claiming a row.
create function public.claim_job(p_worker text) returns table (audit_id uuid, attempts integer)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with next as (
    select j.audit_id from public.jobs j
    where j.locked_by is null and j.run_after <= now()
    order by j.run_after
    for update skip locked
    limit 1
  )
  update public.jobs j
    set locked_by = p_worker, locked_at = now(), heartbeat_at = now(), attempts = j.attempts + 1
    from next where j.audit_id = next.audit_id
    returning j.audit_id, j.attempts;
end $$;

create function public.heartbeat_job(p_audit uuid, p_worker text) returns boolean
language sql security definer set search_path = public as $$
  update public.jobs set heartbeat_at = now()
  where audit_id = p_audit and locked_by = p_worker
  returning true;
$$;

-- Put the job back (graceful shutdown) without counting it as a failure.
create function public.release_job(p_audit uuid, p_worker text) returns void
language sql security definer set search_path = public as $$
  update public.jobs set locked_by = null, locked_at = null, heartbeat_at = null,
    attempts = greatest(attempts - 1, 0), run_after = now()
  where audit_id = p_audit and locked_by = p_worker;
$$;

create function public.finish_job(p_audit uuid, p_worker text) returns void
language sql security definer set search_path = public as $$
  delete from public.jobs where audit_id = p_audit and locked_by = p_worker;
$$;

-- Re-queue jobs whose worker stopped sending heartbeats. After 3 attempts the
-- audit is failed instead, so a poison URL can't loop forever.
create function public.requeue_stale_jobs(p_stale_seconds integer default 120, p_max_attempts integer default 3)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with dead as (
    delete from public.jobs
    where locked_by is not null and heartbeat_at < now() - make_interval(secs => p_stale_seconds)
      and attempts >= p_max_attempts
    returning audit_id
  )
  update public.audits a set status = 'failed', error_code = 'internal',
    error_message = 'The audit stopped responding too many times.', completed_at = now()
  from dead where a.id = dead.audit_id;

  update public.jobs
    set locked_by = null, locked_at = null, heartbeat_at = null, run_after = now()
    where locked_by is not null and heartbeat_at < now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create function public.add_ai_spend(p_usd numeric) returns numeric
language sql security definer set search_path = public as $$
  insert into public.ai_spend (day, total_usd) values ((now() at time zone 'utc')::date, p_usd)
  on conflict (day) do update set total_usd = public.ai_spend.total_usd + excluded.total_usd
  returning total_usd;
$$;

-- ---------- Public share links ----------
-- The only path for anonymous reads. Returns a single report, without user_id.
create function public.get_shared_report(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'audit', to_jsonb(a) - 'user_id' - 'share_token' - 'html_path' - 'ai_input_tokens' - 'ai_output_tokens' - 'ai_cost_usd',
    'steps', coalesce((select jsonb_agg(to_jsonb(s)) from public.audit_steps s where s.audit_id = a.id), '[]'::jsonb),
    'checks', coalesce((select jsonb_agg(to_jsonb(c)) from public.check_results c where c.audit_id = a.id), '[]'::jsonb),
    'fixes', coalesce((select jsonb_agg(to_jsonb(f) order by f.rank) from public.fixes f where f.audit_id = a.id), '[]'::jsonb)
  )
  from public.audits a
  where p_token is not null and char_length(p_token) >= 32 and a.share_token = p_token;
$$;

-- ---------- Function privileges ----------
revoke execute on function public.reserve_audit(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.claim_job(text) from public, anon, authenticated;
revoke execute on function public.heartbeat_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.release_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.finish_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.requeue_stale_jobs(integer, integer) from public, anon, authenticated;
revoke execute on function public.add_ai_spend(numeric) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.reserve_audit(uuid, text, text, integer, integer), public.claim_job(text),
  public.heartbeat_job(uuid, text), public.release_job(uuid, text), public.finish_job(uuid, text),
  public.requeue_stale_jobs(integer, integer), public.add_ai_spend(numeric) to service_role;
revoke execute on function public.quota_remaining(integer) from public, anon;
grant execute on function public.quota_remaining(integer) to authenticated;
grant execute on function public.get_shared_report(text) to anon, authenticated;

-- ---------- Realtime + Storage (only present on Supabase) ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.audits, public.audit_steps;
  end if;
end $$;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('audit-artifacts', 'audit-artifacts', false)
      on conflict (id) do nothing;
    -- Objects live at {user_id}/{audit_id}/... — owners may read (to create signed URLs). Writes: service role only.
    execute $p$
      create policy "owner reads own artifacts" on storage.objects for select to authenticated
      using (bucket_id = 'audit-artifacts' and (storage.foldername(name))[1] = auth.uid()::text)
    $p$;
  end if;
end $$;
