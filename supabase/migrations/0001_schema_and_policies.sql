-- Receipt portal — schema, row-level security, and storage policies.
--
-- Run this once against a fresh Supabase project (SQL Editor, or `supabase db push`).
-- It is written to be re-runnable: every object is created idempotently, so applying
-- it twice is not an error.
--
-- The design note worth reading before the SQL: on Supabase, `authenticated` and `anon`
-- already hold table privileges by default. RLS is therefore not an extra lock on top of
-- a closed door — for a table in `public`, it IS the door. A table created here without
-- `enable row level security` would be world-readable by any visitor holding the anon key,
-- which is published in the browser bundle by design. Every table below enables RLS in the
-- same statement block that creates it, and the privileges are narrowed to what the portal
-- actually needs rather than left at the permissive default.

begin;

-- ---------------------------------------------------------------------------
-- Customers: one row per authenticated person.
-- ---------------------------------------------------------------------------
-- The primary key IS `auth.users.id`. Keeping them equal means every policy in this
-- file compares against `auth.uid()` directly, with no join to resolve identity — a
-- policy that needs a subquery to decide who you are is a policy that is easy to get
-- subtly wrong.

create table if not exists public.customers (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text        not null,
  created_at timestamptz not null default now()
);

alter table public.customers enable row level security;

-- ---------------------------------------------------------------------------
-- Payments: mirrored from the fintech API by the sync-payments Edge Function.
-- ---------------------------------------------------------------------------
-- `source_payment_id` is the upstream identifier and is UNIQUE, which is what makes
-- the sync idempotent: re-running it updates rows instead of duplicating a customer's
-- payment history.

create table if not exists public.payments (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid        not null references public.customers (id) on delete cascade,
  source_payment_id text        not null unique,
  amount_cents      integer     not null check (amount_cents >= 0),
  currency          text        not null check (char_length(currency) = 3),
  description       text        not null,
  status            text        not null check (status in ('created', 'processing', 'succeeded', 'failed', 'canceled', 'refunded')),
  paid_at           timestamptz not null,
  created_at        timestamptz not null default now()
);

alter table public.payments enable row level security;

create index if not exists payments_customer_paid_at_idx
  on public.payments (customer_id, paid_at desc);

-- ---------------------------------------------------------------------------
-- Receipts: one downloadable PDF per payment.
-- ---------------------------------------------------------------------------
-- `storage_path` is not free-form. It is always `<customer_id>/<receipt_id>.pdf`,
-- because the storage policy below authorises on the first path segment. The CHECK
-- constraint makes that convention a database rule rather than a habit: a row whose
-- path does not begin with its owner's id cannot be inserted, so the storage policy
-- and the table can never disagree about who owns a file.

create table if not exists public.receipts (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid        not null unique references public.payments (id) on delete cascade,
  customer_id  uuid        not null references public.customers (id) on delete cascade,
  storage_path text        not null unique,
  issued_at    timestamptz not null default now(),
  constraint receipts_path_is_owned
    check (storage_path = customer_id::text || '/' || id::text || '.pdf')
);

alter table public.receipts enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------
-- Supabase grants ALL on new tables in `public` to anon and authenticated through
-- default privileges. That is convenient and it is also how a table leaks the day
-- someone forgets one `enable row level security`. Narrow it deliberately: the portal
-- only ever reads, so only SELECT survives, and `anon` — the key that ships inside the
-- browser bundle — keeps nothing at all.

revoke all on public.customers, public.payments, public.receipts from anon, authenticated;
grant select on public.customers, public.payments, public.receipts to authenticated;

-- The service role is NOT exempt from this. With "Automatically expose new tables"
-- switched off at project creation, a new table carries no default grants at all —
-- not for anon, not for authenticated, and not for service_role either. Learned live
-- on 2026-09-04: the secret key was refused with 42501 until this line existed. That
-- is default-deny reaching the privileged lane, which is the correct posture; it just
-- has to be granted back deliberately, here, table by table.
grant all on public.customers, public.payments, public.receipts to service_role;

-- ---------------------------------------------------------------------------
-- Policies.
-- ---------------------------------------------------------------------------
-- Read-only, and scoped by `auth.uid()`. There is no INSERT, UPDATE or DELETE policy
-- on any table: writes arrive only through the Edge Function, which holds the service
-- role and bypasses RLS. A missing policy is a denial, so the absence below is the
-- write protection — nothing further is needed to state it.
--
-- `auth.uid()` is wrapped in a scalar subselect on the hot tables so the planner
-- evaluates it once per query rather than once per row.

drop policy if exists "customers read self" on public.customers;
create policy "customers read self"
  on public.customers for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists "payments read own" on public.payments;
create policy "payments read own"
  on public.payments for select
  to authenticated
  using (customer_id = (select auth.uid()));

drop policy if exists "receipts read own" on public.receipts;
create policy "receipts read own"
  on public.receipts for select
  to authenticated
  using (customer_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Provisioning a customer row on sign-up.
-- ---------------------------------------------------------------------------
-- Supabase Auth owns `auth.users`; the portal cannot ask a signing-in visitor to
-- create their own `customers` row, because they hold no INSERT privilege and no
-- INSERT policy — correctly. A trigger closes that gap on the database side.
--
-- `security definer` is required to write into a table the caller cannot touch, and
-- `set search_path = ''` is the reason every name below is schema-qualified: a
-- definer function that resolves names through the caller's search_path is the
-- classic privilege-escalation shape.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customers (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Storage: a private bucket for receipt PDFs.
-- ---------------------------------------------------------------------------
-- `public => false`, so there is no unauthenticated URL for an object in this bucket
-- and every download is either an authorised request or a short-lived signed URL.

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Object-level authorisation. `storage.foldername(name)` splits the object path, and
-- its first element is the owning customer's id — the convention the `receipts_path_is_owned`
-- CHECK constraint enforces on the table side. A customer may read the objects under their
-- own prefix and nothing else; as with the tables, no write policy exists, so uploads are
-- the service role's alone.

drop policy if exists "receipt objects read own" on storage.objects;
create policy "receipt objects read own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;
