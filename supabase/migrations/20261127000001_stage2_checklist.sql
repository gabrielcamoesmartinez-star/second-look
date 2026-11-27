-- Stage 2: audits get the checklist_ai and summary steps, and create-audit can
-- return a recent result instead of re-running (24h cache).

create or replace function public.reserve_audit(
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
    raise exception 'ip_rate_limited' using errcode = 'P0001';
  end if;

  update public.profiles set audits_today = audits_today + 1 where id = p_user;

  insert into public.audits (user_id, input_url) values (p_user, p_input_url) returning id into v_audit;
  insert into public.audit_steps (audit_id, step)
    select v_audit, s from unnest(
      array['fetch', 'performance', 'accessibility', 'seo', 'checklist_ai', 'summary']::public.audit_step_name[]
    ) s;
  insert into public.jobs (audit_id) values (v_audit);

  return query select v_audit, p_user_limit - v_profile.audits_today - 1;
end $$;

-- The user's most recent finished audit of this exact URL in the last 24 hours, if any.
create or replace function public.find_recent_audit(p_user uuid, p_input_url text)
returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.audits
  where user_id = p_user and input_url = p_input_url
    and status in ('complete', 'partial')
    and created_at > now() - interval '24 hours'
  order by created_at desc
  limit 1;
$$;

revoke execute on function public.reserve_audit(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_audit(uuid, text, text, integer, integer) to service_role;
revoke execute on function public.find_recent_audit(uuid, text) from public, anon, authenticated;
grant execute on function public.find_recent_audit(uuid, text) to service_role;
