-- Second Look: initial schema (Stage 1).
-- Tables: profiles, audits, audit_steps, jobs, rate_limits. Job queue uses FOR UPDATE SKIP LOCKED.

-- Profiles -------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  is_admin boolean not null default false
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Audits ---------------------------------------------------------------------
create table public.audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  input_url text not null check (char_length(input_url) <= 2048),
  final_url text,
  checklist text not null default 'local_service',
  status text not null default 'queued'
    check (status in ('queued', 'running', 'complete', 'partial', 'failed', 'cancelled')),
  error_code text,
  error_message text,
  score numeric(5, 2),
  category_scores jsonb,
  summary text,
  screenshot_path text,
  html_path text,
  pdf_path text,
  share_token text unique,
  duration_ms integer,
  ai_input_tokens integer not null default 0,
  ai_output_tokens integer not null default 0,
  ai_cost_usd numeric(10, 5) not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index audits_user_created_idx on public.audits (user_id, created_at desc);
create index audits_url_created_idx on public.audits (input_url, created_at desc);

-- Steps ----------------------------------------------------------------------
create table public.audit_steps (
  id bigint generated always as identity primary key,
  audit_id uuid not null references public.audits (id) on delete cascade,
  step text not null check (step in ('fetch', 'accessibility', 'performance', 'seo', 'checklist_ai', 'summary')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retrying', 'done', 'failed', 'skipped')),
  attempt integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  detail text,
  unique (audit_id, step)
);

-- Job queue --------------------------------------------------------------------
create table public.jobs (
  id bigint generated always as identity primary key,
  audit_id uuid not null unique references public.audits (id) on delete cascade,
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index jobs_ready_idx on public.jobs (run_after, created_at) where locked_at is null;

-- Per-IP rate limiting (stores a salted hash, never the raw IP) ----------------
create table public.rate_limits (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index rate_limits_ip_created_idx on public.rate_limits (ip_hash, created_at desc);

-- Row level security -------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.audits enable row level security;
alter table public.audit_steps enable row level security;
alter table public.jobs enable row level security;
alter table public.rate_limits enable row level security;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "audits: read own" on public.audits
  for select to authenticated using (user_id = (select auth.uid()));

create policy "audit_steps: read own" on public.audit_steps
  for select to authenticated using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = (select auth.uid()))
  );
-- No insert/update/delete policies: all writes go through the service role (Edge Functions, worker).
-- jobs and rate_limits have no policies at all, so only the service role can touch them.

-- Enqueue: one transaction for quota, rate limit, cache and inserts ----------------
create function public.enqueue_audit(
  p_user_id uuid,
  p_url text,
  p_ip_hash text,
  p_user_daily_limit integer,
  p_ip_daily_limit integer,
  p_force boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_used integer;
  v_ip_used integer;
  v_cached uuid;
  v_audit uuid;
begin
  -- Serialise per user so two quick clicks can't both pass the quota check.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if not p_force then
    select id into v_cached from public.audits
     where user_id = p_user_id and input_url = p_url
       and status in ('queued', 'running', 'complete', 'partial')
       and created_at > now() - interval '24 hours'
     order by created_at desc limit 1;
    if v_cached is not null then
      select count(*) into v_used from public.audits
       where user_id = p_user_id and created_at > now() - interval '24 hours';
      return jsonb_build_object('ok', true, 'audit_id', v_cached, 'cached', true,
                                'remaining', greatest(p_user_daily_limit - v_used, 0));
    end if;
  end if;

  select count(*) into v_used from public.audits
   where user_id = p_user_id and created_at > now() - interval '24 hours';
  if v_used >= p_user_daily_limit then
    return jsonb_build_object('ok', false, 'code', 'quota_exceeded');
  end if;

  select count(*) into v_ip_used from public.rate_limits
   where ip_hash = p_ip_hash and created_at > now() - interval '24 hours';
  if v_ip_used >= p_ip_daily_limit then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  insert into public.rate_limits (ip_hash) values (p_ip_hash);
  insert into public.audits (user_id, input_url) values (p_user_id, p_url) returning id into v_audit;
  insert into public.audit_steps (audit_id, step)
    select v_audit, s from unnest(array['fetch', 'accessibility', 'performance', 'seo']) as s;
  insert into public.jobs (audit_id) values (v_audit);

  return jsonb_build_object('ok', true, 'audit_id', v_audit, 'cached', false,
                            'remaining', greatest(p_user_daily_limit - v_used - 1, 0));
end;
$$;

-- Claim the next job. Stale jobs (no heartbeat for 2 minutes) are picked up again.
create function public.claim_job(p_worker text)
returns table (job_id bigint, audit_id uuid, attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with next_job as (
    select j.id from public.jobs j
     where j.run_after <= now()
       and j.attempts < 3
       and (j.locked_at is null or j.heartbeat_at < now() - interval '2 minutes')
     order by j.created_at
     for update skip locked
     limit 1
  )
  update public.jobs j
     set locked_by = p_worker, locked_at = now(), heartbeat_at = now(), attempts = j.attempts + 1
    from next_job
   where j.id = next_job.id
  returning j.id, j.audit_id, j.attempts;
end;
$$;

create function public.heartbeat_job(p_job_id bigint, p_worker text) returns boolean
language sql security definer set search_path = '' as $$
  update public.jobs set heartbeat_at = now()
   where id = p_job_id and locked_by = p_worker
  returning true;
$$;

-- Put a job back in the queue (graceful shutdown) with a short delay.
create function public.release_job(p_job_id bigint, p_worker text) returns void
language sql security definer set search_path = '' as $$
  update public.jobs set locked_by = null, locked_at = null, heartbeat_at = null,
         run_after = now() + interval '5 seconds'
   where id = p_job_id and locked_by = p_worker;
$$;

-- Jobs that crashed three times: fail the audit and drop the job.
create function public.fail_exhausted_jobs() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  with dead as (
    delete from public.jobs
     where attempts >= 3 and (locked_at is null or heartbeat_at < now() - interval '2 minutes')
    returning audit_id
  )
  update public.audits a set status = 'failed', error_code = 'internal_error',
         error_message = 'The audit worker stopped three times on this site.', completed_at = now()
    from dead where a.id = dead.audit_id and a.status in ('queued', 'running');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.enqueue_audit(uuid, text, text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.claim_job(text) from public, anon, authenticated;
revoke all on function public.heartbeat_job(bigint, text) from public, anon, authenticated;
revoke all on function public.release_job(bigint, text) from public, anon, authenticated;
revoke all on function public.fail_exhausted_jobs() from public, anon, authenticated;
grant execute on function public.enqueue_audit(uuid, text, text, integer, integer, boolean) to service_role;
grant execute on function public.claim_job(text) to service_role;
grant execute on function public.heartbeat_job(bigint, text) to service_role;
grant execute on function public.release_job(bigint, text) to service_role;
grant execute on function public.fail_exhausted_jobs() to service_role;

-- Live progress over Realtime (RLS still applies to what each user receives).
alter publication supabase_realtime add table public.audits, public.audit_steps;

-- Private storage for screenshots and HTML snapshots. Path: {user_id}/{audit_id}/{file}
insert into storage.buckets (id, name, public) values ('audit-artifacts', 'audit-artifacts', false)
  on conflict (id) do nothing;

create policy "artifacts: owners can read" on storage.objects
  for select to authenticated using (
    bucket_id = 'audit-artifacts' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
