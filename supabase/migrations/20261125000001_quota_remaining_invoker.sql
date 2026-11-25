-- quota_remaining only reads the caller's own profile, which RLS already allows.
alter function public.quota_remaining(integer) security invoker;
