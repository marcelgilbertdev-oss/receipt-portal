import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

interface PaymentRow {
  id: string
  amount_cents: number
  currency: string
  description: string
  status: string
  paid_at: string
  receipts: { id: string; storage_path: string }[]
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing element #${id}`)
  return node as T
}

const signInSection = el('sign-in')
const signInForm = el<HTMLFormElement>('sign-in-form')
const emailInput = el<HTMLInputElement>('email')
const signOutButton = el<HTMLButtonElement>('sign-out')
const paymentsSection = el('payments')
const paymentsBody = el<HTMLTableSectionElement>('payments-body')
const paymentsEmpty = el('payments-empty')
const status = el('status')

function say(message: string, tone: 'info' | 'error' = 'info'): void {
  status.textContent = message
  status.classList.toggle('error', tone === 'error')
  status.hidden = message === ''
}

function money(amountCents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountCents / 100)
}

function day(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso))
}

/**
 * Receipts are downloaded through a signed URL rather than a public one. The URL is
 * minted only if the storage policy admits the caller, and it expires — so a link
 * copied out of the address bar stops working rather than becoming a permanent,
 * unauthenticated door onto someone's receipt.
 */
async function downloadReceipt(storagePath: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  say('')
  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(storagePath, 60, { download: true })
  button.disabled = false

  if (error || !data) {
    say(`That receipt could not be opened: ${error?.message ?? 'unknown error'}`, 'error')
    return
  }
  window.open(data.signedUrl, '_blank', 'noopener')
}

function renderPayments(payments: PaymentRow[]): void {
  paymentsBody.replaceChildren()

  for (const payment of payments) {
    const row = document.createElement('tr')

    const date = document.createElement('td')
    date.textContent = day(payment.paid_at)

    const description = document.createElement('td')
    description.textContent = payment.description

    const amount = document.createElement('td')
    amount.className = 'numeric'
    amount.textContent = money(payment.amount_cents, payment.currency)

    const state = document.createElement('td')
    const badge = document.createElement('span')
    badge.className = `badge badge--${payment.status}`
    badge.textContent = payment.status
    state.append(badge)

    const receipt = document.createElement('td')
    const [first] = payment.receipts
    if (first) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ghost'
      button.textContent = 'Download'
      // The description is in the accessible name so a screen reader user is not
      // handed a column of identical "Download" buttons.
      button.setAttribute('aria-label', `Download the receipt for ${payment.description}`)
      button.addEventListener('click', () => void downloadReceipt(first.storage_path, button))
      receipt.append(button)
    } else {
      receipt.textContent = '—'
    }

    row.append(date, description, amount, state, receipt)
    paymentsBody.append(row)
  }

  paymentsEmpty.hidden = payments.length > 0
  paymentsSection.setAttribute('aria-busy', 'false')
}

/**
 * No `.eq('customer_id', …)` anywhere in this query, deliberately. The portal does
 * not filter to the signed-in customer; the database refuses to return anyone else's
 * rows. If this select ever returned a stranger's payment, the bug would be in the
 * policies — which is where a rule about who may see what belongs.
 */
async function loadPayments(): Promise<void> {
  paymentsSection.setAttribute('aria-busy', 'true')
  const { data, error } = await supabase
    .from('payments')
    .select('id, amount_cents, currency, description, status, paid_at, receipts(id, storage_path)')
    .order('paid_at', { ascending: false })

  if (error) {
    say(`Your payments could not be loaded: ${error.message}`, 'error')
    paymentsSection.setAttribute('aria-busy', 'false')
    return
  }
  renderPayments((data ?? []) as PaymentRow[])
}

function showSignedIn(session: Session): void {
  signInSection.hidden = true
  paymentsSection.hidden = false
  signOutButton.hidden = false
  say(`Signed in as ${session.user.email ?? 'your account'}.`)
  void loadPayments()
}

function showSignedOut(): void {
  signInSection.hidden = false
  paymentsSection.hidden = true
  signOutButton.hidden = true
  paymentsBody.replaceChildren()
}

signInForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const email = emailInput.value.trim()
  if (!email) {
    say('Enter the email address your receipts are under.', 'error')
    return
  }

  const submit = signInForm.querySelector('button[type="submit"]') as HTMLButtonElement
  submit.disabled = true
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin, shouldCreateUser: true },
  })
  submit.disabled = false

  // One message whether or not that mailbox has an account. A portal that says
  // "no such customer" answers a question no visitor should be able to ask it.
  say(
    error
      ? `That link could not be sent right now: ${error.message}`
      : 'If that address has an account, a sign-in link is on its way. It is good for one use.',
    error ? 'error' : 'info',
  )
})

signOutButton.addEventListener('click', async () => {
  await supabase.auth.signOut()
  say('Signed out.')
})

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) showSignedIn(session)
  else showSignedOut()
})

const { data: initial } = await supabase.auth.getSession()
if (initial.session) showSignedIn(initial.session)
else showSignedOut()
