/**
 * Cross-customer isolation, proven against a real Supabase project.
 *
 * The claim under test is the one a reviewer should not have to take on trust:
 * a signed-in customer cannot read another customer's payment rows or receipt
 * files, and cannot write anything at all. Every assertion below runs through a
 * genuinely authenticated client holding a real `authenticated` JWT, so what is
 * being exercised is the policy set in the database, not a filter in the portal.
 *
 * Two deliberate choices:
 *
 * - The queries carry NO per-customer WHERE clause. Adding one would test the
 *   test. Rows are absent because a policy refused them, which is the only form
 *   of the proof worth having.
 *
 * - The fixtures are created with the service role, which bypasses RLS. That is
 *   the point: the setup deliberately writes rows the subject under test must not
 *   be able to reach.
 *
 * Sign-in here uses a password rather than the portal's magic link. RLS evaluates
 * the JWT's subject and neither the policies nor the storage rules can tell the
 * two flows apart; a mail round-trip in a test suite would add a moving part
 * without adding coverage.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY. Run with: npm test
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import 'dotenv/config'

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL')
const ANON_KEY = requireEnv('VITE_SUPABASE_ANON_KEY')
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env and fill it in`)
  return value
}

/** Service-role client. Bypasses RLS; used only to build and tear down fixtures. */
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface Customer {
  user: User
  client: SupabaseClient
  email: string
  password: string
  paymentId: string
  receiptId: string
  storagePath: string
}

/** Creates a confirmed user, a payment, a receipt row and its PDF object. */
async function createCustomer(label: string): Promise<Customer> {
  const email = `isolation-${label}-${randomUUID()}@example.test`
  const password = `pw-${randomUUID()}`

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  assert.equal(createError, null, `creating ${label}: ${createError?.message}`)
  const user = created!.user!

  // The customers row is written by the on_auth_user_created trigger, not here.
  const { data: customerRow, error: customerError } = await admin
    .from('customers')
    .select('id')
    .eq('id', user.id)
    .single()
  assert.equal(customerError, null, `trigger did not provision a customers row for ${label}`)
  assert.equal(customerRow!.id, user.id)

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .insert({
      customer_id: user.id,
      source_payment_id: `pay_${randomUUID()}`,
      amount_cents: label === 'a' ? 12_500 : 98_700,
      currency: 'usd',
      description: `Invoice for ${label}`,
      status: 'succeeded',
      paid_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  assert.equal(paymentError, null, `seeding payment for ${label}: ${paymentError?.message}`)

  const receiptId = randomUUID()
  const storagePath = `${user.id}/${receiptId}.pdf`

  const { error: uploadError } = await admin.storage
    .from('receipts')
    .upload(storagePath, Buffer.from(`%PDF-1.4 receipt for ${label}\n`), {
      contentType: 'application/pdf',
      upsert: true,
    })
  assert.equal(uploadError, null, `uploading receipt for ${label}: ${uploadError?.message}`)

  const { error: receiptError } = await admin.from('receipts').insert({
    id: receiptId,
    payment_id: payment!.id,
    customer_id: user.id,
    storage_path: storagePath,
  })
  assert.equal(receiptError, null, `seeding receipt for ${label}: ${receiptError?.message}`)

  // A real sign-in, so the client below carries an authenticated JWT.
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  assert.equal(signInError, null, `signing in ${label}: ${signInError?.message}`)

  return { user, client, email, password, paymentId: payment!.id, receiptId, storagePath }
}

async function destroyCustomer(customer: Customer | undefined): Promise<void> {
  if (!customer) return
  await admin.storage.from('receipts').remove([customer.storagePath])
  // payments and receipts cascade from customers, which cascades from auth.users.
  await admin.auth.admin.deleteUser(customer.user.id)
}

describe('cross-customer isolation', () => {
  let a: Customer
  let b: Customer

  before(async () => {
    a = await createCustomer('a')
    b = await createCustomer('b')
  })

  after(async () => {
    await destroyCustomer(a)
    await destroyCustomer(b)
  })

  it('returns only the caller\'s payments to an unfiltered select', async () => {
    const { data, error } = await a.client.from('payments').select('id, customer_id')
    assert.equal(error, null)
    assert.equal(data!.length, 1, 'customer A should see exactly their own payment')
    assert.equal(data![0]!.customer_id, a.user.id)
  })

  it('hides another customer\'s payment even when asked for it by id', async () => {
    const { data, error } = await a.client
      .from('payments')
      .select('id')
      .eq('id', b.paymentId)
    assert.equal(error, null, 'the policy should return no rows, not an error')
    assert.deepEqual(data, [], 'customer A must not read customer B\'s payment')
  })

  it('hides another customer\'s receipt row', async () => {
    const { data, error } = await a.client.from('receipts').select('id, storage_path')
    assert.equal(error, null)
    assert.equal(data!.length, 1)
    assert.equal(data![0]!.storage_path, a.storagePath)
  })

  it('exposes no customer record but the caller\'s own', async () => {
    const { data, error } = await a.client.from('customers').select('id, email')
    assert.equal(error, null)
    assert.equal(data!.length, 1, 'the customers table must not be a user directory')
    assert.equal(data![0]!.id, a.user.id)
  })

  it('returns nothing at all to an unauthenticated caller', async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    for (const table of ['customers', 'payments', 'receipts'] as const) {
      const { data, error } = await anon.from(table).select('id')
      // No grant and no policy for anon: either shape is a refusal, neither leaks a row.
      assert.equal(data?.length ?? 0, 0, `anon read ${table} rows`)
      if (error) assert.notEqual(error.code, undefined)
    }
  })

  it('refuses every write from a signed-in customer', async () => {
    const insert = await a.client.from('payments').insert({
      customer_id: a.user.id,
      source_payment_id: `pay_forged_${randomUUID()}`,
      amount_cents: 1,
      currency: 'usd',
      description: 'forged',
      status: 'succeeded',
      paid_at: new Date().toISOString(),
    })
    assert.notEqual(insert.error, null, 'a customer must not insert a payment, not even their own')

    const update = await a.client
      .from('payments')
      .update({ amount_cents: 1 })
      .eq('id', a.paymentId)
      .select('id')
    assert.equal(update.data?.length ?? 0, 0, 'a customer must not amend their own ledger')

    const remove = await a.client.from('receipts').delete().eq('id', a.receiptId).select('id')
    assert.equal(remove.data?.length ?? 0, 0, 'a customer must not delete a receipt')
  })

  it('downloads the caller\'s own receipt file', async () => {
    const { data, error } = await a.client.storage.from('receipts').download(a.storagePath)
    assert.equal(error, null, `own download failed: ${error?.message}`)
    const text = await data!.text()
    assert.match(text, /receipt for a/)
  })

  it('refuses to download another customer\'s receipt file', async () => {
    const { data, error } = await a.client.storage.from('receipts').download(b.storagePath)
    assert.equal(data, null, 'customer A must not download customer B\'s receipt')
    assert.notEqual(error, null)
  })

  it('refuses to mint a signed URL for another customer\'s receipt file', async () => {
    // The dangerous direction: a signed URL, once issued, needs no session to redeem.
    const { data, error } = await a.client.storage
      .from('receipts')
      .createSignedUrl(b.storagePath, 60)
    assert.equal(data, null, 'customer A must not mint a signed URL over customer B\'s file')
    assert.notEqual(error, null)
  })

  it('does not list another customer\'s objects', async () => {
    const { data, error } = await a.client.storage.from('receipts').list(b.user.id)
    assert.equal(error, null, 'listing a foreign prefix should be empty, not an error')
    assert.deepEqual(data, [], 'the bucket must not disclose another customer\'s filenames')
  })
})
