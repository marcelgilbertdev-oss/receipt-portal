# Receipt portal

A customer receipt portal built on Supabase. A customer signs in with a one-time email
link, sees only their own payments, and downloads their receipts. It is the fifth
independent consumer of the
[ZEROFAYYZ FINTECH](https://github.com/marcelgilbertdev-oss/zerofayyz-fintech) API,
alongside the Next.js, Vue and Svelte clients and the
[endpoint-pulse](https://github.com/marcelgilbertdev-oss/endpoint-pulse) browser extension.

It exists for one reason: the main platform enforces row-level security with a
hand-rolled PostgreSQL pattern (a `NOLOGIN` role adopted per transaction). This portal
enforces the same guarantee with Supabase's `auth.uid()` policy model, so the two can be
compared honestly. The comparison is the point; the code is the evidence for it:
[ADR 17 — two row-level security models](https://github.com/marcelgilbertdev-oss/zerofayyz-fintech/blob/main/docs/decisions/0017-two-row-level-security-models.md).

## What Supabase does here

| Feature | Use | What it proves |
| --- | --- | --- |
| Auth | magic-link sign-in | their auth, not a hand-rolled one |
| Row-level security | a customer reads only rows where `customer_id = auth.uid()` | the policy model, in their dialect |
| Storage | receipt PDFs in a private bucket, object policy on the path prefix | bucket and object-level authorisation |
| Edge Function | mirrors payments from the fintech API with the service role | the only runtime holder of the privileged key |

Deliberately small. It is evidence, not a product.

## The guarantee, and its proof

A signed-in customer cannot read another customer's rows or files, and cannot write
anything. That is proven by `tests/isolation.integration-test.ts` against a real project:
two genuinely authenticated clients, queries with **no per-customer WHERE clause**, rows
absent because a policy refused them. It also proves the failure directions — anonymous
reads return nothing, every write is refused, a signed URL cannot be minted over someone
else's file, and a foreign storage prefix does not list.

Three design choices worth knowing:

- **The `customers` primary key *is* `auth.users.id`.** Every policy compares against
  `auth.uid()` directly. A policy that needs a join to work out who you are is a policy
  that is easy to get subtly wrong.
- **Default grants are revoked.** Supabase grants `anon` and `authenticated` full
  privileges on new `public` tables, so for a Supabase table RLS is not a second lock on
  a closed door — it *is* the door. The migration narrows `authenticated` to SELECT and
  leaves `anon` with nothing, so a forgotten policy is not the only thing between a
  visitor holding the published key and the rows.
- **The receipt path is a CHECK constraint.** `storage_path` must equal
  `<customer_id>/<receipt_id>.pdf`, which is what the storage policy authorises on. The
  table and the bucket cannot disagree about who owns a file.

## Run it

```bash
cp .env.example .env      # fill in from Project Settings -> API
npm install
```

Apply `supabase/migrations/0001_schema_and_policies.sql` in the SQL editor (it is
idempotent). Then:

```bash
DEMO_EMAIL=you@example.com npm run seed   # a customer with a few sandbox payments
npm test                                  # the isolation suite, against the live project
npm run dev                               # the portal
```

Deploy the Edge Function with `supabase functions deploy sync-payments` and set
`FINTECH_API_URL` and `SYNC_SECRET` with `supabase secrets set`.

## Keys

The anon key ships in the browser bundle by design; it identifies the project and
authorises nothing. The service-role key bypasses RLS and is used only by the seed script
and the Edge Function, both of which run on a server. It is never committed and never
reaches `src/`.

## Licence

MIT.
