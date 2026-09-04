/**
 * Seed a demo customer so the portal has something to show.
 *
 * Usage:  DEMO_EMAIL=you@example.com npm run seed
 *
 * What it does, with the service role (which bypasses RLS — this is server-side setup,
 * never portal code):
 *   1. creates a confirmed user for DEMO_EMAIL if one does not exist (the database trigger
 *      provisions the customers row);
 *   2. pulls the live sandbox payments from the fintech API and attributes the most recent
 *      few to that customer — the sandbox has one shared demo payer, so this is how a
 *      fresh mailbox gets a history to look at;
 *   3. writes a small PDF receipt into the private bucket for each, under the customer's
 *      own prefix, and files the receipt row.
 *
 * Re-running is safe: users are looked up before creation, payments upsert on the
 * upstream id, and objects upload with upsert.
 */

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const need = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

const SUPABASE_URL = need('VITE_SUPABASE_URL')
const SERVICE_ROLE_KEY = need('SUPABASE_SERVICE_ROLE_KEY')
const FINTECH_API_URL = need('FINTECH_API_URL')
const DEMO_EMAIL = need('DEMO_EMAIL').trim().toLowerCase()
const HOW_MANY = Number(process.env.DEMO_PAYMENTS ?? 6)

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface UpstreamPayment {
  id: string
  amountMinor: number
  currency: string
  status: string
  description: string | null
  methodLabel: string
  createdAt: string
}

/** A minimal but valid single-page PDF with one line of text. No library needed. */
function tinyPdf(lines: string[]): Buffer {
  const escaped = lines.map((l) => l.replace(/[\\()]/g, (c) => `\\${c}`))
  const content =
    'BT /F1 12 Tf 50 750 Td 16 TL ' +
    escaped.map((l, i) => `${i ? 'T* ' : ''}(${l}) Tj`).join(' ') +
    ' ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'binary')
}

async function ensureUser(email: string): Promise<string> {
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (listError) throw listError
  const existing = list.users.find((u) => u.email?.toLowerCase() === email)
  if (existing) return existing.id

  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true })
  if (error) throw error
  return data.user.id
}

async function main(): Promise<void> {
  const customerId = await ensureUser(DEMO_EMAIL)
  console.log(`customer ${DEMO_EMAIL} -> ${customerId}`)

  const res = await fetch(`${FINTECH_API_URL}/api/v1/payments?limit=${HOW_MANY}&offset=0`)
  if (!res.ok) throw new Error(`fintech API returned ${res.status}`)
  const { data: upstream } = (await res.json()) as { data: UpstreamPayment[] }

  for (const p of upstream) {
    const { data: payment, error: payError } = await admin
      .from('payments')
      .upsert(
        {
          customer_id: customerId,
          source_payment_id: p.id,
          amount_cents: p.amountMinor,
          currency: p.currency.toLowerCase(),
          description: p.description ?? p.methodLabel,
          status: p.status,
          paid_at: p.createdAt,
        },
        { onConflict: 'source_payment_id' },
      )
      .select('id')
      .single()
    if (payError) throw payError

    const { data: existingReceipt } = await admin
      .from('receipts')
      .select('id')
      .eq('payment_id', payment.id)
      .maybeSingle()
    if (existingReceipt) continue

    const receiptId = randomUUID()
    const storagePath = `${customerId}/${receiptId}.pdf`
    const pdf = tinyPdf([
      'ZEROFAYYZ FINTECH — receipt (sandbox)',
      `Payment ${p.id}`,
      `${(p.amountMinor / 100).toFixed(2)} ${p.currency.toUpperCase()} — ${p.status}`,
      `${p.description ?? p.methodLabel}`,
      `Paid ${p.createdAt}`,
      'No real funds moved. Stripe test mode.',
    ])

    const { error: upError } = await admin.storage
      .from('receipts')
      .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true })
    if (upError) throw upError

    const { error: rcptError } = await admin.from('receipts').insert({
      id: receiptId,
      payment_id: payment.id,
      customer_id: customerId,
      storage_path: storagePath,
    })
    if (rcptError) throw rcptError
    console.log(`  receipt ${storagePath}`)
  }
  console.log(`seeded ${upstream.length} payments for ${DEMO_EMAIL}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
