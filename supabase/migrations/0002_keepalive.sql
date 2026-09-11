-- Receipt portal — a keep-alive the free tier actually counts.
--
-- Why this exists: on 2026-09-11 Supabase warned that this project "has not seen
-- sufficient activity for more than 7 days" and would be paused — while the hourly
-- production-watch job in the platform repo was green. That job read
-- `public.payments` as `anon`, was refused (401, SQLSTATE 42501), and treated the
-- refusal as proof the project was awake. The warning proved a refused request does
-- not count as activity. The deny check stays, because it is a real regression test;
-- this function gives the job a request that genuinely succeeds.
--
-- It touches no customer table and returns nothing a visitor could not already
-- learn from a clock. SECURITY INVOKER so it runs with anon's own (empty) grants.

begin;

create or replace function public.keepalive()
returns timestamptz
language sql
security invoker
stable
set search_path = ''
as $$
  select now();
$$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated, service_role;

commit;
