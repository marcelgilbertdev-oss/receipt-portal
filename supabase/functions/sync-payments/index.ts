/**
 * sync-payments — mirrors a customer's payments from the fintech API into Supabase.
 *
 * This is the one place the service-role key is used at runtime, and it runs on
 * Supabase's servers (Deno), never in a browser. It is also what makes the portal a
 * consumer of the fintech API rather than an unrelated app with its own data.
 *
 * Invocation (POST, JSON body):  { "email": "customer@example.com" }
 *
 * The caller must present the function's shared secret in `x-sync-secret`. Without
 * it, the function is a public endpoint that writes rows for any email it is handed,
 * which is a write path around RLS — precisely the thing the rest of this repo is
 * built to prevent.
 *
 * Deployed with --no-verify-jwt: this function authenticates its caller itself (the shared
 * secret below, compared in constant time), so Supabase's JWT gate is switched off for it.
 *
 * Secrets (set with `supabase secrets set`):
 *   FINTECH_API_URL    upstream API, e.g. https://zerofayyz-fintech-api.onrender.com
 *   SYNC_SECRET        shared secret checked on every call
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

/** One row of GET /api/v1/payments on the fintech API (apps/api/src/ledger/ledger.routes.ts). */
interface UpstreamPayment {
  id: string
  customer: { displayName: string; email: string }
  amountMinor: number
  currency: string
  status: 'created' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'refunded'
  description: string | null
  methodLabel: string
  createdAt: string
}

interface UpstreamPage {
  data: UpstreamPayment[]
  meta: { total: number; limit: number; offset: number }
}

const PAGE = 100 // the API's maximum page size

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * The upstream list is public and paginated, with no per-customer filter — it feeds a
 * dashboard, not a portal. So the function walks every page and keeps the rows whose
 * customer email matches. At the sandbox's size that is one request; the loop is here
 * so that it stays correct when it is not.
 */
async function fetchPaymentsFor(apiUrl: string, email: string): Promise<UpstreamPayment[]> {
  const mine: UpstreamPayment[] = []
  let offset = 0
  for (;;) {
    const res = await fetch(`${apiUrl}/api/v1/payments?limit=${PAGE}&offset=${offset}`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`upstream returned ${res.status}`)
    const page = (await res.json()) as UpstreamPage
    for (const p of page.data) {
      if (p.customer.email.toLowerCase() === email) mine.push(p)
    }
    offset += page.data.length
    if (page.data.length === 0 || offset >= page.meta.total) break
  }
  return mine
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const secret = Deno.env.get('SYNC_SECRET')
  const presented = req.headers.get('x-sync-secret') ?? ''
  if (!secret || !timingSafeEqual(presented, secret)) {
    return json({ error: 'unauthorised' }, 401)
  }

  let email: string
  try {
    const body = await req.json()
    email = String(body?.email ?? '').trim().toLowerCase()
  } catch {
    return json({ error: 'body must be JSON' }, 400)
  }
  if (!email) return json({ error: 'email is required' }, 400)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  // Only customers who have signed in exist here; the trigger on auth.users made the row.
  const { data: customer, error: customerError } = await admin
    .from('customers')
    .select('id')
    .eq('email', email)
    .maybeSingle()
  if (customerError) return json({ error: customerError.message }, 500)
  // Same answer whether or not the mailbox is known — this endpoint must not be usable
  // to discover which addresses have accounts.
  if (!customer) return json({ synced: 0 })

  const apiUrl = Deno.env.get('FINTECH_API_URL')
  if (!apiUrl) return json({ error: 'FINTECH_API_URL is not configured' }, 500)

  let payments: UpstreamPayment[]
  try {
    payments = await fetchPaymentsFor(apiUrl, email)
  } catch (err) {
    return json({ error: (err as Error).message }, 502)
  }

  // Upsert keyed on the upstream id: re-running the sync updates rows, it never
  // duplicates them. The UNIQUE constraint on source_payment_id is what makes this
  // an idempotent operation rather than a hopeful one.
  const rows = payments.map((p) => ({
    customer_id: customer.id,
    source_payment_id: p.id,
    amount_cents: p.amountMinor,
    currency: p.currency.toLowerCase(),
    description: p.description ?? p.methodLabel,
    status: p.status,
    paid_at: p.createdAt,
  }))

  if (rows.length > 0) {
    const { error: upsertError } = await admin
      .from('payments')
      .upsert(rows, { onConflict: 'source_payment_id' })
    if (upsertError) return json({ error: upsertError.message }, 500)
  }

  return json({ synced: rows.length })
})
