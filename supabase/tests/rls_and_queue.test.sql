-- Run with: supabase test db   (pgTAP)
begin;
select plan(14);

-- Two users
insert into auth.users (id, email, instance_id, aud, role)
values ('11111111-1111-1111-1111-111111111111', 'a@test.dev', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('22222222-2222-2222-2222-222222222222', 'b@test.dev', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

select is((select count(*)::int from public.profiles where id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222')), 2, 'profiles are created for new users');

-- Enqueue as service role
select is((public.enqueue_audit('11111111-1111-1111-1111-111111111111', 'https://a.example/', 'iphash-a', 3, 10) ->> 'ok')::boolean, true, 'user A can enqueue');
select is((public.enqueue_audit('22222222-2222-2222-2222-222222222222', 'https://b.example/', 'iphash-b', 3, 10) ->> 'ok')::boolean, true, 'user B can enqueue');
select is((select count(*)::int from public.audit_steps s join public.audits a on a.id = s.audit_id where a.user_id = '11111111-1111-1111-1111-111111111111'), 4, 'four Stage 1 steps are created');
select is((public.enqueue_audit('11111111-1111-1111-1111-111111111111', 'https://a.example/', 'iphash-a', 3, 10) ->> 'cached')::boolean, true, 'same URL within 24h returns the cached audit');
select is((public.enqueue_audit('11111111-1111-1111-1111-111111111111', 'https://a.example/', 'iphash-a', 3, 10, true) ->> 'cached')::boolean, false, 'forced re-run creates a new audit');
select is((public.enqueue_audit('11111111-1111-1111-1111-111111111111', 'https://c.example/', 'iphash-a', 2, 10) ->> 'code'), 'quota_exceeded', 'quota is enforced');
select is((public.enqueue_audit('22222222-2222-2222-2222-222222222222', 'https://d.example/', 'iphash-a', 10, 2) ->> 'code'), 'rate_limited', 'per-IP limit is enforced');

-- Queue: claiming takes the oldest job once
select is((select count(*)::int from public.claim_job('w1')), 1, 'a worker can claim a job');
select isnt((select audit_id from public.claim_job('w2')), (select audit_id from public.jobs where locked_by = 'w1'), 'a second worker gets a different job');

-- RLS as user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select count(*)::int from public.audits), 2, 'user A sees only their own audits');
select is((select count(*)::int from public.audit_steps s join public.audits a on a.id = s.audit_id where a.user_id <> '11111111-1111-1111-1111-111111111111'), 0, 'user A sees no steps from other users');
select is((select count(*)::int from public.jobs), 0, 'users cannot read the job queue');
select throws_ok($$ select public.enqueue_audit('11111111-1111-1111-1111-111111111111', 'https://x.example/', 'h', 99, 99) $$, '42501', null, 'users cannot call enqueue_audit directly');

select * from finish();
rollback;
